// Context Bar: what is filling my context window?
//   Above the prompt, the window as one stacked bar, a color per category as /context
//   draws them (system prompt, tools, MCP tools, memory files, skills, messages, free),
//   with a legend of tokens and shares and where auto-compaction runs. It refreshes after
//   each turn. /context-bar shows or hides it, and the choice is kept across sessions.
//   Above the bar, one info row: folder, git branch, model and effort (from the
//   model-effort-band mod). It is read at start, after each turn and after /model, /effort,
//   /clear, /compact, /fast and /cd, and turn.step keeps the model and effort that were really sent.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Effort, Reading, Slice } from '../types'
import { bandsFile, parseOrder, stackBands } from './bands'

const MIN_WIDTH = 20 // narrower than this, the bar is not drawn
const SPLIT = '   '
// /context's theme gives several rows the same grey, so each used row gets its own color, in order.
const PALETTE = ['#7aa2f7', '#7dcfff', '#bb9af7', '#9ece6a', '#e0af68', '#f7768e', '#73daca', '#ff9e64', '#c0caf5']
const MESSAGES = '#d97757' // the row that grows, in the accent color
const FREE = '#808080' // a mid grey thin line reads as empty on dark and light themes alike
const BUFFER = '#808080'
const GLYPH = { used: '█', free: '─', buffer: '░' } as const

// Held by the host, so the bar survives a hot reload of this file.
const reading = atom({ plugin: 'context-bar', key: 'reading' } as const, null as Reading | null)
const isHidden = atom({ plugin: 'context-bar', key: 'isHidden' } as const, false)
// The info row (folder, branch, model, effort), merged in from the model-effort-band mod.
const model = atom({ plugin: 'context-bar', key: 'model' } as const, null as string | null)
const effort = atom({ plugin: 'context-bar', key: 'effort' } as const, null as Effort | null)
const cwd = atom({ plugin: 'context-bar', key: 'cwd' } as const, null as string | null)
const branch = atom({ plugin: 'context-bar', key: 'branch' } as const, null as string | null)

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
// These commands can change the model, effort, folder or branch: read them again once they ran.
const REFRESH_COMMANDS = ['model', 'effort', 'clear', 'compact', 'fast', 'cd']

