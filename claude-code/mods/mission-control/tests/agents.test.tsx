import { describe, expect, mock, test } from 'claude-code/testing'

import { chunk, doingOf, elapsed, isShown, oneLine, wrapCells } from '../hooks/agents'
import { resetBandOrder } from '../hooks/register'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120 } }
const PANE = { component: 'Pane', requestId: 'mission-control', props: { title: 'Mission Control', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } } }

const SWEEP = [{ role: 'user', text: 'Run the sweep', toolUses: [] }, { role: 'assistant', text: 'Sweep is at trial 12 of 40.', toolUses: [] }]

// Stands for the engine beneath the mod. Spawns answer the `ids` in turn; `messages` answers each agent's conversation.
function engine(on: any, ids = ['a1'], messages: (agentId: string) => unknown[] = () => SWEEP) {
  const toasts: string[] = []
  let spawned = 0
  resetBandOrder()
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ value: '' }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  const clock = mock.clock(on)
  on('agent.spawn', () => ({ model: 'sonnet', agentId: ids[spawned++ % ids.length] }))
  on('agent.list', () => ({ value: [] }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'mission-control', title: 'Mission Control', isShown: true, isFocused: true, isPlaced: true }] }))
  on('ui.toast', (_$: any, e: any) => (toasts.push(e.text), { value: undefined }))
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'band below' }))
  on('session.messages', (_$: any, e: any) => ({ value: messages(e.agentId) }))
  return { toasts, clock }
}

// The grid's rows: Boxes in a row whose children are all bordered cards.
function cardRows(root: any): any[] {
  return (root.children ?? []).filter((c: any) => c?.type === 'Box' && c.props?.flexDirection === 'row' && c.children?.length > 0 && c.children.every((k: any) => k?.props?.borderStyle === 'round'))
}

// A wheel over the pane: `by` rows, negative toward the top.
function wheel($: any, by: number) {
  return $.ui.scroll({ component: 'Pane', requestId: 'mission-control', offset: 0, by, bodyRows: 30, contentRows: 31, origin: { kind: 'person' } } as any)
}

