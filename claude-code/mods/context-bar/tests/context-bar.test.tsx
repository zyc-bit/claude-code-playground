import { describe, expect, test } from 'claude-code/testing'

import { cells, compacted, legend, parseStatus, resetBandOrder, share, shortenPath, toReading, tokens } from '../hooks/register'

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 84 } }

// /context's breakdown as the engine hands it over, for a 1M window.
const BREAKDOWN = {
  categories: [
    { name: 'System prompt', tokens: 3_400, color: 'promptBorder', kind: 'used', isDeferred: false },
    { name: 'System tools', tokens: 12_000, color: 'inactive', kind: 'used', isDeferred: false },
    { name: 'MCP tools', tokens: 2_600, color: 'cyan_FOR_SUBAGENTS_ONLY', kind: 'used', isDeferred: false },
    { name: 'MCP tools (deferred)', tokens: 40_000, color: 'inactive', kind: 'deferred', isDeferred: true },
    { name: 'Skills', tokens: 0, color: 'warning', kind: 'used', isDeferred: false },
    { name: 'Messages', tokens: 186_000, color: 'purple_FOR_SUBAGENTS_ONLY', kind: 'used', isDeferred: false },
    { name: 'Autocompact buffer', tokens: 50_000, color: 'inactive', kind: 'buffer', isDeferred: false },
    { name: 'Free space', tokens: 746_000, color: 'promptBorder', kind: 'free', isDeferred: false },
  ],
  totalTokens: 204_000,
  maxTokens: 1_000_000,
  rawMaxTokens: 1_000_000,
  percentage: 20,
  autoCompactThreshold: 950_000,
  isAutoCompactEnabled: true,
  gridRows: [],
  memoryFiles: [],
  mcpTools: [],
  agents: [],
  model: 'opus',
  apiUsage: null,
  autocompactSource: 'model-default',
}

// Stands for the engine beneath the mod.
function engine(on: any, store: Record<string, unknown> = {}, files: Record<string, string> = {}, beneath?: unknown) {
  const asked: unknown[] = []
  const reads: string[] = []
  let breakdown: any = BREAKDOWN
  resetBandOrder()
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('fs.exists', (_$: any, e: any) => ({ value: e.path in files }))
  on('fs.read', (_$: any, e: any) => (reads.push(e.path), { value: files[e.path] ?? '' }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => ((store[e.key] = e.value), { value: undefined }))
  on('session.usage', (_$: any, e: any) => {
    asked.push(e)
    return { value: { startedAt: 0, context: { tokens: 204_000, window: 1_000_000, percent: 20, breakdown }, rateLimits: {}, cost: { usd: 0 } } }
  })
  on('ui.render', ($: any, e: any) => beneath ?? $.ui.resolve(e).Text({ children: 'band below' }))
  return { asked, store, reads, setUsage: (b: any) => { breakdown = b } }
}

const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 20)) // the first refresh runs in the background

