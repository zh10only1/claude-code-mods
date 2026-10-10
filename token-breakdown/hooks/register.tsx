import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TokenCategory, TokenSnapshot } from '../types'

const PANE = 'token-breakdown'
const snapshot = atom({ plugin: 'token-breakdown', key: 'snapshot' } as const, null)
const isBandHidden = atom({ plugin: 'token-breakdown', key: 'isBandHidden' } as const, false)

// Refreshes triggered by tool calls are throttled; turn ends always refresh.
const TOOL_REFRESH_MS = 3000
const HISTORY_LENGTH = 16

// ── Palette ─────────────────────────────────────────────────────────────────
// Mid-tone colours that read on dark and light terminals alike.

const PALETTE: Record<string, { color: string; short: string }> = {
  'System prompt': { color: '#c4a7e7', short: 'System' },
  'System tools': { color: '#7aa2f7', short: 'Tools' },
  'MCP tools': { color: '#7dcfff', short: 'MCP' },
  'Custom agents': { color: '#bb9af7', short: 'Agents' },
  'Memory files': { color: '#e0af68', short: 'Memory' },
  Skills: { color: '#9ece6a', short: 'Skills' },
  Messages: { color: '#f7768e', short: 'Messages' },
}
const FALLBACK = ['#2ac3de', '#ff9e64', '#73daca', '#b4f9f8', '#ff007c']
const FREE = '#565f89'
const BUFFER = '#9d7cd8'
const MUTED = '#737aa2'

const GREEN = '#9ece6a'
const AMBER = '#e0af68'
const RED = '#f7768e'

const styleOf = (name: string, index: number) =>
  PALETTE[name] ?? { color: FALLBACK[index % FALLBACK.length] ?? MUTED, short: name }

// ── Formatting ──────────────────────────────────────────────────────────────

export const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

const hex = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))
const mix = (a: string, z: string, t: number) => {
  const [x, y] = [hex(a), hex(z)]
  return `#${x.map((v, i) => Math.round(v + ((y[i] ?? v) - v) * t).toString(16).padStart(2, '0')).join('')}`
}

// Green → amber → red as the window fills.
export const heat = (percent: number): string => {
  const p = Math.max(0, Math.min(100, percent))
  return p < 50 ? mix(GREEN, AMBER, p / 50) : mix(AMBER, RED, (p - 50) / 50)
}

const MOONS = ['○', '◔', '◑', '◕', '●']
const moon = (percent: number) => MOONS[Math.min(4, Math.floor(percent / 20))] ?? '●'

const SPARKS = '▁▂▃▄▅▆▇█'
const spark = (percent: number) => SPARKS[Math.max(0, Math.min(7, Math.round((percent / 100) * 7)))] ?? '▁'

const shortPath = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~')

// ── The ribbon: the whole window as one stacked bar ─────────────────────────

type Segment = { key: string; cells: number; color: string; glyph: string }

// Largest-remainder split of `width` cells, every non-empty used row getting
// at least one so a small category never vanishes.
export const ribbon = (snap: TokenSnapshot, width: number): Segment[] => {
  const rows = snap.categories.filter(c => c.kind !== 'deferred' && c.tokens > 0)
  const window = rows.reduce((sum, c) => sum + c.tokens, 0) || 1
  const exact = rows.map(c => (c.tokens / window) * width)
  const cells = exact.map((x, i) => Math.max(rows[i]?.kind === 'used' ? 1 : 0, Math.floor(x)))
  let left = width - cells.reduce((a, b) => a + b, 0)
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, z) => z.r - a.r)
  for (let k = 0; left > 0 && order.length > 0; k = (k + 1) % order.length, left--) {
    const i = order[k]?.i ?? 0
    cells[i] = (cells[i] ?? 0) + 1
  }
  // Over budget from the minimums: take it back from the free space.
  const free = rows.findIndex(c => c.kind === 'free')
  if (left < 0 && free >= 0) cells[free] = Math.max(0, (cells[free] ?? 0) + left)

  let used = 0
  return rows.map((c, i) => {
    const style = c.kind === 'used' ? styleOf(c.name, used++) : null
    return {
      key: c.name,
      cells: cells[i] ?? 0,
      color: style?.color ?? (c.kind === 'free' ? FREE : BUFFER),
      glyph: c.kind === 'used' ? '█' : c.kind === 'free' ? '░' : '▚',
    }
  })
}

