import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TokenCategory, TokenSnapshot } from '../types'

const PANE = 'token-breakdown'
const snapshot = atom({ plugin: 'token-breakdown', key: 'snapshot' } as const, null)
const isBandHidden = atom({ plugin: 'token-breakdown', key: 'isBandHidden' } as const, false)

// Refreshes triggered by tool calls are throttled; turn ends always refresh.
const TOOL_REFRESH_MS = 3000

export const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

const bar = (fraction: number, width: number): string => {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const percentColor = (percent: number): string =>
  percent >= 85 ? 'error' : percent >= 60 ? 'warning' : 'success'

let inFlight: Promise<void> | null = null
let lastToolRefresh = 0

// Concurrent callers share one in-flight read, so an awaited refresh always
// sees fresh data.
function refresh($: EngineInterface): Promise<void> {
  inFlight ??= takeReading($).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function takeReading($: EngineInterface) {
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

    const next: TokenSnapshot = {
      total: b.totalTokens,
      window: b.rawMaxTokens,
      percent: b.percentage,
      model: b.model,
      categories: b.categories.map(c => ({
        name: c.name,
        tokens: c.tokens,
        color: c.color,
        kind: c.kind,
      })),
      memoryFiles: b.memoryFiles
        .map(f => ({ path: f.path, type: f.type, tokens: f.tokens }))
        .sort((a, z) => z.tokens - a.tokens),
      mcpServers: [...servers]
        .map(([name, s]) => ({ name, ...s }))
        .sort((a, z) => z.tokens - a.tokens),
      skills: (b.skills?.skillFrontmatter ?? [])
        .map(s => ({ name: s.name, tokens: s.tokens }))
        .sort((a, z) => z.tokens - a.tokens),
      at: await $.clock.now(),
    }
    await update($, snapshot, () => next)
  } catch {
    // No session bound yet, or the breakdown failed: keep the last snapshot.
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({
      name: 'tokens',
      description: 'Token breakdown: no args opens the detail pane; "hide"/"show" toggles the band',
    })
    void refresh($)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    void refresh($)
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    void refresh($)
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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isBandHidden))) return next(e)
    const snap = await read($, snapshot)
    if (!snap) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const used = snap.categories.filter(c => c.kind === 'used' && c.tokens > 0)
    const free = snap.categories.find(c => c.kind === 'free')
    const buffer = snap.categories.find(c => c.kind === 'buffer')
    const barWidth = Math.max(10, Math.min(30, e.props.bodyColumns - 40))

    return (
      <Box flexDirection="column">
        <Text wrap="truncate">
          <Text bold>Context </Text>
          <Text color={percentColor(snap.percent)}>{bar(snap.percent / 100, barWidth)}</Text>
          <Text bold>
            {' '}
            {formatTokens(snap.total)} / {formatTokens(snap.window)}
          </Text>
          <Text color={percentColor(snap.percent)}> ({snap.percent}%)</Text>
        </Text>
        <Text wrap="wrap">
          {used.map((c, i) => (
            <Text>
              {i > 0 ? <Text dimColor> · </Text> : ''}
              <Text color={c.color}>■ </Text>
              {c.name} <Text bold>{formatTokens(c.tokens)}</Text>
            </Text>
          ))}
          {free ? <Text dimColor> · free {formatTokens(free.tokens)}</Text> : ''}
          {buffer ? <Text dimColor> · buffer {formatTokens(buffer.tokens)}</Text> : ''}
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    if (!snap) return <Text dimColor>No reading yet: it arrives after the first response.</Text>

    const cols = e.props.bodyColumns
    const nameWidth = 22
    const barWidth = Math.max(6, cols - nameWidth - 16)
    const row = (c: TokenCategory) => {
      const share = snap.window > 0 ? c.tokens / snap.window : 0
      const pct = (share * 100).toFixed(1).padStart(5)
      return (
        <Text wrap="truncate">
          <Text color={c.color}>{bar(share, barWidth)}</Text> {c.name.padEnd(nameWidth).slice(0, nameWidth)}
          <Text bold>{formatTokens(c.tokens).padStart(6)}</Text>
          <Text dimColor> {pct}%</Text>
        </Text>
      )
    }
    const shown = snap.categories.filter(c => c.kind !== 'deferred')
    const deferred = snap.categories.filter(c => c.kind === 'deferred' && c.tokens > 0)
    const top = <T,>(list: T[], n: number) => list.slice(0, n)
    const shortPath = (p: string) => (p.length > cols - 12 ? `…${p.slice(-(cols - 13))}` : p)

    return (
      <Box flexDirection="column">
        <Text bold>
          {formatTokens(snap.total)} / {formatTokens(snap.window)} tokens{' '}
          <Text color={percentColor(snap.percent)}>({snap.percent}%)</Text>
        </Text>
        <Text dimColor>{snap.model}</Text>
        <Text> </Text>
        {shown.map(row)}
        {deferred.length > 0 && (
          <Text dimColor>
            Deferred (not in window): {deferred.map(c => `${c.name} ${formatTokens(c.tokens)}`).join(', ')}
          </Text>
        )}
        {snap.memoryFiles.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Memory files</Text>
            {top(snap.memoryFiles, 6).map(f => (
              <Text wrap="truncate">
                <Text bold>{formatTokens(f.tokens).padStart(6)}</Text> <Text dimColor>{f.type}</Text> {shortPath(f.path)}
              </Text>
            ))}
          </Box>
        )}
        {snap.mcpServers.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>MCP servers</Text>
            {top(snap.mcpServers, 6).map(s => (
              <Text wrap="truncate">
                <Text bold>{formatTokens(s.tokens).padStart(6)}</Text> {s.name} <Text dimColor>({s.tools} tools)</Text>
              </Text>
            ))}
          </Box>
        )}
        {snap.skills.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Top skills</Text>
            {top(snap.skills, 5).map(s => (
              <Text wrap="truncate">
                <Text bold>{formatTokens(s.tokens).padStart(6)}</Text> {s.name}
              </Text>
            ))}
          </Box>
        )}
        <Text> </Text>
        <Text dimColor>Estimated like /context (summary mode). /tokens hide · /tokens show</Text>
      </Box>
    )
  })
}
