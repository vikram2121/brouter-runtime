/**
 * ComputeExecutor — Durable Object for autonomous task execution
 *
 * Lifecycle:
 * 1. Worker books a listing → spawns DO with (agentId, bookingId, task, model)
 * 2. DO fetches booking details
 * 3. DO executes task via Workers AI
 * 4. DO submits proof to Brouter API
 * 5. DO tracks status until settlement
 *
 * State persists across restarts — can resume if execution fails.
 */

export interface ExecutionRequest {
  agentId: string
  bookingId: string
  task: string
  model?: string
  maxTokens?: number
  agentToken?: string  // per-agent JWT for Brouter API calls
}

export interface ExecutionState {
  agentId: string
  bookingId: string
  task: string
  model: string
  status: 'pending' | 'executing' | 'proof_submitted' | 'settled' | 'failed'
  result?: string
  proofTxid?: string
  error?: string
  startedAt?: string
  completedAt?: string
}

export class ComputeExecutor implements DurableObject {
  state: DurableObjectState
  env: any
  executionState: ExecutionState

  constructor(state: DurableObjectState, env: any) {
    this.state = state
    this.env = env
    this.executionState = {
      agentId: '',
      bookingId: '',
      task: '',
      model: '',
      status: 'pending',
    }
  }

  async initialize(req: ExecutionRequest) {
    this.executionState = {
      agentId: req.agentId,
      bookingId: req.bookingId,
      task: req.task,
      model: req.model || '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      status: 'pending',
      startedAt: new Date().toISOString(),
    }
    await this.state.storage.put('execution', this.executionState)
    if (req.agentToken) await this.state.storage.put('agentToken', req.agentToken)
  }

  async executeTask(): Promise<void> {
    if (!this.executionState) return

    try {
      // Load from storage in case of restart
      const stored = await this.state.storage.get('execution') as ExecutionState | undefined
      if (stored) this.executionState = stored

      if (this.executionState.status !== 'pending' && this.executionState.status !== 'executing') {
        console.log(`[DO][${this.executionState.bookingId}] Already ${this.executionState.status}`)
        return
      }

      this.executionState.status = 'executing'
      await this.state.storage.put('execution', this.executionState)

      // Fetch booking to get renter token (if needed for proof submission)
      const apiBase = this.env.BROUTER_API_BASE ?? 'https://brouter.ai/api'
      // Use per-agent token stored at init, fall back to env token
      const agentToken = (await this.state.storage.get('agentToken') as string | undefined) || this.env.BROUTER_AGENT_TOKEN || ''

      const bookingRes = await fetch(`${apiBase}/compute/bookings/${this.executionState.bookingId}`, {
        headers: { Authorization: `Bearer ${agentToken}` },
      })
      if (!bookingRes.ok) {
        throw new Error(`Failed to fetch booking: ${bookingRes.status}`)
      }
      const bookingData = await bookingRes.json() as any
      const booking = bookingData?.data?.booking
      if (!booking) throw new Error('Invalid booking response')

      // Execute task via Workers AI
      console.log(`[DO][${this.executionState.bookingId}] Executing via ${this.executionState.model}`)
      const aiResult = await this.env.AI.run(this.executionState.model, {
        messages: [
          {
            role: 'system',
            content: 'You are a specialist compute agent on the Brouter Compute Exchange. Provide concise, high-quality responses optimized for real-world use. You are being paid per request in BSV sats.',
          },
          { role: 'user', content: this.executionState.task },
        ],
        max_tokens: 2048,
        temperature: 0.3,
      })
      const resultText = aiResult.response || ''
      if (this.executionState) {
        this.executionState.result = resultText
        console.log(`[DO][${this.executionState.bookingId}] Execution done — ${resultText.length} chars`)
      }

      // Submit proof
      await this.submitProof(apiBase, agentToken)
    } catch (err: any) {
      this.executionState.status = 'failed'
      this.executionState.error = err.message
      this.executionState.completedAt = new Date().toISOString()
      await this.state.storage.put('execution', this.executionState)
      console.error(`[DO][${this.executionState.bookingId}] Error:`, err.message)
    }
  }

  private async submitProof(apiBase: string, agentToken: string): Promise<void> {
    if (!this.executionState.result) {
      throw new Error('No result to submit')
    }

    console.log(`[DO][${this.executionState.bookingId}] Submitting proof...`)

    const proofRes = await fetch(
      `${apiBase}/compute/bookings/${this.executionState.bookingId}/proof`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${agentToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          proof_txid: 'pending', // Will be filled by Brouter after BSV broadcast
          proof_data: this.executionState.result,
        }),
      }
    )

    if (!proofRes.ok) {
      const errText = await proofRes.text()
      throw new Error(`Proof submission failed: ${proofRes.status} ${errText}`)
    }

    const proofData = await proofRes.json() as any
    if (this.executionState) {
      this.executionState.proofTxid = proofData?.data?.proof_txid || 'pending'
      this.executionState.status = 'proof_submitted'
    }
    this.executionState.completedAt = new Date().toISOString()
    await this.state.storage.put('execution', this.executionState)

    console.log(`[DO][${this.executionState.bookingId}] Proof submitted — txid: ${this.executionState.proofTxid}`)
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)

    // GET /status — check execution status
    if (req.method === 'GET' && url.pathname === '/status') {
      const stored = await this.state.storage.get('execution') as ExecutionState | undefined
      return Response.json({ execution: stored || this.executionState })
    }

    // POST / — initialize and start execution
    if (req.method === 'POST' && url.pathname === '/') {
      const body = await req.json() as ExecutionRequest
      await this.initialize(body)
      await this.executeTask()
      return Response.json({ bookingId: body.bookingId, status: this.executionState.status })
    }

    return new Response('Not found', { status: 404 })
  }
}
