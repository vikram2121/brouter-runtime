/**
 * brouter-runtime — Cloudflare Worker
 *
 * Single shared runtime for all Brouter agents.
 * Routes by agentId/persona, calls Workers AI (Llama 3.3 70B),
 * returns { event, actions } within Brouter's 5s dispatch timeout.
 *
 * Deploy: wrangler deploy
 * Env vars: BROUTER_CALLBACK_SECRET
 * KV binding: RATE_LIMIT_KV (optional)
 */

export interface Env {
  BROUTER_CALLBACK_SECRET: string
  AI: any
  RATE_LIMIT_KV?: KVNamespace
  LLM_MODEL?: string       // override via env var — no redeploy needed to switch models
  BROUTER_AGENT_TOKEN?: string  // openclaw JWT for Brouter API calls
  BROUTER_API_BASE?: string     // defaults to https://brouter.ai/api
}

// ====================== TYPES ======================

interface LoopPayload {
  event: string
  dry_run: boolean
  agent: {
    id: string
    handle: string
    persona: string
    balance_sats: number
  }
  feed: FeedItem[]
  open_markets?: OpenMarket[]
  context: {
    your_recent_comments: any[]
    mentions_of_you: any[]
    your_open_positions: Position[]
    your_calibration: Record<string, number>
  }
  action_costs: {
    comment: number
    vote: number
  }
  timestamp: string
  signature: string
}

interface FeedItem {
  id: string
  title: string
  body: string | null
  author: string
  author_calibration?: Record<string, number>
  claimed_prob?: number
  market_id?: string
  created_at: string
}

interface OpenMarket {
  id: string
  title: string
  description?: string
  domain?: string
  resolves_at?: string
}

interface Position {
  market_id: string
  market_title: string
  direction: 'yes' | 'no'
  amount_sats: number
  current_yes_prob: number
  closes_at: string
}

interface Action {
  type: 'comment' | 'vote' | 'stake' | 'signal'
  post_id?: string
  market_id?: string
  body?: string
  reply_to?: string | null
  direction?: 'up' | 'down' | 'yes' | 'no'
  amount_sats?: number
  claimed_prob?: number
}

// ====================== CONFIG ======================

// Real agent IDs — only these can call the runtime
const ALLOWED_AGENTS = new Set<string>([
  's9-hFi-mHfEfd-Z-Rf-kd',   // openclaw
  '9-K1PiLlcUetIQWE02lKx',   // Vortex
  '9qJSizS_DV-pRiOHLQVSd',   // priors
  'MrrMN66sLnyf24NtrNEKF',   // T1000
  'FYMWgJgVf8gWc_whvIt9u',   // Arbitrageur
  'sf6u5P0tb1PowgIidqGYX',   // MarketMaker
  'y3AS9PZ6c8mqwjRFr-FyX',   // Broker
  'wdTshJGcFlZBWUD_h-hA4',   // Mentor
  'PrY0KcewE7qRa1Zkxq9o0',   // CoalitionBuilder
  'qoppA87gDDf50Gdu85Zmm',   // Auditor
  '3s6OlxvZAF-IvDXS90KHP',   // Innovator
])

// LLM model — override via LLM_MODEL env var without redeploying
// Switch to @cf/meta/llama-3.1-8b-instruct-fp8-fast when hitting free tier limits at scale
const DEFAULT_LLM_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'

// Max calls per agent per day
// Free tier ceiling: ~250 agents at 6 calls/day. Raise limit or switch model when scaling.
const MAX_CALLS_PER_DAY = 6

// ====================== RATE LIMITING ======================

async function isRateLimited(agentId: string, env: Env): Promise<boolean> {
  if (!env.RATE_LIMIT_KV) return false
  const today = new Date().toISOString().split('T')[0]
  const key = `rate:${agentId}:${today}`
  const countStr = (await env.RATE_LIMIT_KV.get(key)) || '0'
  const count = parseInt(countStr, 10)
  if (count >= MAX_CALLS_PER_DAY) return true
  await env.RATE_LIMIT_KV.put(key, (count + 1).toString(), { expirationTtl: 86400 })
  return false
}

// ====================== HMAC VERIFICATION ======================

async function verifySignature(rawBody: string, signature: string, secret: string): Promise<boolean> {
  if (!signature?.startsWith('sha256=')) return false
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    const hmac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody))
    const expected = 'sha256=' + Array.from(new Uint8Array(hmac))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
    // Constant-time comparison
    if (signature.length !== expected.length) return false
    let diff = 0
    for (let i = 0; i < signature.length; i++) {
      diff |= signature.charCodeAt(i) ^ expected.charCodeAt(i)
    }
    return diff === 0
  } catch {
    return false
  }
}

// ====================== PROMPTS ======================

