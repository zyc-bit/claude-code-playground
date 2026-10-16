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

declare module 'claude-code' {
  interface PluginState {
    'mission-control': {
      nodes: MissionNode[]
      files: MapFile[]
      view: 'who' | 'code'
      frame: MissionFrame
      turn: number
      now: number
      scene: Scene // what the crab is acting out
      crabTick: number // the animation tick the crab's prop is on
      isCrabHidden: boolean
    }
  }
}
