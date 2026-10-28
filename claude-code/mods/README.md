# Mods

Claude Code mods: plugins with a hooks module that can change what Claude Code does and draw their own UI, such as a pane with buttons or a line above the prompt. One folder per mod. Each folder is a complete plugin, with a README based on [`_template/README.md`](../../_template/README.md) that explains how it was built.

| Mod | What it does |
| --- | --- |
| [`blast-radius/`](blast-radius/) | Holds a risky shell command (`rm -rf`, `git reset --hard`, a force push, a migration) and shows what it would change, with Proceed and Cancel buttons. |
| [`replay-theater/`](replay-theater/) | Lets you step through the file edits Claude made in the last turn, one diff at a time. |
| [`token-weather/`](token-weather/) | Draws a live forecast of the context window above the prompt. |

The mods need Claude Code 2.1.287 or later, where mods load by default.

## Install

Try one mod for a single session:

```bash
git clone https://github.com/anthropics/claude-code-playground.git
cd claude-code-playground/claude-code/mods
claude --plugin-dir ./token-weather
```

Or add this folder as a local marketplace, then install the ones you want:

```bash
claude plugin marketplace add ./
claude plugin install token-weather@claude-code-playground-mods --scope user
```

See the [Claude Code plugins documentation](https://code.claude.com/docs/en/plugins) for how plugins and marketplaces work, and for how to review a plugin before you install it.

## Imported from claude-code-mods

The other 21 folders here are copied from [hamzafer/claude-code-mods](https://github.com/hamzafer/claude-code-mods) by Hamza Zafar, under the MIT License (see the `LICENSE` file in each folder), except for two changed afterwards: `context-bar` gained an info row (folder, git branch, model, effort) taken from a local model-effort-band mod; and `mission-control` absorbed the crab from [sTomerG/agent-kit](https://github.com/sTomerG/agent-kit)'s crab-cam (MIT, noted in its `LICENSE`), which acts out what Claude is doing at the foot of every view of its pane (`/mission crab` hides it, `/mission demo` plays every scene), and took in the upstream `agent-radar` mod as its Agents tab: a card per subagent whose page shows the whole conversation, with buttons to open an agent's transcript in the main view and to ask it to stop, plus a band line per running subagent and a toast when one finishes (`/radar` opens the tab). Each of its views scrolls with the wheel, the tabs and the crab staying put. The pane opens with each interactive session (the `openOnStart` option turns that off). Its views are saved in its store when a turn and the session end, so `claude --continue` or `--resume` draws them again; `/clear` saves nothing. If you installed `agent-radar` before, uninstall it, or its band line and `/radar` show twice. They are not written by Anthropic, have no README of their own and have not been through `_template/PREFLIGHT.md`. Try one with `claude --plugin-dir ./<name>`; read the code before you install it.

browser-lanes, cache-clock, context-bar, glance, heatmap, md-preview, merge-gate, mission-control, next-steps, now-playing, openai-balance, openrouter-balance, prayer-times, reels, review-watch, rulebook-guard, session-saver, snake, switchboard, usage-meter, where-am-i
