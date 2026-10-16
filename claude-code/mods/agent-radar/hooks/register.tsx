// Agent Radar: what are my subagents cooking?
//   The band above the prompt has one live line per running subagent: status, time, tool
//   count and what it is doing right now; a finished one shows a check for 30 s. A toast
//   says when each finishes. /radar opens a pane: a grid with one card per agent (two or
//   three a row when the pane is wide). A number opens that agent: its whole conversation,
//   a button that puts its transcript in the main view (the prompt then talks to it) and
//   one that asks it to stop. No call stops a subagent outright, so that is a message.
//   With mission-control on, its crab sits at the foot of this pane too, so it stays when
//   the pane's tab is switched: the scene is read from mission-control, the crab drawn here.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { RadarAgent, Scene } from '../types'
import { bandsFile, parseOrder, stackBands } from './bands'
import { CRAB_WIDTH, LABELS, sceneRows } from './crab'

const PANE = 'agent-radar'
const SHOW_DONE_MS = 30_000 // a finished agent stays in the band this long
const BAND_ROWS = 4
const CARD_MIN = 40 // a grid column is at least this wide
const MAX_MESSAGES = 200 // an agent's page shows its last this many messages
const STOP_TEXT = 'Please stop: finish the step you are on, start nothing new, and reply with what you have so far.'
const TICK_MS = 600 // the crab's animation, as in mission-control
const ONE_LINE = 60 // a crab detail up to this long is taken to fit on one line

// The crab's scene, and whether /mission crab hid it, are mission-control's: any mod may read them,
// only it writes them. They are not in this mod's contract, so the refs are cast where read.
const missionScene = { plugin: 'mission-control', key: 'scene' } as const
const missionHidden = { plugin: 'mission-control', key: 'isCrabHidden' } as const

// Held by the host, so the radar survives a hot reload of this file.
const agents = atom({ plugin: 'agent-radar', key: 'agents' } as const, [] as RadarAgent[])
const selected = atom({ plugin: 'agent-radar', key: 'selected' } as const, null as string | null)
const now = atom({ plugin: 'agent-radar', key: 'now' } as const, 0)
const notice = atom({ plugin: 'agent-radar', key: 'notice' } as const, null as string | null) // what the last button press came to
const crabTick = atom({ plugin: 'agent-radar', key: 'crabTick' } as const, 0) // the crab's animation, ticking only while this pane is up