// ── Readings ────────────────────────────────────────────────────────────────

let inFlight: Promise<void> | null = null
let lastToolRefresh = 0

// Concurrent callers share one in-flight read, so an awaited refresh always
// sees fresh data. A turn end also records the reading in the history.
function refresh($: EngineInterface, isTurnEnd = false): Promise<void> {
  const run = (inFlight ?? Promise.resolve()).then(() => takeReading($, isTurnEnd))
  inFlight = run.finally(() => {
    if (inFlight === run) inFlight = null
  })
  return run
}

async function takeReading($: EngineInterface, isTurnEnd: boolean) {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const b = usage.context.breakdown
    if (!b) return

    const servers = new Map<string, { tokens: number; tools: number }>()
    for (const tool of b.mcpTools) {
      if (!tool.isLoaded) continue
      const s = servers.get(tool.serverName) ?? { tokens: 0, tools: 0 }
      servers.set(tool.serverName, { tokens: s.tokens + tool.tokens, tools: s.tools + 1 })
    }

    const prev = await read($, snapshot)
    const turnBase = prev?.turnBase ?? b.totalTokens
    const history = prev?.history ?? []

    const next: TokenSnapshot = {
      total: b.totalTokens,
      window: b.rawMaxTokens,
      percent: b.percentage,
      model: b.model,
      categories: b.categories.map(c => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind })),
      memoryFiles: b.memoryFiles
        .map(f => ({ path: f.path, type: f.type, tokens: f.tokens }))
        .sort((a, z) => z.tokens - a.tokens),
      mcpServers: [...servers].map(([name, s]) => ({ name, ...s })).sort((a, z) => z.tokens - a.tokens),
      skills: (b.skills?.skillFrontmatter ?? [])
        .map(s => ({ name: s.name, tokens: s.tokens }))
        .sort((a, z) => z.tokens - a.tokens),
      delta: b.totalTokens - turnBase,
      history: isTurnEnd ? [...history, b.percentage].slice(-HISTORY_LENGTH) : history,
      turnBase: isTurnEnd ? b.totalTokens : turnBase,
      at: await $.clock.now(),
    }
    await update($, snapshot, () => next)
  } catch {
    // No session bound yet, or the breakdown failed: keep the last snapshot.
  }
}

