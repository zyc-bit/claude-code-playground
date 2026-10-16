// The crab at the pane's foot, as mission-control draws it (a copy of its hooks/crab.ts
// without the demo list: a mod ships alone, so it cannot import from another). Three rows
// of block glyphs that move with the running tick (legs, eyes, claws), with the scene's
// prop beside it as a few frames of glyphs picked by the same tick, and the words each
// scene says. The scenes come from crab-cam (https://github.com/sTomerG/agent-kit),
// which draws them above the prompt.
import type { Activity } from '../types'

type Frame = readonly [string, string, string]

const NO_PROP: Frame = ['', '', '']

// The crab is nine cells wide, set in a field two wider so it can scuttle.
export const CRAB_WIDTH = 11

// The two eyes are the notches in the top row's corner blocks: ▛ lacks its lower right
// quarter, ▜ its lower left. Swapping which quarter is missing turns the eyes, a solid
// block shuts them.
const EYES = { open: ['▛', '▜'], shut: ['█', '█'], left: ['▜', '▜'], right: ['▛', '▛'] } as const
const LEGS = ['  ▘▘ ▝▝  ', '  ▝▝ ▘▘  '] as const

type Eyes = keyof typeof EYES

// One pose: the eyes, a claw raised (or none), which legs are down, and how far the crab
// has scuttled in its field (1 is the middle).
function pose(eyes: Eyes, claw: 'none' | 'left' | 'right', legs: 0 | 1, at: 0 | 1 | 2): Frame {
  const [l, r] = EYES[eyes]
  const rows = [
    `${claw === 'left' ? '▗' : ' '}▐${l}███${r}▌${claw === 'right' ? '▖' : ' '}`,
    `${claw === 'left' ? ' ' : '▝'}▜█████▛${claw === 'right' ? ' ' : '▘'}`,
    LEGS[legs],
  ] as const
  const field = (row: string) => `${' '.repeat(at)}${row}${' '.repeat(2 - at)}`

  return [field(rows[0]), field(rows[1]), field(rows[2])]
}

// Scenes where Claude is waiting on something and the crab looks about instead of moving.
const WATCHING: ReadonlySet<Activity> = new Set(['thinking', 'waiting', 'asking', 'permission', 'compacting'])
const LOOKING = ['open', 'left', 'open', 'right'] as const
const SCUTTLE = [1, 2, 1, 0] as const

// The crab on a tick: asleep when idle, claws up and down when done, shaking on an error,
// looking about while Claude waits, and otherwise scuttling to and fro on its legs with
// a blink now and then. Every cycle divides 60, where the tick wraps.
export function crabRows(activity: Activity, tick: number): Frame {
  if (activity === 'idle') return pose('shut', 'none', 0, 1)
  if (activity === 'done') return pose('open', tick % 2 === 0 ? 'left' : 'right', 0, 1)
  if (activity === 'error') return pose('open', 'none', 0, tick % 2 === 0 ? 0 : 2)
  if (WATCHING.has(activity)) return pose(LOOKING[tick % 4]!, 'none', 0, 1)

  return pose(tick % 10 === 9 ? 'shut' : 'open', 'none', (tick % 2) as 0 | 1, SCUTTLE[tick % 4]!)
}

