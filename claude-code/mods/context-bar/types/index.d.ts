export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number

export type Slice = { name: string; tokens: number; color: string; kind: 'used' | 'free' | 'buffer' }

export type Reading = {
  slices: Slice[]
  total: number // tokens in use
  window: number // the window measured against
  percent: number
  compactsAt?: number // where auto-compaction runs, when it is on
}

// What `git status` reports of the working tree: files staged, changed and
// untracked, and how many commits the branch leads its upstream by.
export type Changes = { staged: number; unstaged: number; untracked: number; ahead: number }

declare module 'claude-code' {
  interface PluginState {
    'context-bar': {
      reading: Reading | null
      isHidden: boolean
      model: string | null
      effort: Effort | null
      cwd: string | null
      branch: string | null
      changes: Changes | null
    }
  }
}
