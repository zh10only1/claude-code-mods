# claude-code-mods

Personal mods for [Claude Code](https://claude.dev/blog/getting-started-with-claude-code-mods/), the terminal AI coding tool. A mod is a small plugin that changes Claude Code's own interface or behaviour. This repo is a plugin **marketplace**, so every mod in it installs with one line.

| Mod | What it does |
| --- | --- |
| [`token-breakdown`](#token-breakdown) | Shows your context window's token usage above the prompt the whole time, split into categories |

## Quick install

Inside Claude Code (2.1.287 or later), run:

```
/plugin install token-breakdown --marketplace zh10only1/claude-code-mods
```

1. Answer **`y`** when it asks to add the `zh10only1/claude-code-mods` marketplace.
2. Choose a scope. **User** loads the mod in every session, and **Project** loads it in the current repo only.
3. It starts working right away, with no restart needed.

Or add the marketplace once, then pick mods from it:

```
/plugin marketplace add zh10only1/claude-code-mods
/plugin install token-breakdown@zh10only1-mods
```

**Update** to the latest version:

```
/plugin marketplace update zh10only1-mods
/reload-plugins
```

**Remove:** `/plugin uninstall token-breakdown@zh10only1-mods`

> Mods run with the same access as Claude Code itself. Read the source before installing any mod, these included. Everything here is in plain TypeScript under each mod's `hooks/` folder.

---

## token-breakdown

This shows what `/context` shows, without having to run it. A live gauge sits above the prompt:

```
◑ CONTEXT  52.0k / 200k  26%  ▲ 3.1k  ▁▂▂▃▄▅
████▆▆▆▆▆▆▆▆▆▆▆▆████████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▚▚▚▚▚▚▚▚▚
● System 3.2k  ● Tools 12.0k  ● Memory 4.5k  ● Skills 1.1k  ● Messages 32.3k  ░ Free 115k
```

- **The header** has a moon that fills as the window fills (○ ◔ ◑ ◕ ●). The percentage shifts from green to amber to red as it climbs. You also get the tokens added this turn and a sparkline of recent turns.
- **The ribbon** shows the whole window as one stacked bar. Each category gets its own colour, then the free space (`░`) and the autocompact reserve (`▚`).
- **The legend** shows each category's colour and size.

Commands:

| Command | Effect |
| --- | --- |
| `/tokens` | Opens a detail pane: per-category bars with share of the window, plus the largest memory files, MCP servers and skills |
| `/tokens hide` | Hides the band above the prompt |
| `/tokens show` | Brings the band back |

It refreshes after every turn, after compaction, and at most every 3 seconds while tools run. It uses Claude Code's local `summary` estimate, so it **makes no extra API calls**. The figures can differ slightly from `/context`, which counts with the token-count API.

---

## Developing a mod

```
claude --plugin-dir ./token-breakdown    # run it; saves hot-reload
claude plugin validate ./token-breakdown # check manifest + hooks module
claude plugin test ./token-breakdown     # run tests/*.test.ts
```

New mods go in their own folder, with an entry added to `.claude-plugin/marketplace.json`.