let bandOrder: Promise<string[]> | undefined // read once per session: restart to apply

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'radar', description: 'Show what each subagent is doing, in the Agent Radar pane' }).catch(() => {}) // a name Claude Code already has is refused: start anyway
    // A clock for the elapsed times, ticking only while something runs.
    $.clock.every(1000, () => {
      void (async () => {
        // A few seconds past the 30 s too, so the redraw that drops a finished line happens.
        if ((await read($, agents)).some(a => isShown(a, Date.now() - 3_000))) await update($, now, () => Date.now())
      })().catch(() => {})
    })
    // The crab's tick, only while the pane is up, so nothing animates unseen.
    $.clock.every(TICK_MS, () => {
      void (async () => {
        if ((await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)) await update($, crabTick, tick => (tick + 1) % 60)
      })().catch(() => {})
    })
    return r
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId) {
      const id = r.agentId
      const one: RadarAgent = { id, description: e.description || e.name || e.subagentType, type: e.subagentType, status: 'running', startedAt: Date.now(), tools: 0, last: 'starting' }
      await update($, agents, list => [one, ...list.filter(a => a.id !== id)].slice(0, 30))
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId) {
      const id = e.agentId
      const line = describe(e as unknown as Record<string, unknown>)
      await update($, agents, list => list.map(a => (a.id === id ? { ...a, tools: a.tools + 1, last: line } : a)))
    }
    return next(e)
  })

  // Each step a subagent's model answers: keep its latest words for its card.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (e.agentId && r.answer.trim()) {
      const id = e.agentId
      const said = oneLine(r.answer).slice(0, 500)
      await update($, agents, list => list.map(a => (a.id === id ? { ...a, said } : a))).catch(() => {})
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) {
      const id = e.agentId
      const failed = e.reason === 'error' || e.reason === 'aborted'
      const list = await update($, agents, all =>
        all.map((a): RadarAgent => (a.id === id ? { ...a, status: failed ? 'failed' : 'done', endedAt: Date.now(), last: failed ? `stopped: ${e.reason}` : 'finished' } : a)),
      )
      const one = list.find(a => a.id === id)
      if (one) $.ui.toast(`${failed ? '✗' : '✓'} ${one.description} ${failed ? 'failed' : 'done'} (${elapsed(one)} · ${one.tools} tools)`)
    }
    return r
  })

  on('command.run', { command: 'radar' }, async $ => {
    await adopt($)
    await update($, selected, () => null)
    await update($, notice, () => null)
    await $.ui.open({ id: PANE, title: 'Agent Radar', focus: true })
    const list = await read($, agents)
    const running = list.filter(a => a.status === 'running').length
    return { text: `${running} running, ${list.length - running} finished` }
  })

  // The band: one live line per running agent, and a ✓ for 30 s once one finishes.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e) // what other mods and Claude Code draw here stays
    await read($, now) // subscribes the band to the clock
    const shown = (await read($, agents)).filter(a => isShown(a))
    if (e.props.hasSurvey || shown.length === 0) return rest
    const { Box, Text } = $.ui.resolve(e)
    const mine = (
      <Box flexDirection="column">
        {shown.slice(0, BAND_ROWS).map(a => (
          <Text wrap="truncate-end">
            <Text color={color(a)} bold>{` ${icon(a)} ${a.description}`}</Text>
            <Text dimColor>{`  ${elapsed(a)} · ${a.tools} tools`}</Text>
            {a.status === 'running' && <Text>{` · ${a.last}`}</Text>}
            {a.status === 'failed' && <Text color="red">{` · ${a.last}`}</Text>}
          </Text>
        ))}
        {shown.length > BAND_ROWS && <Text dimColor>{`   +${shown.length - BAND_ROWS} more · /radar`}</Text>}
      </Box>
    )
    return stackBands(rest, 'agent-radar', mine, 'above', await (bandOrder ??= readBandOrder($).catch(() => []))) // above what other mods draw, unless the band order says otherwise
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    await read($, now) // subscribes the pane to the clock
    const list = await read($, agents)
    const pick = await read($, selected)
    const one = list.find(a => a.id === pick)
    const width = e.props.bodyColumns
    const inView = e.props.view?.agentId // the agent whose transcript the main view shows, if any
    const choose = (id: string | null) => async () => {
      await update($, selected, () => id)
      await update($, notice, () => null)
    }
    const say = (text: string) => update($, notice, () => text)
    const toMain = inView !== undefined && (
      <Button key="main" label="Main view" hotkey="m" onPress={async () => {
        const r = await $.ui.view({}).catch(err => ({ deny: String(err) }))
        if (r.deny) await say(`Could not go back: ${r.deny}`)
      }} />
    )

    // mission-control's crab at the foot of either page. With it the column is as tall as the body and
    // the spacer takes what the page leaves, so the crab sits at the foot. Nothing without a scene
    // (mission-control is off) or after /mission crab hid it.
    const scene = (await read($, missionScene as never)) as Scene | undefined
    const isCrabHidden = (await read($, missionHidden as never)) === true
    const tick = await read($, crabTick)
    const bodyRows = e.props.scroll?.bodyRows ?? 30
    const withCrab = (page: RenderElement) => {
      if (scene === undefined || isCrabHidden) return page
      const detail = scene.detail ?? ''
      const crab = sceneRows(scene.activity, tick)
      return (
        <Box flexDirection="column" minHeight={bodyRows}>
          {page}
          <Box flexGrow={1} />
          <Text>{' '}</Text>
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
                {LABELS[scene.activity] ?? scene.activity}
              </Text>
              <Text dimColor wrap={detail.length <= ONE_LINE ? 'truncate-end' : 'wrap'}>
                {detail === '' ? ' ' : detail}
              </Text>
            </Box>
          </Box>
        </Box>
      )
    }

    if (one) {
      const found = await $.session.messages({ agentId: one.id })
      const all = 'deny' in found ? [] : found
      const messages = all.slice(-MAX_MESSAGES)
      const note = await read($, notice)
      return withCrab(
        <Box flexDirection="column">
          <Text>
            <Text color={color(one)} bold>{`${icon(one)} ${one.description}`}</Text>
            <Text dimColor>{`  ${one.type} · ${elapsed(one)} · ${one.tools} tools`}</Text>
          </Text>
          <Text dimColor wrap="truncate-end">{`now: ${one.last}`}</Text>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
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
            <Button key="end" label="Latest" hotkey="e" onPress={() => $.ui.scroll({ in: PANE, to: 'end' })} />
            {toMain}
            <Button key="close" label="Close" hotkey="q" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
          </Box>
          {note && <Text color="yellow">{note}</Text>}
          <Text dimColor>{'─'.repeat(Math.max(10, width - 2))}</Text>
          {'deny' in found && <Text dimColor>{`No conversation to show: ${found.deny}`}</Text>}
          {!('deny' in found) && all.length === 0 && <Text dimColor>No messages yet.</Text>}
          {all.length > messages.length && <Text dimColor>{`… ${all.length - messages.length} earlier messages not shown`}</Text>}
          {messages.map((m, i) => {
            const text = m.text.trim()
            const uses = m.role === 'assistant' ? m.toolUses : []
            if (!text && uses.length === 0) return null // a row of tool results only
            const who = m.role === 'assistant' ? 'agent: ' : i === 0 && all.length === messages.length ? 'task: ' : 'user: '
            return (
              <Box flexDirection="column" marginTop={i > 0 ? 1 : 0}>
                {text && (
                  <Text>
                    <Text color={m.role === 'assistant' ? 'cyan' : 'magenta'} bold>{who}</Text>
                    <Text>{text}</Text>
                  </Text>
                )}
                {uses.map(u => (
                  <Text dimColor wrap="truncate-end">{`  → ${describe({ ...u.input, tool: u.tool })}${u.isError ? ' (error)' : ''}`}</Text>
                ))}
              </Box>
            )
          })}
        </Box>,
      )
    }

    // The grid: a card per agent, as many a row as fit (up to three), the newest
    // first. Every card is drawn; past the pane's height the engine's scroll
    // window carries the rest (the pane's keys scroll it while focused).
    const running = list.filter(a => a.status === 'running').length
    const cols = Math.max(1, Math.min(3, Math.floor(width / CARD_MIN)))
    const cardWidth = Math.floor((width - (cols - 1)) / cols) // one cell of gap between cards
    const card = (a: RadarAgent, i: number) => (
      <Box flexDirection="column" width={cardWidth} borderStyle="round" borderColor={a.id === inView ? 'cyan' : 'inactive'} paddingX={1}>
        <Button key={`agent-${a.id}`} plain hotkey={i < 9 ? String(i + 1) : i === 9 ? '0' : undefined} dimColor={a.status !== 'running'} label={`${icon(a)} ${a.description}`} onPress={choose(a.id)} />
        <Text dimColor wrap="truncate-end">{`${a.type} · ${elapsed(a)} · ${a.tools} tools`}</Text>
        <Text color={color(a)} wrap="truncate-end">{a.status === 'done' ? 'finished' : a.last}</Text>
        {a.said && <Text dimColor wrap="truncate-end">{`“${a.said}”`}</Text>}
      </Box>
    )
    return withCrab(
      <Box flexDirection="column">
        <Text bold>{`${running} running · ${list.length - running} finished${Math.ceil(list.length / cols) * 6 > bodyRows ? ' · ↑↓ scroll' : ''}`}</Text>
        {list.length === 0 && <Text dimColor>No subagents yet this session.</Text>}
        {chunk(list, cols).map((row, r) => (
          <Box flexDirection="row" gap={1}>
            {row.map((a, c) => card(a, r * cols + c))}
          </Box>
        ))}
        <Box flexDirection="row" gap={1}>
          <Button key="clear" label="Clear finished" hotkey="c" onPress={() => update($, agents, all => all.filter(x => x.status === 'running'))} />
          {toMain}
          <Button key="close" label="Close" hotkey="q" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>,
    )
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

