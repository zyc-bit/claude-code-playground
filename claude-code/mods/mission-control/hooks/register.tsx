// Mission Control: /mission opens a pane with three views of the session.
//   who    · the main loop, its subagents and every tool call they make, live
//   code   · a rendered map of the files Claude reads and edits, the imports between
//            them, a glow on what it touches right now, and one line on each change
//   agents · a grid with one card per subagent (two or three a row when the pane is
//            wide); a number opens that agent: its whole conversation, a button that
//            puts its transcript in the main view (the prompt then talks to it) and one
//            that asks it to stop. No call stops a subagent outright, so that is a message.
//            /radar opens this view too.
// At the pane's foot a crab acts out what Claude is doing right now. The band sums
// the turn up while Claude works, with one live line per running subagent, and a
// toast says when each subagent finishes. The crab and its scenes come from
// crab-cam (https://github.com/sTomerG/agent-kit), absorbed under its MIT licence.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderNode, Timer } from 'claude-code'

import type { Activity, AgentCard, MapFile, MissionNode, Scene } from '../types'
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
import { agentColor, agentIcon, chunk, doingOf, elapsed, isShown, oneLine, wrapCells } from './agents'
import { CRAB_WIDTH, DEMO, LABELS, sceneRows } from './crab'
import { importsOf, svg } from './map'
import { label, lines, scrolled, summary } from './tree'
import { bandsFile, parseOrder, stackBands } from './bands'

const PANE = 'mission-control'
// A headless Chrome or Chromium to draw the map with: CHROME_PATH wins, then
// the usual installs, probed again each render so one that appears
// mid-session is picked up.
const CHROMES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]
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

// The agents view and the band's agent lines.
const MAX_AGENTS = 30 // the cards kept: the oldest falls off past this many
const BAND_AGENTS = 4 // the band's agent lines, the latest at work
const CARD_MIN = 40 // a grid column is at least this wide
const CARD_ROWS = 6 // a row of cards: four lines inside a border
const MAX_MESSAGES = 200 // an agent's page shows its last this many messages
const STOP_TEXT = 'Please stop: finish the step you are on, start nothing new, and reply with what you have so far.'
// What a session leaves in the store, so --continue or --resume picks its views up again.
const SAVED_SESSIONS = 10 // the sessions kept, the latest saved
const SAVED_NODES = 3000 // a session's newest nodes kept

// Held by the host, so a hot reload keeps the picture.
const nodes = atom({ plugin: 'mission-control', key: 'nodes' } as const, [] as MissionNode[])
const files = atom({ plugin: 'mission-control', key: 'files' } as const, [] as MapFile[])
const view = atom({ plugin: 'mission-control', key: 'view' } as const, 'who' as 'who' | 'code' | 'agents')
// Each scrolling view's window: `off` rows hidden above it, `follow` holding it
// on the newest rows. The engine's own window never moves (the pane draws to
// its room and no more); the wheel moves these instead, so the tabs and the
// crab stay where they are.
const treeScroll = atom({ plugin: 'mission-control', key: 'tree-scroll' } as const, { follow: true, off: 0 })
const frame = atom({ plugin: 'mission-control', key: 'frame' } as const, null as { file: string; n: number } | null)
const turn = atom({ plugin: 'mission-control', key: 'turn' } as const, 0)
const now = atom({ plugin: 'mission-control', key: 'now' } as const, 0)
const scene = atom({ plugin: 'mission-control', key: 'scene' } as const, { activity: 'idle', detail: '' } as Scene)
const crabTick = atom({ plugin: 'mission-control', key: 'crabTick' } as const, 0)
const isCrabHidden = atom({ plugin: 'mission-control', key: 'isCrabHidden' } as const, false)
// The agents view: its cards, the one opened, what its last button press came to.
const agents = atom({ plugin: 'mission-control', key: 'agents' } as const, [] as AgentCard[])
const agentPick = atom({ plugin: 'mission-control', key: 'agentPick' } as const, null as string | null)
const agentNotice = atom({ plugin: 'mission-control', key: 'agentNotice' } as const, null as string | null)
const gridScroll = atom({ plugin: 'mission-control', key: 'grid-scroll' } as const, { follow: false, off: 0 }) // in rows of cards, from the first spawned
const agentScroll = atom({ plugin: 'mission-control', key: 'agent-scroll' } as const, { follow: true, off: 0 }) // in lines of the open agent's conversation