describe('mission-control agents view', () => {
  test('helpers', () => {
    expect(elapsed({ startedAt: 0, endedAt: 252_000 })).toBe('4m 12s')
    expect(elapsed({ startedAt: 0, endedAt: 9_000 })).toBe('9s')
    expect(doingOf({ tool: 'mcp__plugin_playwright_playwright__browser_click' })).toBe('browser: click')
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([], 3)).toEqual([])
    expect(oneLine('  two\n\nlines  ')).toBe('two lines')
    const done = (ago: number) => ({ id: 'x', description: 'd', type: 't', status: 'done' as const, startedAt: 0, endedAt: Date.now() - ago, tools: 0, last: '' })
    expect(isShown(done(5_000))).toBe(true)
    expect([done(600_000)].filter(a => isShown(a))).toEqual([]) // gone after 30 s
    // lines cut at a space, wide characters counted as two cells
    expect(wrapCells('one two three four', 9)).toEqual(['one two', 'three', 'four'])
    expect(wrapCells('中文中文中文', 6)).toEqual(['中文中', '文中文'])
    expect(wrapCells('a\n\nb', 10)).toEqual(['a', '', 'b'])
  })

  test('/radar opens the agents tab; a card opens to its messages, and a toast says when it is done', async ($, on) => {
    const { toasts } = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.turn.start({ text: 'sweep', turnId: 't1' } as any)
    await $.agent.spawn({ prompt: 'run it', description: 'sweep runner' } as any)

    const band = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: / ● sweep runner/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /band below/ })).toBeDefined()

    const r = await $.command.run({ command: 'radar', args: '' } as any)
    expect(r.text).toBe('1 running, 0 finished')

    const ui = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ key: 'agents' })).toBeDefined() // the tabs stay
    expect(await ui.find({ type: 'Text', text: /1 running · 0 finished/ })).toBeDefined()
    expect(await ui.find({ key: 'agent-a1' })).toBeDefined()

    await ui.press({ key: 'agent-a1' })
    expect(await ui.find({ type: 'Text', text: /Sweep is at trial 12 of 40/ })).toBeDefined()
    await ui.press({ key: 'back' })

    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1, agentId: 'a1' } as any)
    expect(toasts[0]).toMatch(/^✓ sweep runner done \(\d+s · 0 tools\)$/)
    expect(await ui.find({ type: 'Text', text: /0 running · 1 finished/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: / ✓ sweep runner/ })).toBeDefined() // still shown for 30 s

    // the tabs move between the views, and back to the grid
    await ui.press({ key: 'who' })
    expect(await ui.find({ type: 'Text', text: /● sweep runner/ })).toBeDefined() // the who tree has it too
    expect(await ui.find({ key: 'agent-a1' })).toBeUndefined()
    await ui.press({ key: 'agents' })
    expect(await ui.find({ key: 'agent-a1' })).toBeDefined()
    await ui.unmount()
    await band.unmount()
  })

  test('/mission agents opens the same tab', async ($, on) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.agent.spawn({ prompt: 'run it', description: 'sweep runner' } as any)
    await $.command.run({ command: 'mission', args: 'agents' } as any)
    const ui = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...PANE } as any)
    expect(await ui.find({ key: 'agent-a1' })).toBeDefined()
    await ui.unmount()
  })

  test("an agent's page shows its whole conversation, opens its transcript and asks it to stop", async ($, on) => {
    const long = `Step one done. ${'x'.repeat(300)} END`
    engine(on, ['a1', 'a2'], id =>
      id === 'a1'
        ? [
            { role: 'user', text: 'Read the repo', toolUses: [] },
            ...Array.from({ length: 3 }, (_, i) => ({ role: 'assistant', text: `note ${i}`, toolUses: [{ tool_use_id: `t${i}`, tool: 'Read', input: { file_path: `/w/src/f${i}.ts` } }] })),
            { role: 'assistant', text: long, toolUses: [] },
          ]
        : [],
    )
    const views: unknown[] = []
    const sent: any[] = []
    on('ui.view', (_$: any, e: any) => (views.push(e), { value: {} }))
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

    const ui = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 40 } } } as any)
    // 100 columns: two cards a row, each with its latest words
    expect(await ui.find({ type: 'Text', text: '“Halfway through the scan. More soon.”' })).toBeDefined()
    expect(cardRows(await ui.drawn()).map(r => r.children.length)).toEqual([2])

    await ui.press({ key: 'agent-a1' })
    // every message, the long one over several lines, with the tool calls under each
    expect(await ui.find({ type: 'Text', text: 'note 0' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'note 2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /END$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  → reading src/f1.ts' })).toBeDefined()

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

  test('the band shows the latest agents at work, along the timeline', async ($, on) => {
    engine(on, ['a1', 'a2', 'a3', 'a4', 'a5'])
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    for (let i = 0; i < 5; i++) await $.agent.spawn({ prompt: 'p', description: `unit ${i + 1}` } as any)
    const band = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: /● unit 5/ })).toBeDefined() // the newest at work
    expect(await band.find({ type: 'Text', text: /● unit 2/ })).toBeDefined() // back to it
    expect(await band.find({ type: 'Text', text: /● unit 1/ })).toBeUndefined() // folded away, one row over
    expect(await band.find({ type: 'Text', text: /\+1 more · \/radar/ })).toBeDefined()
    await band.unmount()
  })

  test('past a windowful of agents the grid scrolls, no pages, the tabs and the crab staying put', async ($, on) => {
    engine(on, Array.from({ length: 12 }, (_, i) => `a${i + 1}`))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    for (let i = 0; i < 12; i++) await $.agent.spawn({ prompt: 'p', description: `unit ${i + 1}` } as any)
    await $.command.run({ command: 'radar', args: '' } as any)
    const ui = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...PANE } as any) // 30 rows: three rows of cards beside the crab
    expect(cardRows(await ui.drawn()).map(r => r.children.length)).toEqual([2, 2, 2])
    expect(await ui.find({ key: 'agent-a1' })).toBeDefined() // first spawned at the head
    expect(await ui.find({ key: 'agent-a7' })).toBeUndefined() // below the window
    expect(await ui.find({ key: 'older' })).toBeUndefined() // no page buttons
    expect(await ui.find({ type: 'Text', text: /↓6/ })).toBeDefined() // it says what is below
    const root: any = await ui.drawn()
    expect(root.props.minHeight).toBe(31) // a row of scroll room, so the wheel reaches the hook

    await wheel($, 1) // a tick down: one row of cards
    expect(await ui.find({ key: 'agent-a1' })).toBeUndefined()
    expect(await ui.find({ key: 'agent-a7' })).toBeDefined()
    const first: any = await ui.find({ key: 'agent-a3' })
    expect(first?.props?.hotkey ?? first?.hotkey).toBe('1') // the digits count within the window
    await wheel($, 30) // a page key: as far as it goes
    expect(await ui.find({ key: 'agent-a12' })).toBeDefined() // the newest at the far end
    expect(await ui.find({ type: 'Text', text: /↑6/ })).toBeDefined()
    expect(await ui.find({ key: 'agents' })).toBeDefined() // the tabs never move
    expect(await ui.find({ type: 'Text', text: /▐/ })).toBeDefined() // nor the crab
    await wheel($, -2) // two ticks up: two rows of cards
    expect(await ui.find({ key: 'agent-a3' })).toBeDefined()
    expect(await ui.find({ key: 'agent-a1' })).toBeUndefined()
    await wheel($, -1)
    expect(await ui.find({ key: 'agent-a1' })).toBeDefined() // back along the timeline
    await ui.unmount()
  })

  test("an agent's conversation scrolls, following its newest lines until scrolled up", async ($, on) => {
    let convo = [
      { role: 'user', text: 'task zero', toolUses: [] },
      ...Array.from({ length: 20 }, (_, i) => ({ role: 'assistant', text: `note ${i}`, toolUses: [] })),
      { role: 'assistant', text: 'the last word', toolUses: [] },
    ]
    engine(on, ['a1'], () => convo)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.agent.spawn({ prompt: 'p', description: 'unit' } as any)
    await $.command.run({ command: 'radar', args: '' } as any)
    const ui = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...PANE } as any)
    await ui.press({ key: 'agent-a1' })
    expect(await ui.find({ type: 'Text', text: 'the last word' })).toBeDefined() // it opens on the latest
    expect(await ui.find({ type: 'Text', text: /task zero/ })).toBeUndefined()
    expect(await ui.find({ key: 'older' })).toBeUndefined() // no page buttons
    expect(await ui.find({ key: 'end' })).toBeUndefined() // at the latest already

    await wheel($, -100) // to the top
    expect(await ui.find({ type: 'Text', text: /task zero/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'the last word' })).toBeUndefined()
    expect(await ui.find({ key: 'back' })).toBeDefined() // the buttons never move
    expect(await ui.find({ type: 'Text', text: /▐/ })).toBeDefined() // nor the crab

    // scrolled up, a new message moves it not
    convo = [...convo, { role: 'assistant', text: 'one more', toolUses: [] }]
    await $.agent.spawn({ prompt: 'p', description: 'unit' } as any) // anything that redraws
    expect(await ui.find({ type: 'Text', text: /task zero/ })).toBeDefined()

    await ui.press({ key: 'end' })
    expect(await ui.find({ type: 'Text', text: 'one more' })).toBeDefined()
    await ui.unmount()
  })

  test('a narrow pane draws one card a row, and a finished agent has no stop button', async ($, on) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.agent.spawn({ prompt: 'run it', description: 'sweep runner' } as any)
    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1, agentId: 'a1' } as any)
    await $.command.run({ command: 'radar', args: '' } as any)
    const ui = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 50 } } as any)
    expect(cardRows(await ui.drawn()).map(r => r.children.length)).toEqual([1])
    await ui.press({ key: 'agent-a1' })
    expect(await ui.find({ key: 'view' })).toBeDefined()
    expect(await ui.find({ key: 'stop' })).toBeUndefined()
    await ui.unmount()
  })

  test('the crab sits at the foot of every view, and /mission crab hides it in all of them', async ($, on) => {
    const { clock } = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await $.turn.start({ text: 'go', turnId: 't1' } as any)
    await $.tool.call({ tool: 'Read', file_path: '/work/src/pages/login.tsx', tool_use_id: 'u1' } as any)
    await $.agent.spawn({ prompt: 'run it', description: 'sweep runner' } as any)
    const ui = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...PANE } as any)
    const crabAtFoot = async () => {
      const root: any = await ui.drawn()
      const kids = (root.children as any[]).filter(c => c !== false && c != null)
      const spacer = kids.findIndex(c => c.props?.flexGrow === 1)
      return root.props.minHeight === 30 && spacer > 0 && kids.length - spacer - 1 === 2 && (await ui.find({ type: 'Text', text: /^Claude is reading/ })) !== undefined
    }
    for (const tab of ['who', 'code', 'agents']) {
      await ui.press({ key: tab })
      expect([tab, await crabAtFoot()]).toEqual([tab, true])
    }
    await ui.press({ key: 'agent-a1' }) // an agent's page too
    expect(await crabAtFoot()).toBe(true)
    // it moves on the pane's tick
    expect(await ui.find({ type: 'Text', text: '  ▐▛███▜▌  ' })).toBeDefined()
    await clock.advance(600)
    expect(await ui.find({ type: 'Text', text: '   ▐▛███▜▌ ' })).toBeDefined()
    // hidden, it is gone from every view
    await $.command.run({ command: 'mission', args: 'crab' } as any)
    for (const tab of ['agents', 'code', 'who']) {
      await ui.press({ key: tab })
      expect([tab, await ui.find({ type: 'Text', text: /▐/ })]).toEqual([tab, undefined])
    }
    await ui.unmount()
  })
})
