// Mission Control: /mission opens a pane with two views of the current turn.
//   who  · the main loop, its subagents and every tool call they make, live
//   code · a rendered map of the files Claude reads and edits, the imports between
//          them, a glow on what it touches right now, and one line on each change
// At the pane's foot a crab acts out what Claude is doing right now, and a band
// line sums the turn up while Claude works. The crab and its scenes come from
// crab-cam (https://github.com/sTomerG/agent-kit), absorbed under its MIT licence.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Activity, MapFile, MissionNode, Scene } from '../types'
import {
  activityOf,
  activityOfStreaming,
  helpersLine,
  isHandback,
  isToldByArgs,
  opensDesign,
  sceneOfLingering,
  whole,
} from './activity'
import type { Helper, Lingering } from './activity'
import { CRAB_WIDTH, DEMO, LABELS, sceneRows } from './crab'
import { importsOf, svg } from './map'
import { label, lines, summary } from './tree'
import { bandsFile, parseOrder, stackBands } from './bands'

const PANE = 'mission-control'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const MAX_FILES = 14
const BAND_AFTER_MS = 30_000 // the band stays this long after a turn ends
// Tools that are Claude Code's own bookkeeping, not work: kept out of the tree.
const INTERNAL = new Set(['SubagentHandback', 'ToolSearch', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'])
// Files that belong on a code map: source, config and docs, not images or binaries.
export const CODE_FILE = /\.(tsx?|jsx?|mjs|cjs|py|go|rs|rb|java|kt|swift|c|h|cc|cpp|hpp|cs|php|vue|svelte|css|scss|html|md|mdx|json|ya?ml|toml|sh|sql|lua|ex|exs)$/i

// The crab: how long a scene stays up, and how its words are kept short.
const REST_AFTER_MS = 8000
const TICK_MS = 600
const HOLD_MS = 1200 // a tool's scene stays at least this long, so a call that returns at once is still seen
const ERROR_HOLD_MS = 2500
const MAX_HELD = 3
const THINK_AFTER_MS = 5000 // nothing new for this long while working reads as thinking again
const DEMO_MS = 3000
const DEMO_DETAIL = 'demo'
// The detail may run on to a second line: the layout cuts whatever is wider
// than the room before the crab, so the limit only keeps it to two lines.
const DETAIL_LENGTH = 140
// A detail up to this long is taken to fit on one line.
const ONE_LINE = 60
// The rows the crab's block takes: a blank line, then three of glyphs.
const CRAB_FOOT_ROWS = 4

// Held by the host, so a hot reload keeps the picture.
const nodes = atom({ plugin: 'mission-control', key: 'nodes' } as const, [] as MissionNode[])
const files = atom({ plugin: 'mission-control', key: 'files' } as const, [] as MapFile[])
const view = atom({ plugin: 'mission-control', key: 'view' } as const, 'who' as 'who' | 'code')
const frame = atom({ plugin: 'mission-control', key: 'frame' } as const, null as { file: string; n: number } | null)
const turn = atom({ plugin: 'mission-control', key: 'turn' } as const, 0)
const now = atom({ plugin: 'mission-control', key: 'now' } as const, 0)
const scene = atom({ plugin: 'mission-control', key: 'scene' } as const, { activity: 'idle', detail: '' } as Scene)
const crabTick = atom({ plugin: 'mission-control', key: 'crabTick' } as const, 0)
const isCrabHidden = atom({ plugin: 'mission-control', key: 'isCrabHidden' } as const, false)

// Drawing bookkeeping; a reload starts it over.
const draw = { size: { columns: 100, rows: 30 }, pending: false, dirty: false, n: 0, error: '' }
const changes = new Map<string, string[]>() // path → this turn's edits, for the one-line "why"

// The main node of the turn now running: the newest one, as every turn of the
// session keeps its tree.
function latestMain(list: readonly MissionNode[]): string {
  for (let i = list.length - 1; i >= 0; i--) { const n = list[i]; if (n && n.kind === 'main') return n.id }
  return 'main'
}

// The first `max` characters, cut at a word.
function words(text: string, max: number) {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.lastIndexOf(' ', max)
  return `${t.slice(0, cut > max * 0.5 ? cut : max)}…`
}

// The crab's scene ----------------------------------------------------------------

// What a call is about, in a few words: the file's name, what a command does,
// the pattern. A command comes with its description in plain words, the one the
// app shows too; that goes before the command itself.
const DETAIL_KEYS = ['file_path', 'notebook_path', 'description', 'command', 'pattern', 'query', 'url', 'skill'] as const

// A detail cut to what the pane has room for.
function clip(text: string): string {
  return text.length > DETAIL_LENGTH ? `${text.slice(0, DETAIL_LENGTH - 1)}…` : text
}

function detailOf(tool: string, args: Readonly<Record<string, unknown>>): string {
  for (const key of DETAIL_KEYS) {
    const value = args[key]

    if (typeof value !== 'string' || value === '') {
      continue
    }

    const isPath = key === 'file_path' || key === 'notebook_path'

    return clip(isPath ? (value.split('/').pop() ?? value) : (value.split('\n')[0] ?? value))
  }

  return tool.startsWith('mcp__') ? (tool.split('__').pop() ?? '') : ''
}

// The arguments that say what a call is about before it is made, once all of
// one has arrived: the file written to, the skill, what a command does.
const EARLY_KEYS = ['file_path', 'skill', 'description'] as const

// What a call is about while its arguments are still arriving; nothing until
// one of the telling ones is whole.
function detailOfStreaming(tool: string, json: string): string {
  for (const key of EARLY_KEYS) {
    const value = whole(json, key)

    if (value !== undefined) {
      return detailOf(tool, { [key]: value })
    }
  }

  return ''
}

type Painted = { activity: Activity; detail: string; hold: number }

type Call = { tool: string; activity: Activity; detail: string }

let isWorking = false
// Whether this turn has taken up design work, by a design skill or tool or
// the start of an artifact: a page written after that is designed, not coded.
let isDesigning = false
// The main loop's calls still running, by tool_use_id, in the order begun.
const calls = new Map<string, Call>()
let pending: Promise<unknown> = Promise.resolve()
let rest: Timer | undefined
let demo: Timer | undefined
let muse: Timer | undefined
// The pane's animation tick, running for the session.
let ticker: Timer | undefined
// The tool a permission dialog is open for, while one is.
let asking: string | undefined
// What the last stop of the main loop left running in the background.
let lingering: readonly Lingering[] = []
// The scene on screen, the hold it is under, and what came in meanwhile.
let current: Painted | undefined
let busy: Timer | undefined
let held: Painted[] = []
let trailing: Painted | undefined

// The next scene due: held ones in the order made, then the latest unheld one.
function takeQueued(): Painted | undefined {
  const [first, ...others] = held
  held = others

  if (first !== undefined) {
    return first
  }

  const last = trailing
  trailing = undefined

  return last
}

// Draws a scene, or queues it while the one on screen is still held. Writes
// run one after another and off the caller's path, so a stream of chunks
// never waits on the crab and two changes land in the order made.
function paint($: EngineInterface, activity: Activity, detail: string, hold = 0): void {
  const wanted: Painted = { activity, detail, hold }

  if (busy !== undefined) {
    if (hold > 0) {
      held = [...held, wanted].slice(-MAX_HELD)
      trailing = undefined
    } else {
      trailing = wanted
    }

    return
  }

  if (current?.activity !== activity || current.detail !== detail) {
    const next: Scene = { activity, detail }
    pending = pending.then(() => update($, scene, () => next)).catch(() => undefined)
  }

  current = wanted

  if (hold > 0) {
    busy = $.clock.after(hold, () => {
      busy = undefined
      const due = takeQueued()

      if (due !== undefined) {
        paint($, due.activity, due.detail, due.hold)
      }
    })
  }
}

// Drops the hold on the scene on screen and what is queued behind it, so the
// next scene shows at once and nothing from before it shows after.
function flush(): void {
  busy?.cancel()
  busy = undefined
  held = []
  trailing = undefined
}

// What the session is doing; held back while the demo has the crab.
function show($: EngineInterface, activity: Activity, detail = '', hold = 0): void {
  if (demo === undefined) {
    paint($, activity, detail, hold)
  }
}

function stopMusing(): void {
  muse?.cancel()
  muse = undefined
}

// Back to thinking once nothing new has come for a while. A scene on the
// helpers stays: they are still at work, whatever the main loop is doing.
function museLater($: EngineInterface): void {
  stopMusing()
  muse = $.clock.after(THINK_AFTER_MS, () => {
    muse = undefined

    if (isWorking && calls.size === 0 && current?.activity !== 'delegating') {
      show($, 'thinking')
    }
  })
}

// The helpers at work, as the crab's line tells of them: what each is doing
// now, and what it is for where that is known.
function helpersOf(list: readonly MissionNode[]): readonly Helper[] {
  return list.filter(n => n.kind === 'agent' && n.status === 'running').map(a => ({ activity: a.doing ?? 'thinking', about: a.label }))
}

// What the helpers' line says once one came, went or took up something else:
// during a turn only while the scene is theirs already, between turns whenever
// the crab is settled.
async function helpersNews($: EngineInterface): Promise<void> {
  if (isWorking) {
    if (current?.activity === 'delegating') {
      const helpers = helpersOf(await read($, nodes))

      if (helpers.length > 0) {
        show($, 'delegating', clip(helpersLine(helpers)))
      } else {
        resume($)
      }
    }
  } else if (rest === undefined) {
    await settle($)
  }
}

// The scene between turns: the helpers still at work, the background work
// still going, or rest.
async function settle($: EngineInterface): Promise<void> {
  const helpers = helpersOf(await read($, nodes))

  if (helpers.length > 0) {
    show($, 'delegating', clip(helpersLine(helpers)))

    return
  }

  const still = sceneOfLingering(lingering)

  if (still === undefined) {
    show($, 'idle')
  } else {
    show($, still.activity, clip(still.detail))
  }
}

// The scene of a turn under way: the call still running that began last, else
// thinking.
function resume($: EngineInterface): void {
  const last = [...calls.values()].pop()

  if (last === undefined) {
    show($, 'thinking')
  } else {
    show($, last.activity, last.detail)
  }
}

// Back to what the session is doing, after something else had the crab.
async function restore($: EngineInterface): Promise<void> {
  if (isWorking) {
    resume($)
  } else {
    await settle($)
  }
}

function stopTimers(): void {
  stopMusing()
  rest?.cancel()
  rest = undefined
}

// Walks every scene in turn, so each can be seen without a task that happens
// to raise it; the session's own scenes wait until it is through.
function playDemo($: EngineInterface): void {
  demo?.cancel()
  flush()
  let index = 0
  paint($, DEMO[0] ?? 'idle', DEMO_DETAIL)

  demo = $.clock.every(DEMO_MS, () => {
    index += 1
    const activity = DEMO[index]

    if (activity === undefined) {
      demo?.cancel()
      demo = undefined
      void restore($)

      return
    }

    paint($, activity, DEMO_DETAIL)
  })
}

// The pane's animation: a tick only while the pane is up, so nothing animates
// unseen.
async function tickIfShown($: EngineInterface): Promise<void> {
  const panes = await $.ui.panes().catch(() => [])

  if (panes.some(p => p.id === PANE && p.isPlaced)) {
    await update($, crabTick, tick => (tick + 1) % 60).catch(() => undefined)
  }
}

let bandOrder: Promise<string[]> | undefined // read once per session: restart to apply

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command
      .register({
        name: 'mission',
        description: 'Open the live map of agents and tool calls; "code" the code map, "crab" the crab at its foot, "demo" every crab scene',
        argumentHint: '[who|code|crab|demo]',
      })
      .catch(() => {})
    $.clock.every(1000, () => {
      void (async () => {
        const busy = (await read($, nodes)).some(n => n.status === 'running')
        if (busy) await update($, now, () => Date.now())
      })().catch(() => {})
    })
    // The crab takes up where the session stood; only a scene on its way to
    // rest is put to rest.
    const stored = await read($, scene)

    if (stored.activity === 'done' || stored.activity === 'error') {
      show($, 'idle')
    }

    ticker = $.clock.every(TICK_MS, () => void tickIfShown($).catch(() => undefined))
    return r
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e) // a subagent's turn is not this tree's to root
    const t = (await read($, turn)) + 1
    await update($, turn, () => t)
    changes.clear()
    // The turn's id is the main node's, so every turn of the session keeps its own tree.
    const main: MissionNode = { id: e.turnId ?? 'main', parent: null, kind: 'main', label: `main · ${words(e.text, 50)}`, family: 'main', status: 'running', start: Date.now() }
    // The turns before stay; a background agent still running carries over to the new main
    // with its open calls, and what a turn left running without its complete closes now.
    await update($, nodes, list => {
      const live = new Set(list.filter(n => n.kind === 'agent' && n.status === 'running').map(a => a.id))
      return [
        ...list.map(n =>
          n.kind === 'agent' && live.has(n.id)
            ? { ...n, parent: main.id }
            : n.status === 'running' && !live.has(n.parent ?? '')
              ? { ...n, status: 'done' as const, end: Date.now() }
              : n,
        ),
        main,
      ]
    })
    // The crab sets out.
    stopTimers()
    isWorking = true
    isDesigning = false
    calls.clear()
    asking = undefined
    flush()
    show($, 'thinking')
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId) {
      const id = r.agentId
      await update($, nodes, list => {
        const agent: MissionNode = { id, parent: e.parentAgentId ?? latestMain(list), kind: 'agent', label: e.description || e.subagentType, family: 'agent', status: 'running', start: Date.now(), doing: 'thinking' }
        return [...list, agent]
      })
      void helpersNews($)
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    const args = e as unknown as Record<string, unknown>
    // The Agent tool's own node is the subagent that agent.spawn adds; the
    // crab still shows the delegation while the call runs.
    if (e.tool === 'Agent') {
      if (e.agentId !== undefined) return next(e) // a helper's own helper: not this tree's to show
      const detail = detailOf(e.tool, args)
      calls.set(e.tool_use_id, { tool: e.tool, activity: 'delegating', detail })
      stopMusing()
      show($, 'delegating', detail, HOLD_MS)
      const r = await next(e) // agent.spawn fires within: the helpers' line takes over the scene
      calls.delete(e.tool_use_id)

      if (isWorking && calls.size === 0 && asking === undefined) {
        museLater($)
      }

      return r
    }
    if (INTERNAL.has(e.tool)) return next(e) // bookkeeping, not work a person would follow
    const { label: text, family } = label(args)
    const id = e.tool_use_id
    // A helper's call says what it is doing (unless it hands its answer back);
    // the crab's own scene follows the main loop and stays on the helpers.
    const isHelper = e.agentId !== undefined
    const isDoing = isHelper && !isHandback(e.tool)
    const activity = activityOf(e.tool, args, isDesigning)
    await update($, nodes, list => {
      // A call from an agent this tree does not know hangs off main rather than nowhere.
      const parent = e.agentId && list.some(n => n.id === e.agentId) ? e.agentId : latestMain(list)
      const call: MissionNode = { id, parent, kind: 'tool', label: text, family, status: 'running', start: Date.now() }
      const grown = [...list, call]
      return isDoing && e.agentId !== undefined ? grown.map(n => (n.kind === 'agent' && n.id === e.agentId ? { ...n, doing: activity } : n)) : grown
    })
    const path = typeof args.file_path === 'string' ? args.file_path : undefined
    if (path) await touch($, path, e.tool === 'Read' ? 'read' : e.tool === 'Write' ? 'write' : e.tool === 'Edit' ? 'edit' : 'search', false)

    const detail = isHelper ? '' : detailOf(e.tool, args)

    if (isDoing) {
      void helpersNews($)
    } else if (!isHelper) {
      isDesigning ||= opensDesign(e.tool, args)
      calls.set(e.tool_use_id, { tool: e.tool, activity, detail })
      stopMusing()
      show($, activity, detail, HOLD_MS)
    }

    let failed = true
    let r: Awaited<ReturnType<typeof next>>
    try {
      r = await next(e)
      failed = r.deny !== undefined || r.isError === true
    } finally {
      await update($, nodes, list => list.map(n => (n.id === id ? { ...n, status: failed ? 'failed' : 'done', end: Date.now() } : n)))
    }

    if (!isHelper) {
      calls.delete(e.tool_use_id)
      const wasAsked = asking === e.tool

      if (wasAsked) {
        asking = undefined
      }

      // A call that returns once its turn is over, as on an interrupt, says
      // nothing of the session any more.
      if (isWorking) {
        if (failed) {
          show($, 'error', detail, ERROR_HOLD_MS)
        }

        // A dialog still open for another call keeps the crab.
        if (asking === undefined) {
          if (calls.size > 0) {
            resume($)
          } else {
            if (wasAsked && !failed) {
              show($, activity, detail)
            }

            museLater($)
          }
        }
      }
    }

    if (path && !failed && (e.tool === 'Edit' || e.tool === 'Write')) {
      const what = e.tool === 'Edit' ? `- ${String(args.old_string ?? '').slice(0, 300)}\n+ ${String(args.new_string ?? '').slice(0, 300)}` : `wrote ${String(args.content ?? '').slice(0, 400)}`
      changes.set(path, [...(changes.get(path) ?? []), what])
      await touch($, path, e.tool === 'Edit' ? 'edit' : 'write', true)
    }
    return r
  })

  // The scene while the model streams: a tool's arguments often say what it is
  // about seconds before the call is made, and the crab should not sit on a
  // generic scene while they arrive.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      return yield* next(e)
    }

    // A reload in the middle of a turn has no turn.start to go by.
    isWorking = true
    // The calls of this response whose arguments are still arriving and say
    // what the call is about, by block: the tool and what has arrived, until
    // it settles the scene.
    const arriving = new Map<number, { tool: string; json: string; activity?: Activity }>()

    for await (const chunk of next(e)) {
      if (chunk.kind === 'thinking') {
        // Right after a tool the thinking is the short pause before the next
        // call: the tool's scene stays until the pause has lasted.
        if (muse === undefined && calls.size === 0) {
          show($, 'thinking')
        }
      } else if (chunk.kind === 'text' && chunk.text.trim() !== '') {
        stopMusing()
        show($, 'talking')
      } else if (chunk.kind === 'tool') {
        stopMusing()

        // What a command or an edit is about shows only in its arguments: the
        // scene waits for enough of them, rather than passing through a
        // generic one.
        if (isToldByArgs(chunk.name)) {
          arriving.set(chunk.index, { tool: chunk.name, json: '' })
        } else {
          show($, activityOf(chunk.name))
        }
      } else if (chunk.kind === 'input') {
        const before = arriving.get(chunk.index)

        if (before !== undefined) {
          const json = before.json + chunk.json
          const activity = before.activity ?? activityOfStreaming(before.tool, json, isDesigning)
          const detail = activity === undefined ? '' : detailOfStreaming(before.tool, json)

          // The scene shows as soon as it is settled, and what it is about
          // as soon as that is in: a command's description comes after the
          // command, which may be seconds later.
          if (detail === '') {
            arriving.set(chunk.index, { tool: before.tool, json, activity })
          } else {
            arriving.delete(chunk.index)
          }

          if (activity !== undefined && (before.activity === undefined || detail !== '')) {
            show($, activity, detail)
          }
        }
      }

      yield chunk
    }
  })

  // The dialog is on screen from here until the person answers; nothing says
  // when they did, so the scene stays until the call itself returns. A
  // subagent's dialog is not the main loop's, and a question or a plan put to
  // the person is asking, not permission.
  on('classic.PermissionRequest', ($, e, next) => {
    if (e.agent_id !== undefined) {
      return next(e)
    }

    asking = e.tool_name

    if (activityOf(e.tool_name) === 'asking' || e.tool_name === 'ExitPlanMode') {
      show($, 'asking')
    } else {
      show($, 'permission', e.tool_name)
    }

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') {
      return next(e)
    }

    show($, 'compacting', '', HOLD_MS)

    try {
      return await next(e)
    } finally {
      void restore($)
    }
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const id = e.agentId ?? e.turnId ?? 'main'
    const failed = e.reason === 'error' || e.reason === 'aborted'
    const isMain = !e.agentId
    // The main turn ending closes everything it left marked running, so the clock can rest.
    await update($, nodes, list => {
      // Only main's own leftovers: a background agent still running keeps its open calls.
      const live = new Set(list.filter(n => n.kind === 'agent' && n.status === 'running' && n.id !== id).map(n => n.id))
      const close = (n: MissionNode) => n.id === id || (isMain && n.kind === 'tool' && !live.has(n.parent ?? ''))
      return list.map(n => (close(n) && n.status === 'running' ? { ...n, status: failed ? 'failed' : 'done', end: Date.now() } : n))
    })
    if (isMain) {
      const t = await read($, turn)
      void explain($, t, new Map(changes)).catch(() => {}) // in the background, so the turn ends at once
      // The crab rests, unless work goes on without it.
      stopTimers()
      isWorking = false
      calls.clear()
      asking = undefined
      flush()

      if (e.isAborted) {
        void settle($)
      } else {
        // A refusal or an API error ended the turn too, but nothing is done.
        show($, e.reason === 'answer' ? 'done' : 'error')
        rest = $.clock.after(REST_AFTER_MS, () => {
          rest = undefined

          if (!isWorking) {
            void settle($)
          }
        })
      }
    } else {
      void helpersNews($)
    }
    return r
  })

  // The turn may be over while a command or a helper it started runs on: the
  // crab then keeps at it rather than resting, until the next turn begins.
  on('classic.Stop', ($, e, next) => {
    lingering = e.background_tasks ?? []

    if (!isWorking && rest === undefined) {
      void settle($)
    }

    return next(e)
  })

  // `/clear`, `/resume` and the end of the session: what the crab knew of the
  // conversation is gone with it.
  on('session.end', async ($, e, next) => {
    stopTimers()
    ticker?.cancel()
    ticker = undefined
    demo?.cancel()
    demo = undefined
    flush()
    isWorking = false
    isDesigning = false
    calls.clear()
    asking = undefined
    lingering = []
    // The conversation is gone; the whole history goes with it.
    await update($, nodes, () => [])
    paint($, 'idle', '')

    return next(e)
  })

  on('command.run', { command: 'mission' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'code' || arg === 'who') await update($, view, () => arg)
    let said: string | undefined
    if (arg === 'crab') {
      const hidden = await update($, isCrabHidden, value => !value)
      said = hidden ? 'The crab is hidden. /mission crab brings it back.' : 'The crab is back at the foot of the pane.'
    }
    if (arg === 'demo') {
      await update($, isCrabHidden, () => false)
      playDemo($)
      said = `The crab plays all ${DEMO.length} scenes, ${DEMO_MS / 1000} seconds each.`
    }
    await $.ui.open({ id: PANE, title: 'Mission Control', focus: true })
    void renderSoon($)
    const s = summary(await read($, nodes))
    return { text: said ?? `Mission Control: ${s.agents} agents · ${s.tools} tool calls · ${(await read($, files)).length} files. w: who · c: code · q: close` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    await read($, now) // subscribes the pane to the clock
    const v = await read($, view)
    const bodyRows = e.props.scroll?.bodyRows ?? 30
    const rows = Math.max(6, bodyRows - 3)
    const columns = Math.max(20, e.props.bodyColumns)
    const head = (
      <Box flexDirection="row" gap={1}>
        <Button key="who" label="Who" hotkey="w" variant={v === 'who' ? 'primary' : undefined} onPress={() => update($, view, () => 'who')} />
        <Button key="code" label="Code" hotkey="c" variant={v === 'code' ? 'primary' : undefined} onPress={() => void setCode($)} />
        <Button key="close" label="Close" hotkey="q" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
      </Box>
    )

    if (v === 'code') {
      if (e.surface !== 'terminal') {
        return (
          <Box flexDirection="column">
            {head}
            <Text dimColor>The code map draws in the terminal.</Text>
          </Box>
        )
      }
      const { Image } = $.ui.resolve(e)
      // A fixed 16:10 shape from the pane's width: lines coming and going above the prompt
      // change the pane's height, and must not resize (and jolt) the picture.
      const imageRows = Math.min(rows, Math.round(columns * 0.3))
      if (draw.size.columns !== columns || draw.size.rows !== imageRows) {
        draw.size = { columns, rows: imageRows }
        void renderSoon($)
      }
      const f = await read($, frame)
      return (
        <Box flexDirection="column">
          {head}
          {f ? (
            <Image key="map" source={{ file: f.file, format: 'png', generation: f.n }} columns={draw.size.columns} rows={draw.size.rows} alt="Code map" />
          ) : (
            <Text dimColor>{draw.error || 'Drawing the code map…'}</Text>
          )}
        </Box>
      )
    }

    const at = Date.now()
    const ls = lines(await read($, nodes), at)
    const s = summary(await read($, nodes))
    const hidden = await read($, isCrabHidden)
    // The crab at the pane's foot: the glyph crab, the scene's prop beside it,
    // and what it says, in three rows. Its block takes its rows from the tree.
    const acted = hidden ? undefined : await read($, scene)
    const ticked = hidden ? undefined : await read($, crabTick)
    const crab = acted === undefined || ticked === undefined ? undefined : sceneRows(acted.activity, ticked)
    // The tree keeps at least three rows however short the pane; past that
    // the crab's block gives way to the engine's scroll window.
    const shown = ls.slice(hidden ? -rows + 1 : -Math.max(3, rows - 1 - CRAB_FOOT_ROWS))
    // With the crab the column is as tall as the body, and the spacer before the
    // crab takes what the tree leaves, so the crab sits at the pane's foot.
    return (
      <Box flexDirection="column" minHeight={crab !== undefined ? bodyRows : undefined}>
        {head}
        <Text dimColor>{`${s.agents} agents (${s.running} running) · ${s.tools} tool calls${s.failed ? ` · ${s.failed} failed` : ''}`}</Text>
        {ls.length === 0 && <Text dimColor>Nothing yet. Start a task and watch it fill in.</Text>}
        {shown.map(l => (
          <Text wrap="truncate-end">
            <Text dimColor>{l.prefix}</Text>
            <Text color={l.status === 'running' ? 'yellow' : l.status === 'failed' ? 'red' : l.node.kind === 'tool' ? undefined : 'green'} bold={l.node.kind !== 'tool'} dimColor={l.status === 'done' && l.node.kind === 'tool'}>
              {l.text}
            </Text>
          </Text>
        ))}
        {crab !== undefined && acted !== undefined && <Box flexGrow={1} />}
        {crab !== undefined && acted !== undefined && <Text>{' '}</Text>}
        {crab !== undefined && acted !== undefined && (
          <Box flexDirection="row" gap={2} flexShrink={0}>
            <Box flexDirection="column" flexShrink={0} width={CRAB_WIDTH}>
              {crab.crab.map(row => (
                <Text color="claude">{row}</Text>
              ))}
            </Box>
            <Box flexDirection="column" flexShrink={0}>
              {crab.prop.map(row => (
                <Text dimColor>{row === '' ? ' ' : row}</Text>
              ))}
            </Box>
            <Box flexDirection="column" flexGrow={1} minWidth={0}>
              <Text> </Text>
              <Text bold wrap="truncate-end">
                {LABELS[acted.activity]}
              </Text>
              <Text dimColor wrap={acted.detail.length <= ONE_LINE ? 'truncate-end' : 'wrap'}>
                {acted.detail === '' ? ' ' : acted.detail}
              </Text>
            </Box>
          </Box>
        )}
      </Box>
    )
  })

  // The band: one summary line while Claude works, and for a short while after.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e) // what other mods and Claude Code draw here stays
    const list = await read($, nodes)
    const main = list.filter(n => n.kind === 'main').at(-1)
    const s = summary(list)
    const isRecent = main !== undefined && (main.status === 'running' || Date.now() - (main.end ?? 0) < BAND_AFTER_MS)
    if (e.props.hasSurvey || !isRecent || s.tools + s.agents === 0) return rest
    const t = await read($, turn)
    const edited = (await read($, files)).filter(f => f.changedTurn === t).length
    const { Text } = $.ui.resolve(e)
    const mine = (
      <Text wrap="truncate-end">
        <Text color="blue" bold>{' ◈ mission: '}</Text>
        <Text>{`${s.agents ? `${s.running}/${s.agents} agents · ` : ''}${s.tools} tools${s.failed ? ` · ${s.failed} failed` : ''}${edited ? ` · ${edited} files changed` : ''}`}</Text>
        <Text dimColor>{`  ·  ${LABELS[(await read($, scene)).activity]}`}</Text>
        <Text dimColor>{'  ·  /mission'}</Text>
      </Text>
    )
    return stackBands(rest, 'mission-control', mine, 'above', await (bandOrder ??= readBandOrder($).catch(() => []))) // above what other mods draw, unless the band order says otherwise
  })
}