// Drawing bookkeeping; a reload starts it over.
const draw = { size: { columns: 100, rows: 30 }, pending: false, dirty: false, n: 0, error: '' }
// The window of the view last drawn, so a scroll between draws moves the right
// one and clamps: its atom, the rows it holds and shows, and the rows a step is.
let scrollable: { at: 'tree' | 'grid' | 'agent'; total: number; rows: number; unit: number } | undefined
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

export const register: Register = (on, options) => {
  const isOpenOnStart = options.openOnStart !== false
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // The pane opens with the session, the prompt keeping its focus; a reload
    // runs this again, and an open pane is left as it is.
    await restoreSaved($).catch(() => {})
    if (isOpenOnStart && e.isInteractive && !(await $.ui.panes().catch(() => [])).some(p => p.id === PANE)) {
      await $.ui.open({ id: PANE, title: 'Mission Control' }).catch(() => {})
    }
    await $.command
      .register({
        name: 'mission',
        description: 'Open the live map of agents and tool calls; "code" the code map, "agents" a card per subagent, "crab" the crab at its foot, "demo" every crab scene',
        argumentHint: '[who|code|agents|crab|demo]',
      })
      .catch(() => {})
    // A name Claude Code already has is refused: start anyway.
    await $.command.register({ name: 'radar', description: 'Show what each subagent is doing, in the agents view of Mission Control' }).catch(() => {})
    $.clock.every(1000, () => {
      void (async () => {
        // A finished agent's line a few seconds past its 30 s too, so the redraw that drops it happens.
        const busy = (await read($, nodes)).some(n => n.status === 'running') || (await read($, agents)).some(a => isShown(a, Date.now() - 3_000))
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
      // The cards are a timeline: each agent joins at the end, the oldest falls off past thirty.
      const card: AgentCard = { id, description: e.description || e.name || e.subagentType, type: e.subagentType, status: 'running', startedAt: Date.now(), tools: 0, last: 'starting' }
      await update($, agents, list => [...list.filter(a => a.id !== id), card].slice(-MAX_AGENTS))
      void helpersNews($)
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    const args = e as unknown as Record<string, unknown>
    // Every call of a subagent counts on its card, bookkeeping and its own helpers included.
    if (e.agentId !== undefined) {
      const owner = e.agentId
      const doing = doingOf(args)
      await update($, agents, list => list.map(a => (a.id === owner ? { ...a, tools: a.tools + 1, last: doing } : a)))
    }
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
    // Each step a subagent's model answers: its latest words go on its card.
    if (e.agentId !== undefined) {
      const r = yield* next(e)
      const id = e.agentId
      if (r.answer.trim()) {
        const said = oneLine(r.answer).slice(0, 500)
        await update($, agents, list => list.map(a => (a.id === id ? { ...a, said } : a))).catch(() => {})
      }
      return r
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
      void save($).catch(() => {})
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
      const agentId = e.agentId
      const list = await update($, agents, all =>
        all.map((a): AgentCard => (a.id === agentId ? { ...a, status: failed ? 'failed' : 'done', endedAt: Date.now(), last: failed ? `stopped: ${e.reason}` : 'finished' } : a)),
      )
      const one = list.find(a => a.id === agentId)
      if (one) $.ui.toast(`${failed ? '✗' : '✓'} ${one.description} ${failed ? 'failed' : 'done'} (${elapsed(one)} · ${one.tools} tools)`)
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
    // Kept for --continue or --resume, unless /clear ended the conversation.
    if (e.reason !== 'clear') await save($).catch(() => {})
    // The conversation is gone from this process; the whole history goes with it.
    await update($, nodes, () => [])
    await update($, treeScroll, () => ({ follow: true, off: 0 }))
    await update($, agents, list => list.filter(a => a.status === 'running')) // a background agent may run on
    await update($, agentPick, () => null)
    await update($, gridScroll, () => ({ follow: false, off: 0 }))
    paint($, 'idle', '')

    return next(e)
  })

  on('command.run', { command: 'mission' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'agents') return openAgents($)
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
    return { text: said ?? `Mission Control: ${s.agents} agents · ${s.tools} tool calls · ${(await read($, files)).length} files. w: who · c: code · a: agents · q: close` }
  })

  on('command.run', { command: 'radar' }, async $ => openAgents($))

  // Scrolling: each view is drawn to the pane's room exactly, so the engine's
  // window has nothing to move; the wheel or scroll keys move the view's own
  // window instead (the tree, the grid of cards, an agent's conversation), the
  // tabs and the crab staying in place. The code map does not scroll.
  on('ui.scroll', { requestId: PANE }, async ($, e) => {
    const w = scrollable
    if (!e.by || w === undefined) return {}
    // The grid moves a row of cards a wheel tick; a page key's rows come to as many rows of cards.
    const by = Math.abs(e.by) < w.unit ? e.by : Math.round(e.by / w.unit)
    const move = (t: { follow: boolean; off: number }) => scrolled(t, by, Math.max(0, w.total - w.rows))
    if (w.at === 'tree') await update($, treeScroll, move)
    else if (w.at === 'grid') await update($, gridScroll, move)
    else await update($, agentScroll, move)
    return {}
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
        <Button key="agents" label="Agents" hotkey="a" variant={v === 'agents' ? 'primary' : undefined} onPress={() => void showAgents($)} />
        <Button key="close" label="Close" hotkey="q" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
      </Box>
    )

    // The crab at the pane's foot, in every view: the glyph crab, the scene's
    // prop beside it, and what it says, in three rows. Its block takes its rows
    // from the view above it.
    const hidden = await read($, isCrabHidden)
    const acted = hidden ? undefined : await read($, scene)
    const ticked = hidden ? undefined : await read($, crabTick)
    const crab = acted === undefined || ticked === undefined ? undefined : sceneRows(acted.activity, ticked)
    const crabRow = crab !== undefined && acted !== undefined && (
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
    )
    // The rows a view's window has: what the tabs, the view's own `fixed` rows
    // and the crab leave of the body, at least three however short the pane.
    const windowRows = (fixed: number) => Math.max(3, rows - fixed - (crabRow ? CRAB_FOOT_ROWS : 0))
    // A view in its frame: the tabs, the view, then the crab at the foot. With the
    // crab the column is as tall as the body, and the spacer before the crab takes
    // what the view leaves. A view taller than its window adds one row of scroll
    // room: the engine raises ui.scroll only while it has rows to scroll, and the
    // hook that answers it moves the view's own window, this content staying put.
    const framed = (content: (RenderNode | false | null | undefined | '')[], isOverflow = false) => (
      <Box flexDirection="column" minHeight={isOverflow ? bodyRows + 1 : crabRow ? bodyRows : undefined}>
        {head}
        {content}
        {crabRow && <Box flexGrow={1} />}
        {crabRow && <Text>{' '}</Text>}
        {crabRow}
        {isOverflow && <Text>{' '}</Text>}
      </Box>
    )
    // Where a view's window stands, clamped to what it now holds; noted for the scroll hook.
    const place = (at: 'tree' | 'grid' | 'agent', t: { follow: boolean; off: number }, total: number, shown: number, unit = 1) => {
      scrollable = { at, total, rows: shown, unit }
      return scrolled(t, 0, Math.max(0, total - shown)).off
    }

    if (v === 'code') {
      scrollable = undefined
      if (e.surface !== 'terminal') return framed([<Text dimColor>The code map draws in the terminal.</Text>])
      const { Image } = $.ui.resolve(e)
      // A fixed 16:10 shape from the pane's width: lines coming and going above the prompt
      // change the pane's height, and must not resize (and jolt) the picture. The crab's
      // rows come off the room it may take.
      const imageRows = Math.max(3, Math.min(rows - (crabRow ? CRAB_FOOT_ROWS : 0), Math.round(columns * 0.3)))
      if (draw.size.columns !== columns || draw.size.rows !== imageRows) {
        draw.size = { columns, rows: imageRows }
        void renderSoon($)
      }
      const f = await read($, frame)
      return framed([
        f ? (
          <Image key="map" source={{ file: f.file, format: 'png', generation: f.n }} columns={draw.size.columns} rows={draw.size.rows} alt="Code map" />
        ) : (
          <Text dimColor>{draw.error || 'Drawing the code map…'}</Text>
        ),
      ])
    }

    if (v === 'agents') {
      const list = await read($, agents)
      const pick = await read($, agentPick)
      const one = list.find(a => a.id === pick)
      const width = columns
      const inView = e.props.view?.agentId // the agent whose transcript the main view shows, if any
      const choose = (id: string | null) => async () => {
        await update($, agentPick, () => id)
        await update($, agentNotice, () => null)
        await update($, agentScroll, () => ({ follow: true, off: 0 })) // each agent's messages open on their latest
      }
      const say = (text: string) => update($, agentNotice, () => text)
      const toMain = inView !== undefined && (
        <Button key="main" label="Main view" hotkey="m" onPress={async () => {
          const r = await $.ui.view({}).catch(err => ({ deny: String(err) }))
          if (r.deny) await say(`Could not go back: ${r.deny}`)
        }} />
      )

      if (one) {
        const found = await $.session.messages({ agentId: one.id })
        const all = 'deny' in found ? [] : found
        const messages = all.slice(-MAX_MESSAGES)
        const note = await read($, agentNotice)
        // The conversation as rows of one line each, cut to the pane's width, so
        // the window knows how many it holds.
        const lineWidth = Math.max(10, width - 1)
        const body: RenderNode[] = []
        if ('deny' in found) body.push(<Text dimColor>{`No conversation to show: ${found.deny}`}</Text>)
        else if (all.length === 0) body.push(<Text dimColor>No messages yet.</Text>)
        if (all.length > messages.length) body.push(<Text dimColor>{`… ${all.length - messages.length} earlier messages not shown`}</Text>)
        messages.forEach((m, i) => {
          const text = m.text.trim()
          const uses = m.role === 'assistant' ? m.toolUses : []
          if (!text && uses.length === 0) return // a row of tool results only
          if (body.length > 0) body.push(<Text> </Text>)
          if (text) {
            const who = m.role === 'assistant' ? 'agent: ' : i === 0 && all.length === messages.length ? 'task: ' : 'user: '
            wrapCells(who + text, lineWidth).forEach((line, k) =>
              body.push(
                k === 0 && line.startsWith(who) ? (
                  <Text wrap="truncate-end">
                    <Text color={m.role === 'assistant' ? 'cyan' : 'magenta'} bold>{who}</Text>
                    <Text>{line.slice(who.length)}</Text>
                  </Text>
                ) : (
                  <Text wrap="truncate-end">{line === '' ? ' ' : line}</Text>
                ),
              ),
            )
          }
          for (const u of uses) body.push(<Text dimColor wrap="truncate-end">{`  → ${doingOf({ ...u.input, tool: u.tool })}${u.isError ? ' (error)' : ''}`}</Text>)
        })
        // The window over it: at the bottom it follows new messages; scrolled up it holds its place.
        const shown = windowRows(note ? 5 : 4) // the title, what it is doing, the buttons, a notice, the rule
        const off = place('agent', await read($, agentScroll), body.length, shown)
        const above = off
        const below = Math.max(0, body.length - off - shown)
        return framed(
          [
            <Text wrap="truncate-end">
              <Text color={agentColor(one)} bold>{`${agentIcon(one)} ${one.description}`}</Text>
              <Text dimColor>{`  ${one.type} · ${elapsed(one)} · ${one.tools} tools`}</Text>
            </Text>,
            <Text dimColor wrap="truncate-end">{`now: ${one.last}`}</Text>,
            <Box flexDirection="row" gap={1}>
              <Button key="back" label="Back" hotkey="b" variant="primary" onPress={choose(null)} />
              <Button key="view" label="Open transcript" hotkey="o" onPress={async () => {
                const r = await $.ui.view({ agentId: one.id }).catch(err => ({ deny: String(err) }))
                await say(r.deny ? `Could not open it: ${r.deny}` : 'Its transcript is in the main view: your next prompt goes to it. m goes back.')
              }} />
              {one.status === 'running' && (
                <Button key="stop" label="Ask to stop" hotkey="s" onPress={async () => {
                  const r = await $.session.send({ to: { agentId: one.id }, text: STOP_TEXT }).catch(err => ({ isDelivered: false as const, reason: String(err) }))
                  await say(r.isDelivered ? 'Asked it to stop. It stops once it reads the message.' : `Not sent: ${r.reason}`)
                }} />
              )}
              {below > 0 && <Button key="end" label="Latest" hotkey="e" onPress={() => update($, agentScroll, () => ({ follow: true, off: 0 }))} />}
              {toMain}
            </Box>,
            note && <Text color="yellow" wrap="truncate-end">{note}</Text>,
            <Text dimColor>{`${'─'.repeat(Math.max(10, width - 14))}${above > 0 ? ` ↑${above}` : ''}${below > 0 ? ` ↓${below}` : ''}`}</Text>,
            ...body.slice(off, off + shown),
          ],
          body.length > shown,
        )
      }

      // The grid: a card per agent, as many a row as fit (up to three), along the
      // timeline: the first spawned at the head, the newest at the far end. Its
      // window moves a row of cards at a time and, at the bottom, follows new ones.
      const running = list.filter(a => a.status === 'running').length
      const cols = Math.max(1, Math.min(3, Math.floor(width / CARD_MIN)))
      const cardWidth = Math.floor((width - (cols - 1)) / cols) // one cell of gap between cards
      const cardRows = chunk(list, cols)
      const shown = Math.max(1, Math.floor(windowRows(2) / CARD_ROWS)) // the heading and the buttons stay
      const off = place('grid', await read($, gridScroll), cardRows.length, shown, CARD_ROWS)
      const below = Math.max(0, cardRows.length - off - shown)
      const card = (a: AgentCard, i: number) => (
        <Box flexDirection="column" width={cardWidth} borderStyle="round" borderColor={a.id === inView ? 'cyan' : 'inactive'} paddingX={1}>
          <Button key={`agent-${a.id}`} plain hotkey={i < 9 ? String(i + 1) : i === 9 ? '0' : undefined} dimColor={a.status !== 'running'} label={`${agentIcon(a)} ${a.description}`} onPress={choose(a.id)} />
          <Text dimColor wrap="truncate-end">{`${a.type} · ${elapsed(a)} · ${a.tools} tools`}</Text>
          <Text color={agentColor(a)} wrap="truncate-end">{a.status === 'done' ? 'finished' : a.last}</Text>
          <Text dimColor wrap="truncate-end">{a.said ? `“${a.said}”` : ' '}</Text>
        </Box>
      )
      return framed(
        [
          <Text bold>{`${running} running · ${list.length - running} finished${off > 0 ? ` · ↑${off * cols}` : ''}${below > 0 ? ` · ↓${Math.max(0, list.length - (off + shown) * cols)}` : ''}`}</Text>,
          <Box flexDirection="row" gap={1}>
            <Button key="clear" label="Clear finished" hotkey="x" onPress={() => update($, agents, all => all.filter(x => x.status === 'running'))} />
            {toMain}
          </Box>,
          list.length === 0 && <Text dimColor>No subagents yet this session.</Text>,
          // The digits count the cards in the window.
          ...cardRows.slice(off, off + shown).map((row, r) => (
            <Box flexDirection="row" gap={1}>
              {row.map((a, c) => card(a, r * cols + c))}
            </Box>
          )),
        ],
        cardRows.length > shown,
      )
    }

    const ls = lines(await read($, nodes), Date.now())
    const s = summary(await read($, nodes))
    // The tree's window. Scrolled up it holds its place while new lines arrive;
    // at the bottom it follows them.
    const shown = windowRows(1) // the summary line stays
    const off = place('tree', await read($, treeScroll), ls.length, shown)
    return framed(
      [
        <Text dimColor>{`${s.agents} agents (${s.running} running) · ${s.tools} tool calls${s.failed ? ` · ${s.failed} failed` : ''}${off > 0 ? ` · ↑${off}` : ''}`}</Text>,
        ls.length === 0 && <Text dimColor>Nothing yet. Start a task and watch it fill in.</Text>,
        ...ls.slice(off, off + shown).map(l => (
          <Text wrap="truncate-end">
            <Text dimColor>{l.prefix}</Text>
            <Text color={l.status === 'running' ? 'yellow' : l.status === 'failed' ? 'red' : l.node.kind === 'tool' ? undefined : 'green'} bold={l.node.kind !== 'tool'} dimColor={l.status === 'done' && l.node.kind === 'tool'}>
              {l.text}
            </Text>
          </Text>
        )),
      ],
      ls.length > shown,
    )
  })

  // The band: one summary line while Claude works, and for a short while after;
  // under it one live line per running subagent, and a ✓ for 30 s once one finishes.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e) // what other mods and Claude Code draw here stays
    await read($, now) // subscribes the band to the clock
    const list = await read($, nodes)
    const main = list.filter(n => n.kind === 'main').at(-1)
    const s = summary(list)
    const isRecent = main !== undefined && (main.status === 'running' || Date.now() - (main.end ?? 0) < BAND_AFTER_MS) && s.tools + s.agents > 0
    const working = (await read($, agents)).filter(a => isShown(a))
    if (e.props.hasSurvey || (!isRecent && working.length === 0)) return rest
    const t = await read($, turn)
    const edited = (await read($, files)).filter(f => f.changedTurn === t).length
    const { Box, Text } = $.ui.resolve(e)
    const mine = (
      <Box flexDirection="column">
        {isRecent && (
          <Text wrap="truncate-end">
            <Text color="blue" bold>{' ◈ mission: '}</Text>
            <Text>{`${s.agents ? `${s.running}/${s.agents} agents · ` : ''}${s.tools} tools${s.failed ? ` · ${s.failed} failed` : ''}${edited ? ` · ${edited} files changed` : ''}`}</Text>
            <Text dimColor>{`  ·  ${LABELS[(await read($, scene)).activity]}`}</Text>
            <Text dimColor>{'  ·  /mission'}</Text>
          </Text>
        )}
        {working.slice(-BAND_AGENTS).map(a => ( // the timeline's end: the latest at work, not its oldest
          <Text wrap="truncate-end">
            <Text color={agentColor(a)} bold>{` ${agentIcon(a)} ${a.description}`}</Text>
            <Text dimColor>{`  ${elapsed(a)} · ${a.tools} tools`}</Text>
            {a.status === 'running' && <Text>{` · ${a.last}`}</Text>}
            {a.status === 'failed' && <Text color="red">{` · ${a.last}`}</Text>}
          </Text>
        ))}
        {working.length > BAND_AGENTS && <Text dimColor>{`   +${working.length - BAND_AGENTS} more · /radar`}</Text>}
      </Box>
    )
    return stackBands(rest, 'mission-control', mine, 'above', await (bandOrder ??= readBandOrder($).catch(() => []))) // above what other mods draw, unless the band order says otherwise
  })
}

