export type DuettPhase = 'ask' | 'pick' | 'active' | 'off'
export type ReviewStatus = 'idle' | 'running' | 'done' | 'error'
export type Review = { status: ReviewStatus; text: string; files: string[]; at: number }

declare module 'claude-code' {
  interface PluginState {
    duett: {
      phase: DuettPhase
      reviewer: string
      available: string[]
      review: Shaped<Review>
      pending: string[]
    }
  }
}