// ── Hooks ───────────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({
      name: 'tokens',
      description: 'Token breakdown: no args opens the detail pane; "hide"/"show" toggles the band',
    })
    void refresh($, true)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    void refresh($, true)
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    void refresh($, true)
    return r
  })
    // Observer only: never block a compaction if the refresh path throws.
    .catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    const now = await $.clock.now()
    if (now - lastToolRefresh >= TOOL_REFRESH_MS) {
      lastToolRefresh = now
      void refresh($)
    }
    return r
  })
    // Observer only: never block or rerun a tool call.
    .catch(($, e, next) => next(e))

  on('command.run', { command: 'tokens' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'hide') {
      await update($, isBandHidden, () => true)
      return { text: 'Token band hidden. /tokens show brings it back.' }
    }
    if (arg === 'show') {
      await update($, isBandHidden, () => false)
      await refresh($)
      return { text: 'Token band shown.' }
    }
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Tokens' })
    return { text: 'Token breakdown pane opened.' }
  })

  // ── Band above the prompt ─────────────────────────────────────────────────
  //   ◑ CONTEXT  52.0k / 200k  26%  +3.1k  ▁▂▃▅▆
  //   ██████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░▚▚▚▚▚▚▚
  //   ● System 3.2k  ● Tools 12.0k  ● Memory 4.5k  ● Messages 32.3k  ░ Free 115k

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isBandHidden))) return next(e)
    const snap = await read($, snapshot)
    if (!snap) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(10, e.props.bodyColumns - 1)
    const tone = heat(snap.percent)
    const used = snap.categories.filter(c => c.kind === 'used' && c.tokens > 0)
    const free = snap.categories.find(c => c.kind === 'free')

    return (
      <Box flexDirection="column">
        <Text wrap="truncate">
          <Text color={tone}>{moon(snap.percent)} </Text>
          <Text bold color={tone}>
            CONTEXT
          </Text>
          <Text color={MUTED}>{'  '}</Text>
          <Text bold>{formatTokens(snap.total)}</Text>
          <Text color={MUTED}> / {formatTokens(snap.window)}</Text>
          <Text bold color={tone}>
            {'  '}
            {snap.percent}%
          </Text>
          {snap.delta !== 0 ? (
            <Text color={snap.delta > 0 ? AMBER : GREEN}>
              {'  '}
              {snap.delta > 0 ? '▲' : '▼'} {formatTokens(Math.abs(snap.delta))}
            </Text>
          ) : (
            ''
          )}
          {snap.history.length > 1 ? (
            <Text>
              {'  '}
              {snap.history.map(p => (
                <Text color={heat(p)}>{spark(p)}</Text>
              ))}
            </Text>
          ) : (
            ''
          )}
        </Text>
        <Text wrap="truncate">
          {ribbon(snap, width).map(s => (
            <Text color={s.color}>{s.glyph.repeat(s.cells)}</Text>
          ))}
        </Text>
        <Text wrap="wrap">
          {used.map((c, i) => {
            const style = styleOf(c.name, i)
            return (
              <Text>
                <Text color={style.color}>● </Text>
                <Text color={MUTED}>{style.short} </Text>
                <Text bold>{formatTokens(c.tokens)}</Text>
                {'  '}
              </Text>
            )
          })}
          {free ? (
            <Text>
              <Text color={FREE}>░ </Text>
              <Text color={MUTED}>Free {formatTokens(free.tokens)}</Text>
            </Text>
          ) : (
            ''
          )}
        </Text>
      </Box>
    )
  })

  // ── Detail pane (/tokens) ─────────────────────────────────────────────────

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    if (!snap) return <Text color={MUTED}>No reading yet: it arrives after the first response.</Text>

    const cols = Math.max(30, e.props.bodyColumns)
    const tone = heat(snap.percent)
    const nameWidth = 18
    const barWidth = Math.max(6, cols - nameWidth - 18)
    const rows = snap.categories.filter(c => c.kind !== 'deferred')
    const deferred = snap.categories.filter(c => c.kind === 'deferred' && c.tokens > 0)
    const largest = Math.max(1, ...rows.map(c => c.tokens))

    let usedIndex = 0
    const row = (c: TokenCategory) => {
      const color = c.kind === 'used' ? styleOf(c.name, usedIndex++).color : c.kind === 'free' ? FREE : BUFFER
      const filled = Math.max(c.tokens > 0 ? 1 : 0, Math.round((c.tokens / largest) * barWidth))
      const share = snap.window > 0 ? ((c.tokens / snap.window) * 100).toFixed(1) : '0.0'
      return (
        <Text wrap="truncate">
          <Text color={color}>● </Text>
          <Text color={c.kind === 'used' ? undefined : MUTED}>{c.name.padEnd(nameWidth).slice(0, nameWidth)}</Text>
          <Text color={color}>{'━'.repeat(filled)}</Text>
          <Text color={FREE}>{'─'.repeat(barWidth - filled)}</Text>
          <Text bold> {formatTokens(c.tokens).padStart(6)}</Text>
          <Text color={MUTED}> {share.padStart(5)}%</Text>
        </Text>
      )
    }

    const section = (title: string, color: string) => (
      <Text>
        <Text color={color}>▍</Text>
        <Text bold color={color}>
          {title}
        </Text>
      </Text>
    )
    const branch = (i: number, n: number) => <Text color={FREE}>{i === n - 1 ? '└─ ' : '├─ '}</Text>
    const memory = snap.memoryFiles.slice(0, 6)
    const servers = snap.mcpServers.slice(0, 6)
    const skills = snap.skills.slice(0, 5)

    return (
      <Box flexDirection="column">
        <Text wrap="truncate">
          <Text color={tone}>{moon(snap.percent)} </Text>
          <Text bold color={tone}>
            CONTEXT WINDOW
          </Text>
          <Text color={MUTED}>{'  '}{snap.model}</Text>
        </Text>
        <Text wrap="truncate">
          <Text bold>{formatTokens(snap.total)}</Text>
          <Text color={MUTED}> of {formatTokens(snap.window)}</Text>
          <Text bold color={tone}>
            {'  '}
            {snap.percent}%
          </Text>
          {snap.delta !== 0 ? (
            <Text color={snap.delta > 0 ? AMBER : GREEN}>
              {'  '}
              {snap.delta > 0 ? '▲' : '▼'} {formatTokens(Math.abs(snap.delta))} this turn
            </Text>
          ) : (
            ''
          )}
        </Text>
        <Text wrap="truncate">
          {ribbon(snap, cols - 1).map(s => (
            <Text color={s.color}>{s.glyph.repeat(s.cells)}</Text>
          ))}
        </Text>
        {snap.history.length > 1 ? (
          <Text wrap="truncate">
            <Text color={MUTED}>last {snap.history.length} turns </Text>
            {snap.history.map(p => (
              <Text color={heat(p)}>{spark(p)}</Text>
            ))}
          </Text>
        ) : (
          ''
        )}

        <Box flexDirection="column" marginTop={1}>
          {section('CATEGORIES', '#7aa2f7')}
          {rows.map(row)}
          {deferred.length > 0 ? (
            <Text color={MUTED} wrap="truncate">
              {'  '}on demand, outside the window:{' '}
              {deferred.map(c => `${c.name} ${formatTokens(c.tokens)}`).join(' · ')}
            </Text>
          ) : (
            ''
          )}
        </Box>

        {memory.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            {section('MEMORY FILES', '#e0af68')}
            {memory.map((f, i) => (
              <Text wrap="truncate-middle">
                {branch(i, memory.length)}
                <Text bold>{formatTokens(f.tokens).padStart(6)}</Text>
                <Text color="#e0af68"> {f.type.padEnd(8)}</Text>
                <Text color={MUTED}>{shortPath(f.path)}</Text>
              </Text>
            ))}
          </Box>
        ) : (
          ''
        )}

        {servers.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            {section('MCP SERVERS', '#7dcfff')}
            {servers.map((s, i) => (
              <Text wrap="truncate">
                {branch(i, servers.length)}
                <Text bold>{formatTokens(s.tokens).padStart(6)}</Text>
                <Text color="#7dcfff"> {s.name}</Text>
                <Text color={MUTED}> · {s.tools} tools</Text>
              </Text>
            ))}
          </Box>
        ) : (
          ''
        )}

        {skills.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            {section('TOP SKILLS', '#9ece6a')}
            {skills.map((s, i) => (
              <Text wrap="truncate">
                {branch(i, skills.length)}
                <Text bold>{formatTokens(s.tokens).padStart(6)}</Text>
                <Text color="#9ece6a"> {s.name}</Text>
              </Text>
            ))}
          </Box>
        ) : (
          ''
        )}

        <Box marginTop={1}>
          <Text color={FREE}>estimated like /context · /tokens hide · /tokens show</Text>
        </Box>
      </Box>
    )
  })
}