// The band order file, as the claude-code-mods checklist saves it; [] on any error.
async function readBandOrder($: EngineInterface): Promise<string[]> {
  const file = bandsFile(await $.env.get('CLAUDE_CONFIG_DIR'), await $.env.get('HOME'))
  return file && (await $.fs.exists(file)) ? parseOrder(await $.fs.read(file)) : []
}

// Saves this session's views in the store under its id: what --continue or
// --resume needs to draw them again. Only the latest sessions are kept.
async function save($: EngineInterface) {
  const id = await $.session.id()
  const list = await read($, nodes)
  const cards = await read($, agents)
  if (list.length === 0 && cards.length === 0) return
  const saved: Saved = { id, at: Date.now(), nodes: list.slice(-SAVED_NODES), agents: cards, files: await read($, files), turn: await read($, turn) }
  const all = ((await $.store.get('sessions')) as Saved[] | undefined) ?? []
  await $.store.set('sessions', [...all.filter(x => x?.id !== id), saved].slice(-SAVED_SESSIONS))
}

// A session that comes back (--continue, --resume) finds its views as it left
// them; what was running then was cut off with that process, so it reads ended.
async function restoreSaved($: EngineInterface) {
  if ((await read($, nodes)).length > 0) return // a hot reload: the views are still here
  const id = await $.session.id()
  const all = ((await $.store.get('sessions')) as Saved[] | undefined) ?? []
  const saved = all.find(x => x?.id === id)
  if (!saved) return
  const ended = <T extends { status: string }>(x: T): T => (x.status === 'running' ? { ...x, status: 'done' } : x)
  await update($, nodes, () => saved.nodes.map(n => (n.status === 'running' ? { ...ended(n), end: saved.at } : n)))
  await update($, agents, () => saved.agents.map(a => (a.status === 'running' ? { ...ended(a), endedAt: saved.at, last: 'ended with the session' } : a)))
  await update($, files, () => saved.files)
  await update($, turn, () => saved.turn)
}

