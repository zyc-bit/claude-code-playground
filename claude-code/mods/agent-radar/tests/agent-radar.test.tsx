import { describe, expect, mock, test } from 'claude-code/testing'

import { chunk, describe as label, elapsed, isShown, oneLine, resetBandOrder } from '../hooks/register'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120 } }
const PANE = { component: 'Pane', requestId: 'agent-radar', props: { title: 'Agent Radar', isFocused: true, bodyColumns: 100, placement: 'dock' } }

const SWEEP = [{ role: 'user', text: 'Run the sweep', toolUses: [] }, { role: 'assistant', text: 'Sweep is at trial 12 of 40.', toolUses: [] }]

// What mission-control holds for the crab: its scene, and whether /mission crab hid it. The radar only reads them.
type Mission = { scene?: unknown; hidden?: boolean }

// Stands for the engine beneath the mod. Spawns answer the `ids` in turn; `messages` answers each agent's conversation;
// `mission` is what mission-control holds, and `isClocked` gives the mod a clock the test can move.
function engine(on: any, files: Record<string, string> = {}, beneath?: unknown, ids = ['a1'], messages: (agentId: string) => unknown[] = () => SWEEP, mission: Mission = {}, isClocked = false) {
  const toasts: string[] = []
  let spawned = 0
  resetBandOrder()
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('fs.exists', (_$: any, e: any) => ({ value: e.path in files }))
  on('fs.read', (_$: any, e: any) => ({ value: files[e.path] ?? '' }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  const clock = isClocked ? mock.clock(on) : (on('clock.every', () => ({ value: { cancel: () => {} } })), undefined)
  // Another mod's values: only its two keys are answered, the mod's own go to the kit.
  on('state.get', { plugin: 'mission-control', key: 'scene' }, () => ({ value: { value: mission.scene, version: mission.scene === undefined ? 0 : 1 } }))
  on('state.get', { plugin: 'mission-control', key: 'isCrabHidden' }, () => ({ value: { value: mission.hidden, version: mission.hidden === undefined ? 0 : 1 } }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: ids[spawned++ % ids.length] }))
  on('agent.list', () => ({ value: [] }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'agent-radar', title: 'Agent Radar', isShown: true, isFocused: true, isPlaced: true }] }))
  on('ui.toast', (_$: any, e: any) => (toasts.push(e.text), { value: undefined }))
  on('ui.render', ($: any, e: any) => beneath ?? $.ui.resolve(e).Text({ children: 'band below' }))
  on('session.messages', (_$: any, e: any) => ({ value: messages(e.agentId) }))
  return { toasts, clock }
}

// The grid's rows: Boxes in a row whose children are all bordered cards.
function cardRows(root: any): any[] {
  return (root.children ?? []).filter((c: any) => c?.type === 'Box' && c.props?.flexDirection === 'row' && c.children?.length > 0 && c.children.every((k: any) => k?.props?.borderStyle === 'round'))
}