function buildSystemPrompt(persona: string, agentHandle: string): string {
  const personas: Record<string, string> = {
    researcher: `You are ${agentHandle}, a specialist AI agent on Brouter — an agent-native prediction market on Bitcoin. Your strategy is deep domain research. You focus on macro economics and tech markets where you have genuine analytical edge. You stake conservatively but with high conviction. You post signals with detailed reasoning. You only comment when you have something substantive to add.`,

    trader: `You are ${agentHandle}, a profit-driven AI agent on Brouter. Your strategy is alpha hunting — finding mispriced markets and staking with conviction. You move fast when you see edge. You upvote signals that align with your positions and downvote ones that contradict them. You are direct and concise in your comments.`,

    arbitrageur: `You are ${agentHandle}, an arbitrageur AI agent on Brouter. Your strategy is detecting mispricings — markets where the Brouter consensus diverges from Polymarket implied probability. When you find edge > 10%, you stake. You post signals explaining the arbitrage. You vote on signals based on analytical quality, not direction.`,

    diplomat: `You are ${agentHandle}, a relationship-building AI agent on Brouter. Your strategy is coalition formation — identifying agents with complementary calibration strengths and building trust over time. You comment thoughtfully on signals to establish credibility. You stake on markets where trusted agents have already taken positions.`,

    market_maker: `You are ${agentHandle}, a market maker AI agent on Brouter. Your strategy is maintaining continuous two-sided markets — taking both YES and NO positions to earn the spread. You prioritise liquidity provision over directional bets. You comment on thin markets to attract other agents.`,

    broker: `You are ${agentHandle}, a broker AI agent on Brouter. Your strategy is facilitating trades between agents — identifying agents with opposite views on a market and connecting them. You earn by being the first to spot coordination opportunities. You post signals that frame the two sides of a debate clearly.`,

    mentor: `You are ${agentHandle}, a mentor AI agent on Brouter. Your strategy is sharing high-calibration insights — posting well-reasoned signals that help other agents improve their calibration. You focus on markets where you have strong historical accuracy. You comment to correct poor reasoning.`,

    coalition_builder: `You are ${agentHandle}, a coalition builder AI agent on Brouter. When a market has budget > 1000 sats or multiple agents have staked, you organise group positions. You post signals proposing coordinated stakes. You comment to build consensus before markets close.`,

    auditor: `You are ${agentHandle}, an auditor AI agent on Brouter. Your strategy is hunting overconfident agents — finding signals where claimed probability diverges sharply from your own analysis. You stake against overconfident positions. You comment with calibration critiques backed by historical data.`,

    innovator: `You are ${agentHandle}, an innovator AI agent on Brouter. Every loop cycle you identify an underexplored market angle no other agent has posted about. You post novel signals with unconventional reasoning. You vote up creative thinking even when you disagree with the conclusion.`,

    default: `You are ${agentHandle}, an AI agent on Brouter — an agent-native prediction market on Bitcoin. You stake on binary outcomes, post signals with reasoning, and build calibration scores over time. Act rationally based on your analysis of the feed.`,
  }

  // Map freeform persona text to a known key if possible
  const key = Object.keys(personas).find(k => persona.toLowerCase().includes(k)) ?? 'default'
  return personas[key]
}

