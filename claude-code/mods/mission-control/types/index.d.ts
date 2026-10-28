// What the crab is doing, and what it says about it: one activity per kind of
// work, with the call's telling detail beside it (the file, the command).
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

// One box in the "who" tree: the main loop, a subagent, or one tool call.
export type MissionNode = {
  id: string
  parent: string | null
  kind: 'main' | 'agent' | 'tool'
  label: string
  family: string // for tools: 'bash', 'edit', 'read', 'browser', 'mcp:<server>', ...
  status: 'running' | 'done' | 'failed'
  start: number
  end?: number
  doing?: Activity // for agents: the scene of the call they are on now, the crab's helpers line
}

// One file in the code map.
export type MapFile = {
  path: string
  act: 'read' | 'edit' | 'write' | 'search'
  at: number
  changedTurn: number // the turn number it last changed in, 0 if never
  imports: string[] // resolved import targets, extension stripped
  why?: string
}

export type MissionFrame = { file: string; n: number } | null

// One card in the "agents" view: a subagent of the session, kept after it ends.
export type AgentCard = {
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
    'mission-control': {
      nodes: MissionNode[]
      files: MapFile[]
      view: 'who' | 'code' | 'agents'
      frame: MissionFrame
      turn: number
      now: number
      scene: Scene // what the crab is acting out
      crabTick: number // the animation tick the crab's prop is on
      isCrabHidden: boolean
      'tree-scroll': { follow: boolean; off: number } // the who view's window: rows above it, or following the newest
      agents: AgentCard[] // the agents view's cards, the oldest first, the last thirty
      agentPick: string | null // the agent whose page is open, or null for the grid
      agentNotice: string | null // what the last button press on an agent's page came to
      'grid-scroll': { follow: boolean; off: number } // the agents grid's window, in rows of cards
      'agent-scroll': { follow: boolean; off: number } // the open agent's conversation's window, in lines
    }
  }
}