const PROPS: Record<Activity, readonly Frame[]> = {
  idle: [
    ['    ', ' z  ', '    '],
    ['  z ', ' z  ', '    '],
    ['   Z', '  z ', '    '],
  ],
  thinking: [
    [' ╭─────╮', '°│ ·   │', ' ╰─────╯'],
    [' ╭─────╮', '°│ ··  │', ' ╰─────╯'],
    [' ╭─────╮', '°│ ··· │', ' ╰─────╯'],
  ],
  reading: [
    ['┌──┬──┐', '│≡≡│≡≡│', '└──┴──┘'],
    ['┌──┬──┐', '│≡─│≡≡│', '└──┴──┘'],
    ['┌──┬──┐', '│≡≡│≡─│', '└──┴──┘'],
  ],
  coding: [
    ['┌─────┐', '│</>▌ │', '▀▀▀▀▀▀▀'],
    ['┌─────┐', '│</>  │', '▀▀▀▀▀▀▀'],
  ],
  writing: [
    ['┌────╮', '│╱   │', '└────╯'],
    ['┌────╮', '│≡≡╱ │', '└────╯'],
    ['┌────╮', '│≡≡≡≡│', '└────╯'],
  ],
  designing: [
    ['┌───┐', '│   │', '└┬─┬┘'],
    ['┌───┐', '│◐  │', '└┬─┬┘'],
    ['┌───┐', '│◐◣ │', '└┬─┬┘'],
    ['┌───┐', '│◐◣◕│', '└┬─┬┘'],
  ],
  terminal: [
    ['┌─────┐', '│$ ▌  │', '▀▀▀▀▀▀▀'],
    ['┌─────┐', '│$    │', '▀▀▀▀▀▀▀'],
  ],
  searching: [
    ['╭─╮≡≡≡≡', '╰─╯≡≡≡≡', '≡≡≡╲≡≡≡'],
    ['≡≡╭─╮≡≡', '≡≡╰─╯≡≡', '≡≡≡≡≡╲≡'],
    ['≡≡≡≡╭─╮', '≡≡≡≡╰─╯', '≡≡≡≡≡≡≡'],
  ],
  web: [
    ['┌○○○──┐', '│█░░░░│', '└─────┘'],
    ['┌○○○──┐', '│███░░│', '└─────┘'],
    ['┌○○○──┐', '│█████│', '└─────┘'],
    ['┌○○○──┐', '│≡≡≡≡ │', '└─────┘'],
  ],
  delegating: [
    ['           ', '▗▟█▙▖ ▗▟█▙▖', ' ▘ ▝   ▘ ▝ '],
    ['▗▟█▙▖      ', ' ▘ ▝  ▗▟█▙▖', '       ▘ ▝ '],
  ],
  talking: [
    ['≡≡≡▌  ', '      ', '      '],
    ['≡≡≡≡≡≡', '≡≡≡▌  ', '      '],
    ['≡≡≡≡≡≡', '≡≡≡≡≡≡', '≡≡▌  '],
  ],
  asking: [
    ['╭─╮', ' ╭╯', ' ● '],
    ['╭─╮', ' ╭╯', ' ○ '],
  ],
  planning: [
    ['       ', '       ', '●─╯    '],
    ['       ', '  ╭─╯  ', '●─╯    '],
    ['    ╭─◆', '  ╭─╯  ', '●─╯    '],
    ['    ╭─◆', '  ╭─╯  ', '●─╯    '],
  ],
  tool: [
    ['   ', ' ╋ ', '   '],
    ['   ', ' ╳ ', '   '],
  ],
  done: [
    [' ▐███▌ ', '  ▀█▀  ', '  ▄█▄  '],
    ['·▐███▌·', '  ▀█▀  ', '  ▄█▄  '],
  ],
  permission: [
    ['┌──────┐', '│ y/n▌ │', '└──────┘'],
    ['┌──────┐', '│ y/n  │', '└──────┘'],
  ],
  compacting: [
    ['   ╱   ', '  ╱    ', ' ▟ ·:· '],
    ['    ╱  ', '   ╱   ', '  ▟ ·: '],
    ['     ╱ ', '    ╱  ', '   ▟ · '],
  ],
  error: [
    [' ╻  ', ' ┃  ', ' ●  '],
    ['  ╻ ', '  ┃ ', '  ● '],
  ],
  waiting: [
    ['╭───╮', '│ ╵ │', '╰───╯'],
    ['╭───╮', '│ ╶ │', '╰───╯'],
    ['╭───╮', '│ ╷ │', '╰───╯'],
    ['╭───╮', '│ ╴ │', '╰───╯'],
  ],
  testing: [
    ['· ──', '· ──', '· ──'],
    ['✓ ──', '· ──', '· ──'],
    ['✓ ──', '✓ ──', '· ──'],
    ['✓ ──', '✓ ──', '✓ ──'],
  ],
  git: [
    ['  ●─●  ', ' ╱   ╲ ', '●──●──●'],
    ['  ●─◉  ', ' ╱   ╲ ', '●──●──●'],
    ['  ●─●  ', ' ╱   ╲ ', '●──●──◉'],
  ],
  installing: [
    ['  ▼  ', '     ', '╰───╯'],
    ['  │  ', '  ▼  ', '╰───╯'],
    ['  │  ', '  │  ', '╰─▼─╯'],
  ],
  skill: [
    [' ★ ', '   ', '   '],
    ['   ', ' ★ ', '   '],
  ],
  memory: [
    ['  ▼  ', '┌───┐', '│≡≡≡│'],
    ['     ', '┌─▼─┐', '│≡≡≡│'],
    ['     ', '┌─▼─┐', '│≡≡≡│'],
  ],
  sharing: [
    ['     ', '     ', '╰─▲─╯'],
    ['     ', '  ▲  ', '╰─│─╯'],
    ['  ▲  ', '  │  ', '╰───╯'],
  ],
}

// One frame of the crab and its prop, picked by the running tick.
export function sceneRows(activity: Activity, tick: number): { crab: Frame; prop: Frame } {
  const frames: readonly Frame[] = PROPS[activity] ?? [] // the scene comes from another mod: a name this copy lacks draws no prop

  return { crab: crabRows(activity, tick), prop: frames[tick % frames.length] ?? NO_PROP }
}

// What each scene says, drawn beside the crab.
export const LABELS: Record<Activity, string> = {
  idle: 'Claude is resting',
  thinking: 'Claude is thinking',
  reading: 'Claude is reading',
  coding: 'Claude is writing code',
  writing: 'Claude is writing text',
  designing: 'Claude is designing',
  terminal: 'Claude is running a command',
  searching: 'Claude is searching',
  web: 'Claude is browsing the web',
  delegating: 'Claude is putting helpers to work',
  talking: 'Claude is writing a reply',
  asking: 'Claude has a question for you',
  planning: 'Claude is making a plan',
  tool: 'Claude is using a tool',
  done: 'Done!',
  permission: 'Claude is waiting for your permission',
  compacting: 'Claude is tidying up its memory',
  error: 'Oops, that went wrong',
  waiting: 'Claude is waiting on a background task',
  testing: 'Claude is running tests',
  git: 'Claude is working with git',
  installing: 'Claude is installing packages',
  skill: 'Claude is loading a skill',
  memory: 'Claude is remembering something',
  sharing: 'Claude is sharing something with you',
}