function buildUserMessage(payload: LoopPayload): string {
  const { feed, context, action_costs, agent } = payload

  const positionContext = context.your_open_positions.length > 0
    ? `\nYour open positions:\n${context.your_open_positions.map(p =>
        ` - ${p.market_title}: ${p.direction.toUpperCase()} ${p.amount_sats} sats (current odds: ${(p.current_yes_prob * 100).toFixed(0)}% YES, closes ${p.closes_at})`
      ).join('\n')}`
    : '\nNo open positions.'

  const calibrationContext = Object.keys(context.your_calibration).length > 0
    ? `\nYour calibration scores: ${Object.entries(context.your_calibration).map(([d, s]) => `${d}: ${s.toFixed(2)}`).join(', ')}`
    : '\nNo calibration scores yet.'

  const feedContext = feed.length > 0
    ? `\nCurrent feed (${feed.length} items):\n${feed.slice(0, 10).map(f =>
        ` [${f.id}] "${f.title}" by ${f.author}` +
        (f.claimed_prob ? ` — claimed prob: ${(f.claimed_prob * 100).toFixed(0)}%` : '') +
        (f.author_calibration ? ` — author calibration: ${JSON.stringify(f.author_calibration)}` : '')
      ).join('\n')}`
    : '\nFeed is empty — no signals from other agents yet.'

  const mentionsContext = context.mentions_of_you?.length > 0
    ? `\nMentions of you:\n${context.mentions_of_you.slice(0, 5).map((m: any) => ` - ${JSON.stringify(m)}`).join('\n')}`
    : ''

  const openMarketsContext = payload.open_markets && payload.open_markets.length > 0
    ? `\nOpen markets you can stake on or post signals about:\n${payload.open_markets.slice(0, 5).map(m =>
        ` [${m.id}] "${m.title}"` +
        (m.domain ? ` (${m.domain})` : '') +
        (m.resolves_at ? ` — resolves ${m.resolves_at}` : '')
      ).join('\n')}`
    : ''

  const proactiveInstruction = feed.length === 0
    ? `\nIMPORTANT: The feed is empty. You must take at least one proactive action — post a signal on an open market, stake on a position you have conviction on, or post a job for another agent. Do NOT return empty actions.`
    : `\nIf you have a strong view, take action. Otherwise return empty actions.`

  return `You have ${agent.balance_sats} sats available.
Action costs: comment = ${action_costs.comment} sats, vote = ${action_costs.vote} sats.
Maximum 3 actions per loop.
${calibrationContext}
${positionContext}
${feedContext}
${mentionsContext}
${openMarketsContext}
${proactiveInstruction}

Return a JSON object with this EXACT structure:
{
  "reasoning": "brief explanation of your decision",
  "actions": [
    { "type": "comment", "post_id": "feed item id", "body": "your comment (max 280 chars)", "reply_to": null }
  ]
}

Valid action types:
- comment: { type, post_id, body (max 280 chars), reply_to (null or comment id) }
- vote: { type, post_id, direction ("up"|"down"), amount_sats (min 25) }
- stake: { type, market_id, direction ("yes"|"no"), amount_sats (min 100) }
- signal: { type, post_id, direction ("yes"|"no"), claimed_prob (0.0–1.0), body (max 280 chars) }

Only return valid JSON. No markdown, no explanation outside the JSON.`
}

// ====================== VALIDATION ======================

function validateAction(action: Action, payload: LoopPayload): boolean {
  const { action_costs, agent } = payload
  if (!['comment', 'vote', 'stake', 'signal'].includes(action.type)) return false

  if (action.type === 'comment') {
    if (!action.post_id || !action.body || action.body.length > 280) return false
    if (agent.balance_sats < action_costs.comment) return false
  }
  if (action.type === 'vote') {
    if (!action.post_id || !['up', 'down'].includes(action.direction ?? '')) return false
    if (!action.amount_sats || action.amount_sats < 25) return false
    if (agent.balance_sats < action.amount_sats) return false
  }
  if (action.type === 'stake') {
    if (!action.market_id || !['yes', 'no'].includes(action.direction ?? '')) return false
    if (!action.amount_sats || action.amount_sats < 100) return false
    if (agent.balance_sats < action.amount_sats) return false
  }
  if (action.type === 'signal') {
    if (!action.post_id || !['yes', 'no'].includes(action.direction ?? '')) return false
    if (typeof action.claimed_prob !== 'number' || action.claimed_prob < 0 || action.claimed_prob > 1) return false
    if (!action.body || action.body.length > 280) return false
  }
  return true
}

// ====================== COMPUTE HANDLER ======================

interface ComputeRequest {
  bookingId: string
  task: string
  system?: string
  model?: string
  maxTokens?: number
}

async function handleComputeRequest(request: Request, env: Env): Promise<Response> {
  const apiBase = env.BROUTER_API_BASE ?? 'https://brouter.ai/api'

  const auth = request.headers.get('Authorization') || ''
  if (!auth.startsWith('Bearer ')) {
    return Response.json({ error: 'Missing Authorization header' }, { status: 401 })
  }
  const renterToken = auth.slice(7)

  let body: ComputeRequest
  try {
    body = await request.json() as ComputeRequest
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const { bookingId, task, system, model, maxTokens } = body
  if (!bookingId || !task) {
    return Response.json({ error: 'bookingId and task are required' }, { status: 400 })
  }

  // Verify booking is active and renter has access
  const bookingRes = await fetch(`${apiBase}/compute/bookings/${bookingId}`, {
    headers: { Authorization: `Bearer ${renterToken}` },
  })
  if (!bookingRes.ok) {
    return Response.json({ error: 'Booking not found or access denied' }, { status: 404 })
  }
  const bookingData = await bookingRes.json() as any
  const booking = bookingData?.data?.booking
  if (!booking) return Response.json({ error: 'Invalid booking response' }, { status: 500 })
  if (booking.status !== 'active') {
    return Response.json({ error: `Booking not active (status: ${booking.status})`, status: booking.status }, { status: 409 })
  }

  // Run through Workers AI
  const llmModel = model ?? env.LLM_MODEL ?? DEFAULT_LLM_MODEL
  const systemPrompt = system ?? `You are a specialist AI inference agent on the Brouter Compute Exchange. Provide concise, high-quality responses. You are being paid per request in BSV sats — deliver value.`

  let result: string
  try {
    console.log(`[compute][${bookingId}] running via ${llmModel}`)
    const aiResult = await env.AI.run(llmModel, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: task },
      ],
      max_tokens: maxTokens ?? 2048,
      temperature: 0.3,
    })
    result = aiResult.response || ''
  } catch (err) {
    console.error(`[compute][${bookingId}] AI error:`, err)
    return Response.json({ error: 'Inference failed', details: String(err) }, { status: 500 })
  }

  // Record x402 usage (fire-and-forget, non-fatal)
  if (env.BROUTER_AGENT_TOKEN) {
    fetch(`${apiBase}/compute/bookings/${bookingId}/usage`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.BROUTER_AGENT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).catch(() => {})
  }

  console.log(`[compute][${bookingId}] done — ${result.length} chars`)
  return Response.json({ bookingId, result, model: llmModel })
}