let bandOrder: Promise<string[]> | undefined // read once per session: restart to apply

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'context-bar', description: 'Show or hide the context window bar above the prompt' }).catch(() => {}) // a name Claude Code already has is refused: start anyway
    const hidden = (await $.store.get('isHidden').catch(() => undefined)) === true
    await update($, isHidden, () => hidden)
    void refresh($).catch(() => {})
    void refreshInfo($).catch(() => {})
    return r
  })

  // Each request the main loop sends: note the model and effort it really used.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    await update($, model, () => e.model).catch(() => {})
    await update($, effort, () => e.effort ?? null).catch(() => {})
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      await refresh($).catch(() => {}) // a subagent's turn fills its own window, not this one
      await refreshWhere($).catch(() => {})
    }
    return r
  })

  // A failed refresh must not touch the command itself: let it through.
  on('command.run', async ($, e, next) => {
    const r = await next(e)
    if (REFRESH_COMMANDS.includes(e.command)) await refreshInfo($).catch(() => {})
    return r
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && 'messages' in r) void refresh($).catch(() => {}) // a /compact empties the window without a turn ending
    return r
  })

  on('command.run', { command: 'context-bar' }, async $ => {
    const hidden = await update($, isHidden, h => !h)
    await $.store.set('isHidden', hidden).catch(() => {})
    if (!hidden) await refresh($).catch(() => {})
    return { text: hidden ? 'Context bar hidden. /context-bar shows it again' : 'Context bar on' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e) // what other mods and Claude Code draw here stays, drawn above the box so one-row mods stay visible
    const r = await read($, reading)
    const name = await read($, model)
    const level = await read($, effort)
    const dir = await read($, cwd)
    const git = await read($, branch)
    if (e.props.hasSurvey || (await read($, isHidden)) || (!r && name === null && dir === null && git === null)) return rest
    const { Box, Text } = $.ui.resolve(e)
    const inner = e.props.bodyColumns - 4 // the border and padding take 4 cells
    if (inner < MIN_WIDTH) return rest

    // Folder and branch first; when it is tight the folder is cut at its start and the branch at its end, so the model and effort stay.
    const sep = (
      <Box flexShrink={0}>
        <Text dimColor>{' · '}</Text>
      </Box>
    )
    const info = [
      dir === null ? null : (
        <Box flexShrink={1} minWidth={0}>
          <Text color="blue" bold wrap="truncate-start">{dir}</Text>
        </Box>
      ),
      git === null ? null : (
        <Box flexShrink={1} minWidth={0}>
          <Text color="green" wrap="truncate">{git}</Text>
        </Box>
      ),
      name === null ? null : (
        <Box flexShrink={0}>
          <Text wrap="truncate">
            <Text color="cyan" bold>{name}</Text>
            <Text dimColor>{' · '}</Text>
            <Text color="magenta">{`effort: ${level === null ? 'n/a' : String(level)}`}</Text>
          </Text>
        </Box>
      ),
    ].filter(x => x !== null)
    const infoRow = info.length === 0 ? [] : [<Box flexDirection="row">{info.flatMap((x, i) => (i > 0 ? [sep, x] : [x]))}</Box>]

    const used = r ? (r.compactsAt ? r.total / r.compactsAt : r.total / r.window) : 0
    const bar = !r
      ? []
      : [
          <Box flexDirection="row" justifyContent="space-between">
            <Text wrap="truncate-end">
              <Text color="#d97757">{'◆ '}</Text>
              <Text bold>context</Text>
            </Text>
            <Text wrap="truncate-start">
              <Text dimColor>{`${tokens(r.total)} of ${tokens(r.window)}${r.compactsAt ? ` · compacts at ${tokens(r.compactsAt)}` : ''} `}</Text>
              <Text bold color="black" backgroundColor={used >= 0.9 ? 'red' : used >= 0.7 ? 'yellow' : 'green'}>{` ${r.percent}% `}</Text>
            </Text>
          </Box>,
          <Text>
            {cells(r, inner).map(c => (
              <Text color={c.color}>{c.text}</Text>
            ))}
          </Text>,
          ...legend(r, inner).map(line => (
            <Text wrap="truncate-end">
              {line.map((s, i) => (
                <Text>
                  {i > 0 && <Text>{SPLIT}</Text>}
                  <Text color={s.color}>{s.kind === 'used' ? '■ ' : `${GLYPH[s.kind]} `}</Text>
                  <Text dimColor={s.kind !== 'used'}>{`${s.name} `}</Text>
                  <Text bold={s.kind === 'used'}>{tokens(s.tokens)}</Text>
                  {s.kind === 'used' && <Text dimColor>{` ${share(s.tokens, r.window)}`}</Text>}
                </Text>
              ))}
            </Text>
          )),
        ]
    const mine = (
      <Box flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1}>
        {infoRow}
        {bar}
      </Box>
    )
    return stackBands(rest, 'context-bar', mine, 'below', await (bandOrder ??= readBandOrder($).catch(() => []))) // below what other mods draw, unless the band order says otherwise
  })
}

// The band order file, as the claude-code-mods checklist saves it; [] on any error.
async function readBandOrder($: EngineInterface): Promise<string[]> {
  const file = bandsFile(await $.env.get('CLAUDE_CONFIG_DIR'), await $.env.get('HOME'))
  return file && (await $.fs.exists(file)) ? parseOrder(await $.fs.read(file)) : []
}

// A path under the home folder, written with ~.
export const shortenPath = (path: string, home: string | undefined): string =>
  home && home !== '/' && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path

const isEffort = (value: unknown): value is Effort => typeof value === 'number' || (typeof value === 'string' && EFFORTS.includes(value))

// The current branch; a short sha when HEAD is detached; null outside a repository or without git.
export async function readBranch($: EngineInterface): Promise<string | null> {
  try {
    const ref = await $.process.run(['git', 'symbolic-ref', '--short', '-q', 'HEAD'], { timeoutMs: 5000 })
    if (ref.exitCode === 0) return ref.stdout.trim() || null
    if (ref.exitCode !== 1) return null // 1 is a detached HEAD, anything else (128) is no repository
    const sha = await $.process.run(['git', 'rev-parse', '--short', 'HEAD'], { timeoutMs: 5000 })
    return sha.exitCode === 0 && sha.stdout.trim() ? `@${sha.stdout.trim()}` : null
  } catch {
    return null
  }
}

