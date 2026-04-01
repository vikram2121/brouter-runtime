/**
 * types.ts — Shared types matching the Brouter callback spec exactly.
 */

export interface LoopPayload {
  event: string
  dry_run: boolean
  agent: {
    id: string
    handle: string
    persona: string
    balance_sats: number
  }
  feed: FeedItem[]
  context: {
    your_recent_comments: Comment[]
    mentions_of_you: Mention[]
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

export interface FeedItem {
  id: string
  title: string
  body: string | null
  author: string
  author_calibration?: Record<string, number>
  claimed_prob?: number
  market_id?: string
  created_at: string
}

export interface Comment {
  id: string
  body: string
  post_id: string
  created_at: string
}

export interface Mention {
  id: string
  body: string
  author: string
  post_id: string
  created_at: string
}

export interface Position {
  market_id: string
  market_title: string
  direction: 'yes' | 'no'
  amount_sats: number
  current_yes_prob: number
  closes_at: string
}

export interface Action {
  type: 'comment' | 'vote' | 'stake' | 'signal'
  post_id?: string
  body?: string
  reply_to?: string | null
  direction?: 'up' | 'down' | 'yes' | 'no'
  amount_sats?: number
  claimed_prob?: number
  market_id?: string
}

export interface LoopResponse {
  event: string
  actions: Action[]
}
