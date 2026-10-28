// The agents view: one card per subagent of the session, and the words for its line in the band.
import type { AgentCard } from '../types'

const SHOW_DONE_MS = 30_000 // a finished agent stays in the band this long

// Running, or finished in the last 30 s.
export function isShown(a: AgentCard, at = Date.now()) {
  return a.status === 'running' || (a.endedAt !== undefined && at - a.endedAt < SHOW_DONE_MS)
}

// Whitespace runs as one space, the ends trimmed.
export function oneLine(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

// The list in rows of `size`.
export function chunk<T>(list: T[], size: number): T[][] {
  const rows: T[][] = []
  for (let i = 0; i < list.length; i += size) rows.push(list.slice(i, i + size))
  return rows
}

export function agentIcon(a: AgentCard) {
  return a.status === 'running' ? '●' : a.status === 'done' ? '✓' : '✗'
}

export function agentColor(a: AgentCard) {
  return a.status === 'running' ? 'yellow' : a.status === 'done' ? 'green' : 'red'
}

export function elapsed(a: Pick<AgentCard, 'startedAt' | 'endedAt'>, at = Date.now()) {
  const s = Math.max(0, Math.round(((a.endedAt ?? at) - a.startedAt) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

// How many terminal cells a character takes: two for the wide scripts (CJK,
// Hangul, full-width forms, most emoji), one for the rest.
export function cells(ch: string): number {
  const c = ch.codePointAt(0) ?? 0
  const wide =
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1faff) ||
    (c >= 0x20000 && c <= 0x3fffd)
  return wide ? 2 : 1
}

// The text cut into lines of at most `width` cells, at a space where one is
// near, so each line is exactly one row and a view can count its rows.
export function wrapCells(text: string, width: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    let used = 0
    let lastSpace = -1 // index in `line` of its last space
    for (const ch of para) {
      const w = cells(ch)
      if (used + w > width) {
        if (lastSpace > width / 2) {
          out.push(line.slice(0, lastSpace))
          line = line.slice(lastSpace + 1)
        } else {
          out.push(line)
          line = ''
        }
        used = [...line].reduce((n, x) => n + cells(x), 0)
        lastSpace = -1
      }
      if (ch === ' ') lastSpace = line.length
      line += ch
      used += w
    }
    out.push(line)
  }
  return out
}

// A short label for one tool call: what a person would say the agent is doing.
export function doingOf(e: Record<string, unknown>): string {
  const tool = String(e.tool)
  const s = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : '')
  const file = (p: string) => p.split('/').slice(-2).join('/')
  if (tool === 'Bash') return `running ${s('description') || s('command').slice(0, 50)}`
  if (tool === 'Edit' || tool === 'Write') return `editing ${file(s('file_path'))}`
  if (tool === 'Read') return `reading ${file(s('file_path'))}`
  if (tool === 'Grep' || tool === 'Glob') return `searching ${s('pattern').slice(0, 30)}`
  if (tool.includes('playwright')) return `browser: ${tool.split('__').pop()?.replace(/^browser_/, '')}`
  if (tool.startsWith('mcp__')) return `using ${tool.split('__').slice(1).join(' ')}`
  return `using ${tool}`
}
