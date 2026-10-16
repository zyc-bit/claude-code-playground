// The crab at the pane's foot: three rows of block glyphs, with the scene's
// prop beside it as a few frames of glyphs picked by the running tick, and the
// words each scene says. The scenes come from crab-cam
// (https://github.com/sTomerG/agent-kit), which draws them above the prompt.
import type { Activity } from '../types'

export const CRAB_ROWS = [' ▐▛███▜▌ ', '▝▜█████▛▘', '  ▘▘ ▝▝  '] as const

type Frame = readonly [string, string, string]

const NO_PROP: Frame = ['', '', '']

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
  const frames = PROPS[activity]

  return { crab: CRAB_ROWS, prop: frames[tick % frames.length] ?? NO_PROP }
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

// Every scene, in the order the demo plays them.
export const DEMO: readonly Activity[] = [
  'thinking',
  'reading',
  'coding',
  'writing',
  'designing',
  'terminal',
  'testing',
  'git',
  'installing',
  'searching',
  'web',
  'delegating',
  'planning',
  'skill',
  'memory',
  'tool',
  'sharing',
  'waiting',
  'permission',
  'error',
  'compacting',
  'talking',
  'asking',
  'done',
]