// The band order file, as the claude-code-mods checklist saves it; [] on any error.
async function readBandOrder($: EngineInterface): Promise<string[]> {
  const file = bandsFile(await $.env.get('CLAUDE_CONFIG_DIR'), await $.env.get('HOME'))
  return file && (await $.fs.exists(file)) ? parseOrder(await $.fs.read(file)) : []
}

// Forgets the cached band order, for tests.
export function resetBandOrder() {
  bandOrder = undefined
}

async function setCode($: EngineInterface) {
  await update($, view, () => 'code')
  await renderSoon($)
}

// Notes a file Claude touched, with the relative imports it has.
async function touch($: EngineInterface, path: string, act: MapFile['act'], isChange: boolean) {
  if (!CODE_FILE.test(path)) return // an image, a PDF, a lockfile: not code to map
  const t = await read($, turn)
  const text = await $.fs.read(path).catch(() => '')
  const imports = typeof text === 'string' ? importsOf(path, text.slice(0, 200_000)) : [] // imports sit near the top
  await update($, files, list => {
    const old = list.find(f => f.path === path)
    const next: MapFile = { path, act, at: Date.now(), changedTurn: isChange ? t : (old?.changedTurn ?? 0), imports: imports.length ? imports : (old?.imports ?? []), why: isChange ? undefined : old?.why }
    return [...list.filter(f => f.path !== path), next].sort((a, b) => b.at - a.at).slice(0, MAX_FILES)
  })
  await renderSoon($)
  $.clock.after(5500, () => void renderSoon($).catch(() => {})) // again once the glow has faded
}