async function refreshWhere($: EngineInterface) {
  const dir = shortenPath(await $.session.cwd(), await $.env.get('HOME'))
  await update($, cwd, () => dir)
  const name = await readBranch($)
  await update($, branch, () => name)
}

// Before the first request only /model and settings tell the model and effort; after it, turn.step does.
async function refreshInfo($: EngineInterface) {
  await refreshWhere($).catch(() => {})
  const name = await $.session.model()
  await update($, model, () => name)
  const settings = await $.settings.read()
  const perModel = settings.modelSettings as Record<string, { effortLevel?: unknown }> | undefined
  const level = perModel?.[name]?.effortLevel ?? settings.effortLevel // a per-model effort beats the top-level one
  if (isEffort(level)) await update($, effort, () => level)
}

// Forgets the cached band order, for tests.
export function resetBandOrder() {
  bandOrder = undefined
}

// Asks the engine for /context's breakdown, estimated locally (no token-count calls).
async function refresh($: EngineInterface) {
  if (await read($, isHidden)) return
  const usage = await $.session.usage({ breakdown: 'summary' })
  const b = usage.context.breakdown
  if (!b || !(b.rawMaxTokens > 0)) return // no window to measure against
  await update($, reading, () => toReading(b))
}

export function toReading(b: {
  categories: { name: string; tokens: number; color: string; kind: string }[]
  totalTokens: number
  rawMaxTokens: number
  percentage: number
  autoCompactThreshold?: number
  isAutoCompactEnabled: boolean
}): Reading {
  const slices: Slice[] = b.categories
    .filter(c => c.kind !== 'deferred' && c.tokens > 0)
    .map(c => ({ name: c.name.toLowerCase(), tokens: c.tokens, color: c.color, kind: c.kind as Slice['kind'] }))
  const order = { used: 0, free: 1, buffer: 2 }
  slices.sort((x, y) => order[x.kind] - order[y.kind]) // stable: used rows keep /context's order
  let next = 0
  for (const s of slices) {
    s.color = s.kind === 'free' ? FREE : s.kind === 'buffer' ? BUFFER : s.name === 'messages' ? MESSAGES : PALETTE[next++ % PALETTE.length]!
  }
  return {
    slices,
    total: b.totalTokens,
    window: b.rawMaxTokens,
    percent: b.percentage,
    compactsAt: b.isAutoCompactEnabled ? b.autoCompactThreshold : undefined,
  }
}

// The bar as runs of cells: each slice gets its share of `width`, a used one at least one cell.
export function cells(r: Reading, width: number) {
  const sizes = r.slices.map(s => Math.max(s.kind === 'used' ? 1 : 0, Math.round((s.tokens / r.window) * width)))
  // Rounding leaves the sum a few cells off: free space takes the difference first, then the largest slices.
  let diff = width - sizes.reduce((a, n) => a + n, 0)
  const isUsed = (i: number) => r.slices[i]!.kind === 'used'
  const order = r.slices.map((_, i) => i).sort((a, b) => Number(isUsed(a)) - Number(isUsed(b)) || sizes[b]! - sizes[a]!)
  for (const i of order) {
    if (diff === 0) break
    const size = Math.max(isUsed(i) ? 1 : 0, sizes[i]! + diff)
    diff -= size - sizes[i]!
    sizes[i] = size
  }
  return r.slices.map((s, i) => ({ color: s.color, kind: s.kind, text: GLYPH[s.kind].repeat(sizes[i]!) })).filter(c => c.text !== '')
}

// The legend, packed into lines no wider than `width`.
export function legend(r: Reading, width: number) {
  const lines: Slice[][] = [[]]
  let used = 0
  for (const s of r.slices) {
    const size = 2 + s.name.length + 1 + tokens(s.tokens).length + (s.kind === 'used' ? 1 + share(s.tokens, r.window).length : 0)
    const line = lines.at(-1)!
    if (line.length > 0 && used + SPLIT.length + size > width) {
      lines.push([s])
      used = size
    } else {
      used += (line.length > 0 ? SPLIT.length : 0) + size
      line.push(s)
    }
  }
  return lines.filter(l => l.length > 0)
}

export function tokens(n: number) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 10_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`
  return String(n)
}

export function share(n: number, window: number) {
  const p = (n / window) * 100
  if (p > 0 && p < 0.1) return '<0.1%'
  return `${p >= 10 ? Math.round(p) : +p.toFixed(1)}%`
}