// ====================== MAIN HANDLER ======================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // Health check
    if (request.method === 'GET') {
      return Response.json({
        service: 'brouter-runtime',
        status: 'live',
        version: '1.1.0',
        model: env.LLM_MODEL ?? DEFAULT_LLM_MODEL,
        agents: ALLOWED_AGENTS.size,
        max_calls_per_day: MAX_CALLS_PER_DAY,
        endpoints: {
          'POST /callback': 'Agent loop — receives feed, returns actions',
          'POST /compute': 'Compute Exchange — run inference against an active booking',
        },
      })
    }

    // Compute Exchange
    if (request.method === 'POST' && url.pathname === '/compute') {
      return handleComputeRequest(request, env)
    }

    if (request.method !== 'POST' || url.pathname !== '/callback') {
      return new Response('Not found', { status: 404 })
    }

    const signature = request.headers.get('x-brouter-signature') || ''
    const timestamp  = request.headers.get('x-brouter-timestamp') || ''
    const rawBody    = await request.text()

    let payload: LoopPayload
    try {
      payload = JSON.parse(rawBody)
    } catch {
      return Response.json({ error: 'invalid_json' }, { status: 400 })
    }

    // 1. Signature verification
    if (!(await verifySignature(rawBody, signature, env.BROUTER_CALLBACK_SECRET))) {
      console.warn(`[runtime] Invalid signature from agent ${payload?.agent?.id}`)
      return Response.json({ error: 'invalid_signature' }, { status: 401 })
    }

    // 2. Timestamp freshness — reject replays older than 5 minutes
    const age = Date.now() - Number(timestamp) * 1000
    if (age > 300_000) {
      return Response.json({ error: 'request_expired' }, { status: 401 })
    }

    // 3. Agent allow-list
    const agentId = payload.agent?.id
    if (!agentId || !ALLOWED_AGENTS.has(agentId)) {
      return Response.json({ error: 'agent_not_allowed' }, { status: 403 })
    }

    // 4. Rate limiting
    if (await isRateLimited(agentId, env)) {
      console.log(`[runtime] Rate limit hit for ${payload.agent.handle}`)
      return Response.json({ event: payload.event, actions: [] })
    }

    // 5. Dry run
    if (payload.dry_run) {
      console.log(`[runtime][DRY RUN] ${payload.agent.handle} — feed: ${payload.feed.length} items`)
      return Response.json({ event: payload.event, actions: [] })
    }

    // 6. LLM call
    const systemPrompt = buildSystemPrompt(payload.agent.persona, payload.agent.handle)
    const userMessage  = buildUserMessage(payload)

    let rawResponse: string
    try {
      const model = env.LLM_MODEL ?? DEFAULT_LLM_MODEL
      console.log(`[runtime][${payload.agent.handle}] calling ${model}`)
      const result = await env.AI.run(model, {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userMessage },
        ],
        max_tokens: 1000,
        temperature: 0.7,
      })
      rawResponse = result.response || ''
    } catch (err) {
      console.error(`[runtime] Workers AI error for ${payload.agent.handle}:`, err)
      return Response.json({ event: payload.event, actions: [] })
    }

    // 7. Parse & validate
    let parsed: { reasoning?: string; actions: Action[] }
    try {
      const clean = rawResponse.replace(/```json|```/g, '').trim()
      parsed = JSON.parse(clean)
    } catch {
      console.error(`[runtime] JSON parse failed for ${payload.agent.handle}:`, rawResponse.slice(0, 200))
      return Response.json({ event: payload.event, actions: [] })
    }

    const actions = (parsed.actions ?? [])
      .slice(0, 3)
      .filter((a: Action) => validateAction(a, payload))

    if (parsed.reasoning) {
      console.log(`[runtime][${payload.agent.handle}] ${parsed.reasoning} → ${actions.length} action(s)`)
    }

    return Response.json({ event: payload.event, actions })
  },
}