// One plain line per changed file, from what changed this turn.
async function explain($: EngineInterface, forTurn: number, edits: Map<string, string[]>) {
  if (edits.size === 0) return
  const paths = [...edits.keys()]
  const plain = (t: string) => t.replace(/[<>"]/g, ' ')
  const body = paths.map((p, i) => `<file n="${i + 1}" name="${plain(p.split('/').slice(-2).join('/'))}">\n${plain((edits.get(p) ?? []).join('\n').slice(0, 1500))}\n</file>`).join('\n')
  const r = await $.model.complete({
    model: 'haiku',
    maxTokens: 400,
    system: 'For each file, say in plain words what changed, at most 60 characters, no em dashes. Reply with a JSON array of strings only, one per file, in the same order.',
    prompt: `${body}\n\nReply with the JSON array only: ${paths.length} strings.`,
  })
  if (!r.isAnswered) return
  let whys: unknown
  try {
    whys = JSON.parse(r.text.slice(r.text.indexOf('['), r.text.lastIndexOf(']') + 1))
  } catch {
    return
  }
  if (!Array.isArray(whys)) return
  // By position, so nothing has to match a path the model may have rewritten.
  const byPath = new Map(paths.map((p, i) => [p, typeof whys[i] === 'string' ? (whys[i] as string).replace(/\s*—\s*/g, ', ').slice(0, 80) : undefined]))
  // A slow answer from an earlier turn must not label this turn's changes.
  if ((await read($, turn)) !== forTurn) return
  await update($, files, list => list.map(f => (byPath.get(f.path) && f.changedTurn === forTurn ? { ...f, why: byPath.get(f.path) } : f)))
  await renderSoon($)
}

// Draws the code map at most about once a second, only while someone looks at it.
async function renderSoon($: EngineInterface) {
  if (draw.pending) {
    draw.dirty = true // drawing now: draw once more when it is done
    return
  }
  if ((await read($, view)) !== 'code') return
  const isUp = (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)
  if (!isUp) return
  draw.pending = true
  draw.dirty = false
  $.clock.after(700, () => {
    void renderMap($)
      .catch(() => {})
      .finally(() => {
        draw.pending = false // only now: two Chromes must never share the profile
        if (draw.dirty) void renderSoon($).catch(() => {})
      })
  })
}

async function renderMap($: EngineInterface) {
  if (!(await $.fs.exists(CHROME))) {
    draw.error = `The code map needs Google Chrome at ${CHROME}.`
    await update($, now, () => Date.now()) // redraw the pane with the message
    return
  }
  draw.error = ''
  const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')
  const dir = `${tmp}/mission-control`
  const n = ++draw.n
  const width = Math.round(draw.size.columns * 9)
  const height = Math.round(draw.size.rows * 19)
  const svgPath = `${dir}/map.svg`
  const png = `${dir}/map-${n % 2}.png` // two files in turn, so the shown one is never half written
  await $.fs.write(svgPath, svg(await read($, files), { width, height, at: Date.now(), turn: await read($, turn) }))
  // Headless Chrome writes the screenshot but does not always exit: wait for the file,
  // then close that Chrome (its own throwaway profile, never the person's browser).
  const script =
    'mkdir -p "$(dirname "$2")"; rm -f "$2"; "$1" --headless=new --disable-gpu --hide-scroll-bars --force-device-scale-factor=2 --no-first-run --no-default-browser-check ' +
    '--user-data-dir="$3" --window-size="$4" --screenshot="$2" "$5" >/dev/null 2>&1 & pid=$!; ' +
    'i=0; while [ ! -s "$2" ] && [ $i -lt 150 ]; do sleep 0.1; i=$((i+1)); done; sleep 0.2; pkill -P $pid 2>/dev/null; kill $pid 2>/dev/null; [ -s "$2" ]'
  const r = await $.process.run(['sh', '-c', script, 'mission-control', CHROME, png, `${dir}/chrome`, `${width},${height}`, `file://${encodeURI(svgPath)}`], { timeoutMs: 20_000 })
  if (r.exitCode === 0) await update($, frame, () => ({ file: png, n }))
}
