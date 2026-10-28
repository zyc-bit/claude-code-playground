import { describe, expect, mock, test } from 'claude-code/testing'

import { CRAB_WIDTH, DEMO, crabRows } from '../hooks/crab'
import { edges, fit, importsOf, layout, svg, titleOf, wrap } from '../hooks/map'
import { label, lines, scrolled, summary } from '../hooks/tree'
import { resetBandOrder } from '../hooks/register'

let mockClock: any
const PANE = { component: 'Pane', requestId: 'mission-control', props: { title: 'Mission Control', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } } }
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120 } }

// Stands for the engine beneath the mod.
function engine(on: any, opts: { noChrome?: boolean; chromePath?: string; bands?: string; beneath?: unknown } = {}) {
  const runs: string[][] = []
  resetBandOrder()
  const writes: Record<string, string> = {}
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  const clock = mock.clock(on)
  mockClock = clock
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'ag1' }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('fs.read', (_$: any, e: any) => ({ value: e.path.endsWith('login.tsx') ? "import { start } from '../auth/session'\n" : e.path.endsWith('/bands.json') ? opts.bands : '' }))
  on('fs.write', (_$: any, e: any) => ((writes[e.path] = e.text), { value: undefined }))
  on('fs.exists', (_$: any, e: any) => ({ value: e.path.endsWith('/bands.json') ? opts.bands !== undefined : !opts.noChrome }))
  const env: Record<string, string | undefined> = { TMPDIR: '/tmp/', CLAUDE_CONFIG_DIR: '/tmp/', HOME: '/tmp/', CHROME_PATH: opts.chromePath }
  on('env.get', (_$: any, e: any) => ({ value: env[e.name] }))
  on('process.run', (_$: any, e: any) => (runs.push(e.argv), { value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'mission-control', title: 'Mission Control', isShown: true, isFocused: true, isPlaced: true }] }))
  on('model.complete', () => ({ value: { isAnswered: true, text: '["tokens now expire after an hour"]', usage: { input_tokens: 1, output_tokens: 1 } } }))
  on('ui.render', ($: any, e: any) => opts.beneath ?? $.ui.resolve(e).Text({ children: 'band below' }))
  return { runs, writes, clock }
}

