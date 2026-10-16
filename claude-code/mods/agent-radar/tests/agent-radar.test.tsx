import { describe, expect, test } from 'claude-code/testing'

import { chunk, describe as label, elapsed, isShown, oneLine, resetBandOrder } from '../hooks/register'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120 } }
const PANE = { component: 'Pane', requestId: 'agent-radar', props: { title: 'Agent Radar', isFocused: true, bodyColumns: 100, placement: 'dock' } }

const SWEEP = [{ role: 'user', text: 'Run the sweep', toolUses: [] }, { role: 'assistant', text: 'Sweep is at trial 12 of 40.', toolUses: [] }]

// Stands for the engine beneath the mod. Spawns answer the `ids` in turn; `messages` answers each agent's conversation.
function engine(on: any, files: Record<string, string> = {}, beneath?: unknown, ids = ['a1'], messages: (agentId: string) => unknown[] = () => SWEEP) {
  const toasts: string[] = []
  let spawned = 0
  resetBandOrder()
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('fs.exists', (_$: any, e: any) => ({ value: e.path in files }))
  on('fs.read', (_$: any, e: any) => ({ value: files[e.path] ?? '' }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('clock.every', () => ({ value: { cancel: () => {} } }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: ids[spawned++ % ids.length] }))
  on('agent.list', () => ({ value: [] }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.toast', (_$: any, e: any) => (toasts.push(e.text), { value: undefined }))
  on('ui.render', ($: any, e: any) => beneath ?? $.ui.resolve(e).Text({ children: 'band below' }))
  on('session.messages', (_$: any, e: any) => ({ value: messages(e.agentId) }))
  return { toasts }
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