describe('agent-radar', () => {
  test('helpers', () => {
    expect(elapsed({ startedAt: 0, endedAt: 252_000 })).toBe('4m 12s')
    expect(elapsed({ startedAt: 0, endedAt: 9_000 })).toBe('9s')
    expect(label({ tool: 'mcp__plugin_playwright_playwright__browser_click' })).toBe('browser: click')
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([], 3)).toEqual([])
    expect(oneLine('  two\n\nlines  ')).toBe('two lines')
    const done = (ago: number) => ({ id: 'x', description: 'd', type: 't', status: 'done' as const, startedAt: 0, endedAt: Date.now() - ago, tools: 0, last: '' })
    expect(isShown(done(5_000))).toBe(true)
    expect([done(600_000)].filter(a => isShown(a))).toEqual([]) // gone after 30 s
  })

  test('a spawned agent shows in the pane, opens to its messages, and toasts when done', async ($, on) => {
    const { toasts } = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.agent.spawn({ prompt: 'run it', description: 'sweep runner' } as any)

    const band = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: / ● sweep runner/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /band below/ })).toBeDefined()
    // the radar sits on top: what other mods draw stays below it
    const root: any = await band.drawn()
    expect(root.props.key).toBe('bands')
    expect(root.children.map((c: any) => c.props?.key)).toEqual(['band:agent-radar', undefined])

    const r = await $.command.run({ command: 'radar', args: '' } as any)
    expect(r.text).toBe('1 running, 0 finished')

    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ type: 'Text', text: /1 running · 0 finished/ })).toBeDefined()
    expect(await ui.find({ key: 'agent-a1' })).toBeDefined()

    await ui.press({ key: 'agent-a1' })
    expect(await ui.find({ type: 'Text', text: /Sweep is at trial 12 of 40/ })).toBeDefined()
    await ui.press({ key: 'back' })

    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1, agentId: 'a1' } as any)
    expect(toasts[0]).toMatch(/^✓ sweep runner done \(\d+s · 0 tools\)$/)
    expect(await ui.find({ type: 'Text', text: /0 running · 1 finished/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: / ✓ sweep runner/ })).toBeDefined() // still shown for 30 s
    await ui.unmount()
    await band.unmount()
  })

  test('the pane is a grid of cards; an agent page shows its whole conversation, opens its transcript and asks it to stop', async ($, on) => {
    const long = `Step one done. ${'x'.repeat(600)} END`
    engine(on, {}, undefined, ['a1', 'a2'], id =>
      id === 'a1'
        ? [
            { role: 'user', text: 'Read the repo', toolUses: [] },
            ...Array.from({ length: 8 }, (_, i) => ({ role: 'assistant', text: `note ${i}`, toolUses: [{ tool_use_id: `t${i}`, tool: 'Read', input: { file_path: `/w/src/f${i}.ts` } }] })),
            { role: 'assistant', text: long, toolUses: [] },
          ]
        : [],
    )
    const views: unknown[] = []
    const sent: any[] = []
    on('ui.view', (_$: any, e: any) => (views.push(e), { value: {} }))
    on('ui.scroll', () => ({}))
    on('session.send', (_$: any, e: any) => (sent.push(e), { isDelivered: true }))
    on('turn.step', async function* (_$: any, e: any) {
      return { turnId: e.turnId, index: e.index, answer: 'Halfway through the scan.\nMore soon.', toolUses: [], stopReason: 'end_turn', usage: null } as never
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.agent.spawn({ prompt: 'scan', description: 'repo scanner' } as any)
    await $.agent.spawn({ prompt: 'test', description: 'test runner' } as any)
    for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'sonnet', messageCount: 1, agentId: 'a1' } as any)) {
      // read the whole stream
    }
    await $.command.run({ command: 'radar', args: '' } as any)

    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', ...PANE } as any)
    // 100 columns: two cards a row, newest first, each with its latest words
    expect(await ui.find({ key: 'agent-a2' })).toBeDefined()
    expect(await ui.find({ key: 'agent-a1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '“Halfway through the scan. More soon.”' })).toBeDefined()
    expect(cardRows(await ui.drawn()).map(r => r.children.length)).toEqual([2])

    await ui.press({ key: 'agent-a1' })
    // every message, untruncated, with the tool calls under each
    expect(await ui.find({ type: 'Text', text: 'note 0' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'note 7' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: long })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  → reading src/f3.ts' })).toBeDefined()

    await ui.press({ key: 'view' })
    expect(views).toEqual([{ agentId: 'a1' }])
    expect(await ui.find({ type: 'Text', text: /your next prompt goes to it/ })).toBeDefined()

    await ui.press({ key: 'stop' })
    expect(sent.map(s => s.to)).toEqual(['a1'])
    expect(sent[0].text).toMatch(/^Please stop/)
    expect(await ui.find({ type: 'Text', text: /Asked it to stop/ })).toBeDefined()

    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Text', text: /2 running · 0 finished/ })).toBeDefined()
    await ui.unmount()
  })

  test('past nine agents every card is drawn, for the pane to scroll', async ($, on) => {
    engine(on, {}, undefined, ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11', 'a12'])
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    for (let i = 0; i < 12; i++) await $.agent.spawn({ prompt: 'p', description: `unit ${i + 1}` } as any)
    await $.command.run({ command: 'radar', args: '' } as any)
    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', ...PANE } as any)
    expect(cardRows(await ui.drawn()).map(r => r.children.length)).toEqual([2, 2, 2, 2, 2, 2]) // all twelve, two a row
    expect(await ui.find({ type: 'Text', text: /older/ })).toBeUndefined() // nothing folded away
    expect(await ui.find({ type: 'Text', text: /↑↓ scroll/ })).toBeDefined() // taller than the pane
    const tenth: any = await ui.find({ key: 'agent-a3' }) // newest first: the tenth card is a3
    expect(tenth?.props?.hotkey ?? tenth?.hotkey).toBe('0') // the tenth key on the row of digits
    const last: any = await ui.find({ key: 'agent-a1' }) // the twelfth card, last spawned
    expect(last?.props?.hotkey ?? last?.hotkey).toBeUndefined() // no digit left for it: Tab reaches it
    await ui.unmount()
  })

  test('a narrow pane draws one card a row, and a finished agent has no stop button', async ($, on) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.agent.spawn({ prompt: 'run it', description: 'sweep runner' } as any)
    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1, agentId: 'a1' } as any)
    await $.command.run({ command: 'radar', args: '' } as any)
    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 50 } } as any)
    expect(cardRows(await ui.drawn()).map(r => r.children.length)).toEqual([1])
    await ui.press({ key: 'agent-a1' })
    expect(await ui.find({ key: 'view' })).toBeDefined()
    expect(await ui.find({ key: 'stop' })).toBeUndefined()
    await ui.unmount()
  })

  test("mission-control's crab sits at the foot of the grid and of an agent page, and moves on this pane's own tick", async ($, on) => {
    const mission: Mission = { scene: { activity: 'reading', detail: 'src/pages/login.tsx' } }
    const { clock } = engine(on, {}, undefined, ['a1'], () => SWEEP, mission, true)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.agent.spawn({ prompt: 'run it', description: 'sweep runner' } as any)
    await $.command.run({ command: 'radar', args: '' } as any)
    const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 30 } } } as any)

    // the grid: its scene's words and detail, the crab in the middle of its field
    expect(await ui.find({ type: 'Text', text: /^Claude is reading/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'src/pages/login.tsx' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  ▐▛███▜▌  ' })).toBeDefined()
    expect(await ui.find({ key: 'agent-a1' })).toBeDefined() // the page is still there
    // the column is as tall as the body, and the spacer before the crab pushes it to the foot
    const root: any = await ui.drawn()
    expect(root.props.minHeight).toBe(30)
    const kids = (root.children as any[]).filter(c => c !== false && c != null)
    expect(kids.map(c => c.props?.flexGrow)).toEqual([undefined, 1, undefined, undefined]) // page, spacer, blank row, crab
    expect(kids[0].props.flexDirection).toBe('column')

    // an agent's page has it too
    await ui.press({ key: 'agent-a1' })
    expect(await ui.find({ type: 'Text', text: /Sweep is at trial 12 of 40/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Claude is reading/ })).toBeDefined()
    await ui.press({ key: 'back' })

    // the radar ticks its own crab while its pane is up (the next frame: legs swapped, shifted a cell)
    await clock!.advance(600)
    expect(await ui.find({ type: 'Text', text: '   ▐▛███▜▌ ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  ▐▛███▜▌  ' })).toBeUndefined()
    await ui.unmount()
  })

  test('no crab without mission-control, or after /mission crab hid it; an unknown scene still draws', async ($, on) => {
    const mission: Mission = {}
    engine(on, {}, undefined, ['a1'], () => SWEEP, mission)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.agent.spawn({ prompt: 'run it', description: 'sweep runner' } as any)
    await $.command.run({ command: 'radar', args: '' } as any)
    const draw = async () => {
      const ui = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', ...PANE } as any)
      const root: any = await ui.drawn()
      const crab = await ui.find({ type: 'Text', text: /▐/ })
      await ui.unmount()
      return { root, crab }
    }
    // mission-control is off: nothing was ever written under its name
    let seen = await draw()
    expect(seen.crab).toBeUndefined()
    expect(seen.root.props.minHeight).toBeUndefined()
    // it is on, but the crab is hidden
    mission.scene = { activity: 'coding', detail: 'x' }
    mission.hidden = true
    seen = await draw()
    expect(seen.crab).toBeUndefined()
    // shown again, with a scene this copy does not know: the name stands in for the words, no prop
    mission.hidden = false
    mission.scene = { activity: 'levitating', detail: '' }
    seen = await draw()
    expect(seen.crab).toBeDefined()
    expect(seen.root.props.minHeight).toBe(30)
  })

  test('follows the band order file', async ($, on) => {
    // another band mod drew its column beneath
    const beneath = {
      type: 'Box',
      props: { key: 'bands', flexDirection: 'column' },
      children: [{ type: 'Box', props: { key: 'band:where-am-i' }, children: [{ type: 'Text', children: ['here'] }] }],
    }
    engine(on, { '/home/me/.claude/claude-code-mods/bands.json': '{"order":["where-am-i","agent-radar"]}' }, beneath)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.agent.spawn({ prompt: 'run it', description: 'sweep runner' } as any)
    const band = await $.ui.mount({ plugin: 'agent-radar', surface: 'terminal', ...BAND } as any)
    const root: any = await band.drawn()
    expect(root.children.map((c: any) => c.props.key)).toEqual(['band:where-am-i', 'band:agent-radar'])
    await band.unmount()
  })
})