describe('mission-control', () => {
  test('bug fixes from the demo video', () => {
    // 1. An import that skips a column arcs over the card between instead of hiding behind it.
    const f = (path: string, imports: string[]) => ({ path, act: 'edit' as const, at: 0, changedTurn: 1, imports })
    const chain = [f('/r/a.ts', ['/r/b', '/r/c']), f('/r/b.ts', ['/r/c']), f('/r/c.ts', [])]
    const out = svg(chain, { width: 1200, height: 600, at: 99_999, turn: 1 })
    const paths = [...out.matchAll(/<path d="M(-?[\d.]+),(-?[\d.]+) C-?[\d.]+,(-?[\d.]+)/g)].map(m => ({ y: Number(m[2]), peak: Number(m[3]) }))
    expect(paths).toHaveLength(3)
    expect(paths.some(p => p.peak < p.y - 20)).toBe(true) // the a → c arrow goes up and over
    // 4. A small graph in a roomy picture is drawn larger, text included.
    expect(out).toContain('scale(1.500)')
  })


  test('no Chrome says so', async ($, on) => {
    const { runs } = engine(on, { noChrome: true }) // no Chrome on this machine
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' } as any)
    await $.turn.start({ text: 'go', turnId: 't1' } as any)
    await $.command.run({ command: 'mission', args: 'code' } as any)
    const pane = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...PANE } as any)
    await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts' } as any)
    await mockClock.advance(800)
    expect(await pane.find({ type: 'Text', text: /needs Google Chrome/ })).toBeDefined()
    expect(runs.some(a => a[0] === 'sh')).toBe(false)
    await pane.unmount()
  })

  test('CHROME_PATH draws with a Chrome of one\'s own', async ($, on) => {
    const { runs } = engine(on, { chromePath: '/opt/chrome-for-maps' })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' } as any)
    await $.command.run({ command: 'mission', args: 'code' } as any)
    const pane = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...PANE } as any)
    await mockClock.advance(800)
    expect(runs.some(a => a[4] === '/opt/chrome-for-maps')).toBe(true) // the map draws, with that binary
    await pane.unmount()
  })

  test('the tree window follows, sticks and follows again', () => {
    expect(scrolled({ follow: true, off: 0 }, 0, 10)).toEqual({ follow: true, off: 10 }) // at the bottom, it stays on the newest rows
    const up = scrolled({ follow: true, off: 0 }, -3, 10)
    expect(up).toEqual({ follow: false, off: 7 }) // a wheel up leaves the bottom
    expect(scrolled(up, 0, 12)).toEqual({ follow: false, off: 7 }) // lines that arrive move it not
    expect(scrolled(up, 2, 10)).toEqual({ follow: false, off: 9 }) // a wheel down, short of the bottom
    expect(scrolled({ follow: false, off: 9 }, 1, 10)).toEqual({ follow: true, off: 10 }) // back at the bottom, it follows again
    expect(scrolled({ follow: true, off: 0 }, -4, 0)).toEqual({ follow: true, off: 0 }) // a tree that fits never leaves the bottom
  })

  test('the who view keeps its window on the newest rows, saying what is above', async ($, on) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' } as any)
    await $.turn.start({ text: 'go', turnId: 't1' } as any)
    // Read and Bash alternate: a run of file tools would fold into one line.
    for (let i = 0; i < 30; i++)
      await $.tool.call((i % 2 ? { tool: 'Bash', command: `c${String(i).padStart(2, '0')}` } : { tool: 'Read', file_path: `/repo/src/f${String(i).padStart(2, '0')}.tsx` }) as any)
    const pane = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...PANE } as any)
    await pane.drawn()
    expect(await pane.find({ type: 'Text', text: /read: src\/f14/ })).toBeDefined() // the newest Read shows
    expect(await pane.find({ type: 'Text', text: /read: src\/f00/ })).toBeUndefined() // the oldest does not
    expect(await pane.find({ key: 'who' })).toBeDefined() // the tabs stay
    expect(await pane.find({ type: 'Text', text: /↑9/ })).toBeDefined() // and the window says what is above it
    await pane.unmount()
  })

  test('a background agent still running keeps its open calls when main ends', async ($, on) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' } as any)
    await $.turn.start({ text: 'go', turnId: 't1' } as any)
    await $.agent.spawn({ prompt: 'p', description: 'long runner' } as any) // agent ag1, background
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, turnId: 't1' } as any) // main ends, ag1 runs on
    const pane = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...PANE } as any)
    expect(await pane.find({ type: 'Text', text: /1 agents \(1 running\)/ })).toBeDefined() // still running
    await pane.unmount()
  })

  test('the who tree keeps every turn of the session', async ($, on) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' } as any)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' } as any)
    await $.tool.call({ tool: 'Read', tool_use_id: 'u1', file_path: '/repo/src/pages/login.tsx' } as any)
    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1, turnId: 't1' } as any)
    await $.turn.start({ text: 'and the logout bug', turnId: 't2' } as any)
    await $.tool.call({ tool: 'Edit', tool_use_id: 'u2', file_path: '/repo/src/auth/session.ts', old_string: 'a', new_string: 'b' } as any)
    const pane = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...PANE } as any)
    expect(await pane.find({ type: 'Text', text: /◆ main · fix the login bug/ })).toBeDefined() // the first turn stays
    expect(await pane.find({ type: 'Text', text: /◆ main · and the logout bug/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /2 tool calls/ })).toBeDefined() // both turns counted
    await pane.unmount()
  })

  test('labels tool calls by family', () => {
    expect(label({ tool: 'Bash', description: 'Run tests' })).toEqual({ label: 'Run tests', family: 'bash' })
    expect(label({ tool: 'mcp__playwright__browser_click' })).toEqual({ label: 'click', family: 'browser' })
    expect(label({ tool: 'mcp__claude_ai_Slack__slack_send_message' })).toEqual({ label: 'slack_send_message', family: 'mcp:Slack' })
  })

  test('the who tree nests agents and folds runs of one tool family', () => {
    const at = 10_000
    const ls = lines(
      [
        { id: 'main', parent: null, kind: 'main', label: 'main · fix login', family: 'main', status: 'running', start: 0 },
        { id: 'a', parent: 'main', kind: 'agent', label: 'test login flow', family: 'agent', status: 'running', start: 1000 },
        { id: 't1', parent: 'a', kind: 'tool', label: 'navigate', family: 'browser', status: 'done', start: 1000, end: 2000 },
        { id: 't2', parent: 'a', kind: 'tool', label: 'click', family: 'browser', status: 'running', start: 2000 },
        { id: 't3', parent: 'main', kind: 'tool', label: 'npm test', family: 'bash', status: 'failed', start: 3000, end: 4000 },
      ],
      at,
    )
    expect(ls.map(l => l.prefix + l.text)).toEqual([
      '◆ main · fix login  10s',
      '├─ ● test login flow  9.0s · 2 tools',
      '│  └─ ◎ browser: navigate → click  ×2  9.0s',
      '└─ $ bash: npm test  1.0s',
    ])
    expect(ls[2]?.status).toBe('running')
    expect(ls[3]?.status).toBe('failed')
  })

  test('the code map finds imports, columns and draws an SVG', () => {
    expect(importsOf('/r/src/pages/login.tsx', "import { a } from '../auth/session'\nconst b = require('./x.js')")).toEqual(['/r/src/auth/session', '/r/src/pages/x'])
    expect(importsOf('/r/app/views.py', 'from .models import User\nfrom ..core.db import q')).toEqual(['/r/app/models', '/r/core/db'])
    const files = [
      { path: '/r/a.ts', act: 'read' as const, at: 0, changedTurn: 0, imports: ['/r/b'] },
      { path: '/r/b.ts', act: 'edit' as const, at: 0, changedTurn: 2, imports: [], why: 'adds a & b <check>' },
    ]
    expect(edges(files)).toEqual([{ from: '/r/a.ts', to: '/r/b.ts' }])
    expect(layout(files, edges(files))).toEqual([['/r/a.ts'], ['/r/b.ts']])
    const out = svg(files, { width: 800, height: 400, at: 99_999, turn: 2 })
    expect(out).toContain('1 changed')
    expect(out).toContain('adds a &amp; b &lt;check&gt;')
    expect(fit('tokens now expire after one hour', 20)).toBe('tokens now expire…')
    const regs = ['/m/merge-gate/hooks/register.tsx', '/m/snake/hooks/register.tsx']
    expect(titleOf(regs[0] as string, regs)).toBe('merge-gate › register.tsx')
    expect(titleOf('/m/a/login.tsx', regs)).toBe('login.tsx')
    expect(wrap('Added userId validation before login', 20)).toEqual(['Added userId', 'validation before login'])
  })

  test('a turn fills the tree, the band sums it up, and /mission code draws the map', async ($, on) => {
    const { runs, writes, clock } = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' } as any)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' } as any)
    await $.agent.spawn({ prompt: 'check it', description: 'test login flow' } as any)
    await $.tool.call({ tool: 'Read', file_path: '/repo/src/pages/login.tsx' } as any)
    await $.tool.call({ tool: 'Edit', file_path: '/repo/src/auth/session.ts', old_string: 'a', new_string: 'b' } as any)

    const band = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: /1\/1 agents · 2 tools · 1 files changed/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /band below/ })).toBeDefined()
    // the line sits on top: what other mods draw stays below it
    const root: any = await band.drawn()
    expect(root.props.key).toBe('bands')
    expect(root.children.map((c: any) => c.props?.key)).toEqual(['band:mission-control', undefined])
    await band.unmount()

    const r = await $.command.run({ command: 'mission', args: '' } as any)
    expect(r.text).toMatch(/1 agents · 2 tool calls · 2 files/)
    const pane = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...PANE } as any)
    expect(await pane.find({ type: 'Text', text: /◆ main · fix the login bug/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /● test login flow/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /✎ edit: auth\/session\.ts/ })).toBeDefined()

    // 2. Images are not code: a screenshot read now stays off the map.
    await $.tool.call({ tool: 'Read', file_path: '/repo/shots/v2.png' } as any)
    // 5. Claude Code's own bookkeeping is not a tool call in the tree.
    await $.tool.call({ tool: 'SubagentHandback', summary: 'done' } as any)
    expect(await pane.find({ type: 'Text', text: /SubagentHandback/ })).toBeUndefined()

    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1, turnId: 't1' } as any)
    await pane.press({ key: 'code' })
    await clock.advance(800) // the map draws a moment after a change
    const map = writes['/tmp/mission-control/map.svg'] ?? ''
    expect(map).toContain('login.tsx')
    expect(map).toContain('session.ts')
    expect(map).not.toContain('v2.png')
    expect(map).toContain('marker-end="url(#a)"') // the import arrow login → session
    expect(runs.some(a => a[0] === 'sh' && a.includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))).toBe(true)
    expect(await pane.find({ type: 'Image' })).toBeDefined()
    await clock.advance(800) // the "why" lines redraw the map
    const drawn = writes['/tmp/mission-control/map.svg'] ?? ''
    expect(drawn).toContain('tokens now expire') // the why, wrapped over two lines
    expect(drawn).toContain('after an hour')
    await pane.unmount()
    // 3. In a tall enough pane the picture's size follows the width alone: two heights, one size.
    const rowsAt = async (bodyRows: number) => {
      const tall = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows } } } as any)
      const img: any = await tall.find({ type: 'Image' })
      await tall.unmount()
      return img?.props?.rows ?? img?.rows
    }
    expect(await rowsAt(50)).toBe(30)
    expect(await rowsAt(60)).toBe(30)
    expect(summary([]).tools).toBe(0)
  })

  test('follows the band order file', async ($, on) => {
    // another band mod drew its column beneath
    const beneath = {
      type: 'Box',
      props: { key: 'bands', flexDirection: 'column' },
      children: [{ type: 'Box', props: { key: 'band:where-am-i' }, children: [{ type: 'Text', children: ['here'] }] }],
    }
    engine(on, { bands: '{"order":["where-am-i","mission-control"]}', beneath })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' } as any)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' } as any)
    await $.tool.call({ tool: 'Read', file_path: '/repo/src/pages/login.tsx' } as any)
    const band = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...BAND } as any)
    const root: any = await band.drawn()
    expect(root.children.map((c: any) => c.props.key)).toEqual(['band:where-am-i', 'band:mission-control'])
    await band.unmount()
  })

  test('the crab at the pane\'s foot acts out the work', async ($, on) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' } as any)
    await $.turn.start({ text: 'fix the login bug', turnId: 't1' } as any)
    await $.tool.call({ tool: 'Read', file_path: '/repo/src/pages/login.tsx', tool_use_id: 'u1' } as any)
    const pane = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...PANE } as any)
    expect(await pane.find({ type: 'Text', text: /Claude is reading/ })).toBeDefined() // the scene's words
    expect(await pane.find({ type: 'Text', text: /▐▛███▜▌/ })).toBeDefined() // the crab itself
    expect(await pane.find({ type: 'Text', text: /login\.tsx/ })).toBeDefined() // the detail beside them
    // the band says it too
    const band = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...BAND } as any)
    expect(await band.find({ type: 'Text', text: /Claude is reading/ })).toBeDefined()
    await band.unmount()
    // /mission crab hides it, and brings it back
    await $.command.run({ command: 'mission', args: 'crab' } as any)
    expect(await pane.find({ type: 'Text', text: /Claude is reading/ })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: /◆ main · fix the login bug/ })).toBeDefined() // the tree keeps its rows back
    await $.command.run({ command: 'mission', args: 'crab' } as any)
    expect(await pane.find({ type: 'Text', text: /Claude is reading/ })).toBeDefined()
    // the turn ends well
    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1, turnId: 't1' } as any)
    expect(await pane.find({ type: 'Text', text: /^Done!/ })).toBeDefined()
    await pane.unmount()
  })

  test('the crab moves: legs, eyes and claws change with the tick, and it keeps its width', () => {
    // a working crab starts in the pose the logo has, in the middle of its field
    expect(crabRows('coding', 0)).toEqual(['  ▐▛███▜▌  ', ' ▝▜█████▛▘ ', '   ▘▘ ▝▝   '])
    // every scene, every tick: three rows of the same width, so the prop beside it never jumps
    for (const activity of [...DEMO, 'idle' as const]) {
      for (let tick = 0; tick < 60; tick++) {
        const rows = crabRows(activity, tick)
        expect(rows.map(r => r.length)).toEqual([CRAB_WIDTH, CRAB_WIDTH, CRAB_WIDTH])
      }
      expect(crabRows(activity, 60)).toEqual(crabRows(activity, 0)) // the tick wraps at 60 without a jump
    }
    // working: the legs alternate and the crab scuttles to and fro
    expect(crabRows('coding', 0)[2]).not.toBe(crabRows('coding', 1)[2])
    expect(new Set(Array.from({ length: 4 }, (_, t) => crabRows('coding', t)[1])).size).toBe(3)
    // working: now and then it blinks
    expect(crabRows('coding', 9)[0]).toContain('▐█████▌')
    expect(crabRows('coding', 8)[0]).toContain('▐▛███▜▌')
    // waiting: it looks left and right instead
    const eyes = Array.from({ length: 4 }, (_, t) => crabRows('thinking', t)[0]!.trim())
    expect(eyes).toEqual(['▐▛███▜▌', '▐▜███▜▌', '▐▛███▜▌', '▐▛███▛▌'])
    // idle: asleep, eyes shut and still
    expect(crabRows('idle', 0)[0]).toContain('▐█████▌')
    expect(crabRows('idle', 3)).toEqual(crabRows('idle', 0))
    // done: it waves a claw, one then the other
    expect(crabRows('done', 0)[0]).toContain('▗')
    expect(crabRows('done', 1)[0]).toContain('▖')
    // error: it shakes
    expect(crabRows('error', 0)[0]).not.toBe(crabRows('error', 1)[0])
  })

  test('the crab sits at the foot of the pane, however short the tree', async ($, on) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' } as any)
    await $.turn.start({ text: 'go', turnId: 't1' } as any)
    await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts', tool_use_id: 'u1' } as any)
    const pane = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...PANE } as any)
    const root: any = await pane.drawn()
    expect(root.props.minHeight).toBe(30) // the column is as tall as the body
    const kids = (root.children as any[]).filter(c => c !== false && c != null)
    const spacer = kids.findIndex(c => c.props?.flexGrow === 1)
    expect(spacer).toBeGreaterThan(0)
    expect(kids.length - spacer - 1).toBe(2) // after it only the blank line and the crab's row
    expect(kids.slice(0, spacer).length).toBeLessThan(10) // the tree stays above it
    // with the crab hidden the tree keeps the top and nothing is stretched
    await $.command.run({ command: 'mission', args: 'crab' } as any)
    const bare: any = await pane.drawn()
    expect(bare.props.minHeight).toBeUndefined()
    await pane.unmount()
  })

  test('an overflowing tree keeps the crab at the window\'s foot', async ($, on) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' } as any)
    await $.turn.start({ text: 'go', turnId: 't1' } as any)
    // Read and Bash alternate: a run of file tools would fold into one line.
    for (let i = 0; i < 30; i++)
      await $.tool.call((i % 2 ? { tool: 'Bash', command: `c${String(i).padStart(2, '0')}` } : { tool: 'Read', file_path: `/repo/src/f${String(i).padStart(2, '0')}.tsx` }) as any)
    const pane = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...PANE } as any)
    const root: any = await pane.drawn()
    expect(root.props.minHeight).toBe(31) // a row of scroll room more than the body
    const kids = (root.children as any[]).filter(c => c !== false && c != null)
    const spacer = kids.findIndex(c => c.props?.flexGrow === 1)
    expect(kids.slice(spacer + 1).map((c: any) => c.type)).toEqual(['Text', 'Box', 'Text']) // the blank, the crab's row, then the row given away to the scroll room
    await pane.unmount()
  })

  test('a short pane keeps several tree rows beside the crab', async ($, on) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' } as any)
    await $.turn.start({ text: 'go', turnId: 't1' } as any)
    await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts', tool_use_id: 'u1' } as any)
    await $.tool.call({ tool: 'Read', file_path: '/repo/src/b.ts', tool_use_id: 'u2' } as any)
    await $.tool.call({ tool: 'Bash', command: 'ls', description: 'list files', tool_use_id: 'u3' } as any)
    const short = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 9 } } } as any)
    expect(await short.find({ type: 'Text', text: /a\.ts/ })).toBeDefined()
    expect(await short.find({ type: 'Text', text: /b\.ts/ })).toBeDefined()
    expect(await short.find({ type: 'Text', text: /list files/ })).toBeDefined()
    expect(await short.find({ type: 'Text', text: /Claude is reading/ })).toBeDefined() // the crab fits too
    await short.unmount()
  })

  test('a helper at work says so in the crab\'s line', async ($, on) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' } as any)
    await $.turn.start({ text: 'go', turnId: 't1' } as any)
    await $.tool.call({ tool: 'Agent', description: 'test login flow', tool_use_id: 'u0' } as any) // the crab shows the delegation
    await $.agent.spawn({ prompt: 'check it', description: 'test login flow' } as any) // agent ag1
    await mockClock.advance(1300) // the held scene lets the helpers' line through
    await $.tool.call({ tool: 'Read', agentId: 'ag1', tool_use_id: 'u1', file_path: '/repo/src/pages/login.tsx' } as any) // the helper reads
    const pane = await $.ui.mount({ plugin: 'mission-control', surface: 'terminal', ...PANE } as any)
    expect(await pane.find({ type: 'Text', text: /Claude is putting helpers to work/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /test login flow: reading/ })).toBeDefined()
    await pane.unmount()
  })
})
