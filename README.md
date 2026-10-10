# claude-code-mods

Personal [Claude Code mods](https://claude.dev/blog/getting-started-with-claude-code-mods/). The repo is a plugin marketplace, so you can install any mod in it with one line.

## token-breakdown

Shows the context window's token usage above the prompt the whole time: the total, then each category (system prompt, system tools, memory files, skills, messages, free space, autocompact buffer). It's the same breakdown `/context` gives you, without having to run it.

```
Context ███████░░░░░░░░░░░░░░░░░░░░░░░ 52.0k / 200k (26%)
■ System prompt 3.2k · ■ System tools 12.0k · ■ Memory files 4.5k · ■ Messages 32.3k · free 115k · buffer 33.0k
```

- `/tokens` opens a detail pane with a bar per category and the biggest memory files, MCP servers and skills.
- `/tokens hide` and `/tokens show` turn the band above the prompt off and on.
- It refreshes after every turn, after compaction, and at most every 3 seconds while tools run.
- It uses Claude Code's local `summary` estimate, so it makes no extra API calls. The figures can differ a little from `/context`, which counts with the token-count API.

### Install

```
/plugin install token-breakdown --marketplace zh10only1/claude-code-mods
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

Requires Claude Code 2.1.287 or later.

## Development

```
claude plugin validate token-breakdown
claude plugin test token-breakdown
claude --plugin-dir ./token-breakdown   # hot-reloads on save
```