describe('context-bar', () => {
  test('helpers', () => {
    expect(tokens(3_400)).toBe('3.4k')
    expect(tokens(186_000)).toBe('186k')
    expect(tokens(1_000_000)).toBe('1M')
    expect(tokens(950)).toBe('950')
    expect(share(3_400, 1_000_000)).toBe('0.3%')
    expect(share(186_000, 1_000_000)).toBe('19%')
    expect(share(494, 1_000_000)).toBe('<0.1%')

    const r = toReading(BREAKDOWN)
    // Deferred and empty rows are left out; used first, then free, then the buffer.
    expect(r.slices.map(s => s.name)).toEqual(['system prompt', 'system tools', 'mcp tools', 'messages', 'free space', 'autocompact buffer'])
    expect(r.compactsAt).toBe(950_000)
    // Every used row has its own color, and none matches free space or the buffer.
    const colors = r.slices.filter(s => s.kind === 'used').map(s => s.color)
    expect(new Set(colors).size).toBe(colors.length)
    expect(cells(r, 80).find(c => c.kind === 'buffer')?.text).toMatch(/^░+$/)
    expect(cells(r, 80).find(c => c.kind === 'free')?.text).toMatch(/^─+$/)

    for (const width of [20, 47, 80, 200]) {
      const bar = cells(r, width)
      expect(bar.reduce((n, c) => n + c.text.length, 0)).toBe(width) // always exactly the width
      expect(bar.filter(c => c.kind === 'used').every(c => c.text.length >= 1)).toBe(true) // a small used slice still shows
    }
    for (const line of legend(r, 40)) {
      const size = line.reduce((n, s, i) => n + (i ? 3 : 0) + 2 + s.name.length + 1 + tokens(s.tokens).length + (s.kind === 'used' ? 1 + share(s.tokens, r.window).length : 0), 0)
      expect(size <= 40 || line.length === 1).toBe(true)
    }
    expect(toReading({ ...BREAKDOWN, isAutoCompactEnabled: false }).compactsAt).toBeUndefined()
  })

  test('draws the bar and legend above the prompt from a summary breakdown', async ($, on) => {
    const { asked } = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await settle()
    expect(asked).toEqual([{ breakdown: 'summary' }]) // estimated locally, never the token-count API

    const band = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: /204k of 1M · compacts at 950k/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: / 20% / })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^messages $/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /^186k$/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /mcp tools \(deferred\)/ })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: 'band below' })).toBeDefined() // the band beneath stays
    // the box is the bottom of the stack: what other mods draw sits above it
    const root: any = await band.drawn()
    expect(root.props.key).toBe('bands')
    const kids = root.children as any[]
    expect(kids[0].children).toEqual(['band below'])
    expect(kids[1].props.key).toBe('band:context-bar')
    expect(kids[1].children[0].props.borderStyle).toBe('round')
    await band.unmount()
  })

  test('follows the band order file', async ($, on) => {
    // another band mod drew its column beneath
    const beneath = {
      type: 'Box',
      props: { key: 'bands', flexDirection: 'column' },
      children: [{ type: 'Box', props: { key: 'band:where-am-i' }, children: [{ type: 'Text', children: ['here'] }] }],
    }
    engine(on, {}, { '/home/me/.claude/claude-code-mods/bands.json': '{"order":["context-bar","where-am-i"]}' }, beneath)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await settle()
    const band = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND } as any)
    const root: any = await band.drawn()
    expect(root.children.map((c: any) => c.props.key)).toEqual(['band:context-bar', 'band:where-am-i'])
    await band.unmount()
  })

  test('reads the band order file once per session', async ($, on) => {
    const { reads } = engine(on, {}, { '/home/me/.claude/claude-code-mods/bands.json': '{"order":["context-bar"]}' })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await settle()
    for (let i = 0; i < 2; i++) {
      const band = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND } as any)
      await band.drawn()
      await band.unmount()
    }
    expect(reads).toEqual(['/home/me/.claude/claude-code-mods/bands.json'])
  })

  test('refreshes after a main turn, not after a subagent turn', async ($, on) => {
    const { asked } = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await settle()
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, agentId: 'a1' } as any)
    expect(asked.length).toBe(1)
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 } as any)
    expect(asked.length).toBe(2)
  })

  test('refreshes after a compaction without a size to shrink to', async ($, on) => {
    const { asked } = engine(on)
    on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] })) // no tokensAfter: a precompute
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await settle()
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as any)
    await settle()
    expect(asked.length).toBe(2)
  })

  test('a compaction shrinks the bar by the size the event carries', async ($, on) => {
    const { asked } = engine(on)
    on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensAfter: 31_120 }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await settle()
    let band = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: /204k of 1M/ })).toBeDefined()
    await band.unmount()
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as any)
    await settle()
    expect(asked.length).toBe(1) // the window has not answered since: the size the event carries is all there is
    band = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: /31k of 1M/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: / 3% / })).toBeDefined()
    await band.unmount()
  })

  test('compacted shrinks the conversation and closes the rest around it', () => {
    const r = compacted(toReading(BREAKDOWN), 31_120)
    expect(r.total).toBe(31_120)
    expect(r.percent).toBe(3)
    expect(r.slices.find(s => s.name === 'messages')?.tokens).toBe(13_120) // 31,120 less the rows that stayed
    expect(r.slices.find(s => s.name === 'free space')?.tokens).toBe(918_880)
    expect(r.slices.find(s => s.name === 'system prompt')?.tokens).toBe(3_400) // the fixed rows keep their tokens
    expect(compacted(toReading(BREAKDOWN), 0).total).toBe(18_000) // never below what cannot shrink
  })

  test('a compaction vetoed leaves the bar alone', async ($, on) => {
    const { asked } = engine(on)
    on('session.compact', () => ({ skip: 'the conversation is small already' }))
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await settle()
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as any)
    await settle()
    expect(asked.length).toBe(1) // nothing was compacted: no new reading
  })

  test("a turn's requests read the window as the turn goes", async ($, on) => {
    const { asked } = engine(on)
    on('turn.step', async function* (_$: any, e: any) {
      return { turnId: e.turnId, index: e.index, answer: 'Working.', toolUses: [], stopReason: 'end_turn', usage: null } as never
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await settle()
    expect(asked.length).toBe(1)
    for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 1 } as any)) {
      // read the whole stream
    }
    await settle()
    expect(asked.length).toBe(2) // the window grows between the requests of one turn
    for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 1, agentId: 'a1' } as any)) {
      // read the whole stream
    }
    await settle()
    expect(asked.length).toBe(2) // a subagent's request fills its own window
    const band = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: 'claude-opus-5-5' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'effort: xhigh' })).toBeDefined()
    await band.unmount()
  })

  test('/clear reads the window again and the bar follows', async ($, on) => {
    const { asked, setUsage } = engine(on)
    on('command.run', () => ({ text: '' })) // core's answer to the command itself
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await settle()
    expect(asked.length).toBe(1)
    setUsage({ ...BREAKDOWN, categories: BREAKDOWN.categories.map(c => (c.name === 'Messages' ? { ...c, tokens: 13_120 } : c.name === 'Free space' ? { ...c, tokens: 918_880 } : c)), totalTokens: 31_120, percentage: 3 })
    await $.command.run({ command: 'clear', args: '' } as any)
    await settle()
    expect(asked.length).toBe(2) // a /clear empties the window without a turn ending
    const band = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: /31k of 1M/ })).toBeDefined()
    await band.unmount()
  })

  test('/model reads the model and effort again', async ($, on) => {
    engine(on)
    let name = 'claude-opus-5-5'
    on('session.model', () => ({ value: name }))
    on('settings.read', () => ({ value: {} }))
    on('command.run', () => ({ text: '' })) // core's answer to the command itself
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await settle()
    let band = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: 'claude-opus-5-5' })).toBeDefined()
    await band.unmount()
    name = 'claude-haiku-5-5'
    await $.command.run({ command: 'model', args: '' } as any)
    await settle()
    band = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: 'claude-haiku-5-5' })).toBeDefined()
    await band.unmount()
  })

  test('/context-bar hides and shows it, and remembers the choice', async ($, on) => {
    const { store } = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await settle()
    expect((await $.command.run({ command: 'context-bar', args: '' } as any)).text).toMatch(/hidden/)
    expect(store.isHidden).toBe(true)
    let band = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: /of 1M/ })).toBeUndefined()
    await band.unmount()

    expect((await $.command.run({ command: 'context-bar', args: '' } as any)).text).toBe('Context bar on')
    expect(store.isHidden).toBe(false)
    band = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: /of 1M/ })).toBeDefined()
    await band.unmount()
  })

  test('a session that hid it starts hidden', async ($, on) => {
    engine(on, { isHidden: true })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
    await settle()
    const band = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: /of 1M/ })).toBeUndefined()
    await band.unmount()
  })

  test('shortenPath writes the home folder as ~', () => {
    expect(shortenPath('/root', '/root')).toBe('~')
    expect(shortenPath('/root/a/b', '/root')).toBe('~/a/b')
    expect(shortenPath('/rootfs/a', '/root')).toBe('/rootfs/a')
    expect(shortenPath('/mnt/x', undefined)).toBe('/mnt/x')
    expect(shortenPath('/mnt/x', '/')).toBe('/mnt/x')
  })

  test('the info row shows folder, branch, model and effort from the engine', async ($, on) => {
    engine(on)
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('settings.read', () => ({ value: { effortLevel: 'xhigh' } }))
    on('session.cwd', () => ({ value: '/home/me/work/proj' }))
    on('process.run', (_$: any, e: any) => ({
      value: { exitCode: e.argv[1] === 'symbolic-ref' ? 0 : 128, stdout: 'feat/band\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }))
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
    await settle()
    const band = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: '~/work/proj' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'feat/band' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'claude-opus-5-5' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'effort: xhigh' })).toBeDefined()
    await band.unmount()
  })

  test('parseStatus counts the working tree by state and the unpushed commits', () => {
    expect(parseStatus('')).toEqual({ staged: 0, unstaged: 0, untracked: 0, ahead: 0 })
    expect(
      parseStatus(
        [
          '## add-community-mods...myfork/add-community-mods [ahead 2]',
          'M  hooks/register.tsx',
          'MM hooks/bands.ts',
          ' M types/index.d.ts',
          'D  hooks/old.ts',
          '?? tests/status.test.ts',
        ].join('\n'),
      ),
    ).toEqual({ staged: 3, unstaged: 2, untracked: 1, ahead: 2 })
    expect(parseStatus('## main...origin/main [ahead 10, behind 3]\n')).toEqual({ staged: 0, unstaged: 0, untracked: 0, ahead: 10 })
    expect(parseStatus('## main...origin/main\n')).toEqual({ staged: 0, unstaged: 0, untracked: 0, ahead: 0 })
    expect(parseStatus('## HEAD (no branch)\n')).toEqual({ staged: 0, unstaged: 0, untracked: 0, ahead: 0 })
  })

  test('the info row counts the working tree and the unpushed commits', async ($, on) => {
    engine(on)
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('settings.read', () => ({ value: {} }))
    on('session.cwd', () => ({ value: '/home/me/work/proj' }))
    on('process.run', (_$: any, e: any) => ({
      value: {
        exitCode: 0,
        stdout:
          e.argv[1] === 'symbolic-ref'
            ? 'add-community-mods\n'
            : '## add-community-mods...myfork/add-community-mods [ahead 2]\nM  hooks/register.tsx\n M types/index.d.ts\n?? notes.md\n',
        stderr: '', isStdoutTruncated: false, isStderrTruncated: false,
      },
    }))
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
    await settle()
    const band = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: 'add-community-mods' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '↑2' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '+1' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '~1' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '?1' })).toBeDefined()
    await band.unmount()
  })

  test('a clean tree on a pushed branch shows no counts', async ($, on) => {
    engine(on)
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('settings.read', () => ({ value: {} }))
    on('session.cwd', () => ({ value: '/home/me/work/proj' }))
    on('process.run', (_$: any, e: any) => ({
      value: {
        exitCode: 0,
        stdout: e.argv[1] === 'symbolic-ref' ? 'main\n' : '## main...origin/main\n',
        stderr: '', isStdoutTruncated: false, isStderrTruncated: false,
      },
    }))
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
    await settle()
    const band = await $.ui.mount({ plugin: 'context-bar', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: 'main' })).toBeDefined()
    for (const mark of ['↑1', '+1', '~1', '?1']) expect(await band.find({ type: 'Text', text: mark })).toBeUndefined()
    await band.unmount()
  })
})