// Agents that started before this mod loaded: take them from the engine's own list.
async function adopt($: EngineInterface) {
  const known = new Set((await read($, agents)).map(a => a.id))
  const fresh = (await $.agent.list())
    .filter(a => !known.has(a.id))
    .map((a): RadarAgent => ({
      id: a.id,
      description: a.description,
      type: a.type,
      status: a.status === 'running' ? 'running' : a.status === 'completed' ? 'done' : 'failed',
      startedAt: Date.now(),
      tools: 0,
      last: a.status === 'running' ? 'running (started before the radar)' : a.status,
    }))
  if (fresh.length > 0) await update($, agents, list => [...list, ...fresh])
}

// Running, or finished in the last 30 s.
export function isShown(a: RadarAgent, at = Date.now()) {
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

function icon(a: RadarAgent) {
  return a.status === 'running' ? '●' : a.status === 'done' ? '✓' : '✗'
}

function color(a: RadarAgent) {
  return a.status === 'running' ? 'yellow' : a.status === 'done' ? 'green' : 'red'
}

export function elapsed(a: Pick<RadarAgent, 'startedAt' | 'endedAt'>, at = Date.now()) {
  const s = Math.max(0, Math.round(((a.endedAt ?? at) - a.startedAt) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

// A short label for one tool call: what a person would say the agent is doing.
export function describe(e: Record<string, unknown>): string {
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
