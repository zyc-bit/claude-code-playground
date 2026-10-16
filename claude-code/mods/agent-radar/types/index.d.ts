// What the crab at the pane's foot is doing: mission-control's scene, which this mod only reads.
export type Activity =
  | 'idle'
  | 'thinking'
  | 'reading'
  | 'coding'
  | 'writing'
  | 'designing'
  | 'terminal'
  | 'searching'
  | 'web'
  | 'delegating'
  | 'talking'
  | 'asking'
  | 'planning'
  | 'tool'
  | 'done'
  | 'permission'
  | 'compacting'
  | 'error'
  | 'waiting'
  | 'testing'
  | 'git'
  | 'installing'
  | 'skill'
  | 'memory'
  | 'sharing'

export type Scene = { activity: Activity; detail: string }

export type RadarAgent = {
  id: string
  description: string
  type: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  tools: number
  last: string
  said?: string // the latest text its model answered, on one line
}

declare module 'claude-code' {
  interface PluginState {
    'agent-radar': {
      agents: RadarAgent[]
      selected: string | null
      now: number
      notice: string | null
      crabTick: number
      gridPage: number // the page of the card grid, newest first, the pane's foot kept for the crab
      agentPage: number // the page of an agent's messages, newest last
    }
  }
}