type Saved = { id: string; at: number; nodes: MissionNode[]; agents: AgentCard[]; files: MapFile[]; turn: number }

// Forgets the cached band order, for tests.
export function resetBandOrder() {
  bandOrder = undefined
}

async function setCode($: EngineInterface) {
  await update($, view, () => 'code')
  await renderSoon($)
}

// The agents view, on its grid; the agents that started before this mod loaded join it.
async function showAgents($: EngineInterface) {
  await adopt($).catch(() => {})
  await update($, view, () => 'agents')
  await update($, agentPick, () => null)
  await update($, agentNotice, () => null)
}

// /radar and /mission agents: the pane open on the agents view.
async function openAgents($: EngineInterface) {
  await showAgents($)
  await $.ui.open({ id: PANE, title: 'Mission Control', focus: true })
  const list = await read($, agents)
  const running = list.filter(a => a.status === 'running').length
  return { text: `${running} running, ${list.length - running} finished` }
}

// Agents that started before this mod loaded: take them from the engine's own list.
async function adopt($: EngineInterface) {
  const known = new Set((await read($, agents)).map(a => a.id))
  const fresh = (await $.agent.list())
    .filter(a => !known.has(a.id))
    .map((a): AgentCard => ({
      id: a.id,
      description: a.description,
      type: a.type,
      status: a.status === 'running' ? 'running' : a.status === 'completed' ? 'done' : 'failed',
      startedAt: Date.now(),
      tools: 0,
      last: a.status === 'running' ? 'running (started before the view)' : a.status,
    }))
  if (fresh.length > 0) await update($, agents, list => [...list, ...fresh].slice(-MAX_AGENTS))
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
  let bin: string | undefined
  for (const p of [await $.env.get('CHROME_PATH'), ...CHROMES]) {
    if (p && (await $.fs.exists(p))) {
      bin = p
      break
    }
  }
  if (!bin) {
    draw.error = 'The code map needs Google Chrome or Chromium. Set CHROME_PATH to point at one.'
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
  const r = await $.process.run(['sh', '-c', script, 'mission-control', bin, png, `${dir}/chrome`, `${width},${height}`, `file://${encodeURI(svgPath)}`], { timeoutMs: 20_000 })
  if (r.exitCode === 0) await update($, frame, () => ({ file: png, n }))
}
