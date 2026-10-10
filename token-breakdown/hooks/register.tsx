import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TokenCategory, TokenSnapshot } from '../types'

const PANE = 'token-breakdown'
const snapshot = atom({ plugin: 'token-breakdown', key: 'snapshot' } as const, null)
const isBandHidden = atom({ plugin: 'token-breakdown', key: 'isBandHidden' } as const, false)
const effortLevel = atom({ plugin: 'token-breakdown', key: 'effort' } as const, null)

// Refreshes triggered by tool calls are throttled; turn ends always refresh.
const TOOL_REFRESH_MS = 3000
const HISTORY_LENGTH = 16
const METER_WIDTH = 30

// ── Neon palette ────────────────────────────────────────────────────────────

const CYAN = '#05d9e8'
const PURPLE = '#7b2cff'
const MAGENTA = '#d300c5'
const PINK = '#ff2a6d'
const YELLOW = '#fcee0c'
const TRACK = '#3b1f5c'
const HAZE = '#8a6fb3'

const LABELS: Record<string, string> = {
  'System prompt': 'SYS',
  'System tools': 'TOOLS',
  'MCP tools': 'MCP',
  'Custom agents': 'AGENTS',
  'Memory files': 'MEM',
  Skills: 'SKILLS',
  Messages: 'MSG',
  'Free space': 'FREE',
  'Autocompact buffer': 'BUFFER',
}
const labelOf = (name: string) => LABELS[name] ?? name.toUpperCase()

// ── Formatting ──────────────────────────────────────────────────────────────

export const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}K`
  return String(Math.round(n))
}

const hex = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))
const mix = (a: string, z: string, t: number) => {
  const [x, y] = [hex(a), hex(z)]
  return `#${x.map((v, i) => Math.round(v + ((y[i] ?? v) - v) * t).toString(16).padStart(2, '0')).join('')}`
}

// Synthwave sweep: cyan → purple → pink, t from 0 to 1.
export const neon = (t: number): string => {
  const p = Math.max(0, Math.min(1, t))
  return p < 0.5 ? mix(CYAN, PURPLE, p / 0.5) : mix(PURPLE, PINK, (p - 0.5) / 0.5)
}

const levelColor = (percent: number) => (percent >= 85 ? PINK : percent >= 60 ? YELLOW : CYAN)

const SPARKS = '▁▂▃▄▅▆▇█'
const spark = (percent: number) => SPARKS[Math.max(0, Math.min(7, Math.round((percent / 100) * 7)))] ?? '▁'

const shortPath = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~')

// claude-opus-5-5 → Claude Opus 5.5; a date suffix dropped, [1m] kept.
export const prettyModel = (id: string): string => {
  const wide = /\[1m\]/i.test(id) ? ' 1M' : ''
  const base = id.replace(/\[.*?\]/g, '').trim()
  if (!base.startsWith('claude-')) return base + wide
  const parts = base.slice('claude-'.length).split('-').filter(p => !/^\d{8}$/.test(p))
  const words = parts.filter(p => !/^\d+$/.test(p)).map(p => p[0]?.toUpperCase() + p.slice(1))
  const version = parts.filter(p => /^\d+$/.test(p)).join('.')
  return ['Claude', ...words, version].filter(Boolean).join(' ') + wide
}

const EFFORT_COLORS: Record<string, string> = {
  low: '#05d9e8',
  medium: '#7b2cff',
  high: '#d300c5',
  xhigh: '#ff2a6d',
  max: '#fcee0c',
}

// Top-right of the frame: model, then the effort it runs at.
const modelTag = (model: string, effort: string | null): Seg[] => {
  const tag: Seg[] = model ? [{ t: ` ${prettyModel(model)} `, c: HAZE }] : effort ? [{ t: ' ' }] : []
  if (effort) tag.push({ t: '◆ ', c: PURPLE }, { t: `${effort.toUpperCase()} `, c: EFFORT_COLORS[effort] ?? CYAN, b: true })
  return tag
}

// ── Lines as plain segments ─────────────────────────────────────────────────
// Every line is built as coloured segments first, so its width is known
// exactly and the hand-drawn frame always closes.

export type Seg = { t: string; c?: string; b?: boolean }

export const widthOf = (segs: Seg[]) => segs.reduce((n, s) => n + [...s.t].length, 0)

// Cuts or pads a run of segments to exactly `width` cells.
export const fit = (segs: Seg[], width: number): Seg[] => {
  const out: Seg[] = []
  let left = width
  for (const s of segs) {
    if (left <= 0) break
    const chars = [...s.t]
    if (chars.length <= left) {
      out.push(s)
      left -= chars.length
    } else {
      out.push({ ...s, t: `${chars.slice(0, Math.max(0, left - 1)).join('')}…` })
      left = 0
    }
  }
  if (left > 0) out.push({ t: ' '.repeat(left) })
  return out
}

// A run of `glyph` whose colour sweeps the neon gradient from t0 to t1,
// grouped into a few steps so the tree stays small.
const sweep = (glyph: string, count: number, t0: number, t1: number, steps = 24): Seg[] => {
  const out: Seg[] = []
  for (let i = 0; i < count; ) {
    const run = Math.max(1, Math.ceil(count / steps))
    const n = Math.min(run, count - i)
    out.push({ t: glyph.repeat(n), c: neon(t0 + ((t1 - t0) * (i + n / 2)) / Math.max(1, count)) })
    i += n
  }
  return out
}

// The meter: filled cells take the gradient by position, so the bar turns
// from cyan to hot pink as the window fills.
export const meter = (fraction: number, width: number): Seg[] => {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)))
  return [...sweep('▰', filled, 0, filled / Math.max(1, width)), { t: '▱'.repeat(width - filled), c: TRACK }]
}

const delta = (snap: TokenSnapshot): Seg[] =>
  snap.delta === 0
    ? []
    : [{ t: `  ${snap.delta > 0 ? '▲' : '▼'}${formatTokens(Math.abs(snap.delta))}`, c: snap.delta > 0 ? MAGENTA : CYAN }]

// ── The band: a framed HUD ──────────────────────────────────────────────────
//   ╭─◢ CONTEXT//TOKENS ◣──────────────────────────── claude-opus-5-5 ─╮
//   │ ▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱  52.0K / 200K  26%  ▲3.1K │
//   │ SYS 3.2K ╱ TOOLS 12.0K ╱ MEM 4.5K ╱ SKILLS 1.1K ╱ MSG 32.3K ╱ FREE 115K │
//   ╰─────────────────────────────────────────────────────── ▁▂▃▄▅▆ ─╯

export const bandLines = (snap: TokenSnapshot, width: number, effort: string | null = null): Seg[][] => {
  const available = Math.max(30, width)
  const level = levelColor(snap.percent)

  // Title and model, for the top edge.
  const title: Seg[] = [
    { t: '╭─', c: CYAN },
    { t: '◢ ', c: PINK },
    { t: 'CONTEXT', c: CYAN, b: true },
    { t: '//', c: MAGENTA, b: true },
    { t: 'TOKENS', c: PINK, b: true },
    { t: ' ◣', c: PINK },
  ]
  const fullTag = modelTag(snap.model, effort)

  // Row one: a fixed-length meter and the figures.
  const figures: Seg[] = [
    { t: '  ' },
    { t: formatTokens(snap.total), b: true },
    { t: ' / ', c: HAZE },
    { t: formatTokens(snap.window), c: HAZE },
    { t: `  ${snap.percent}%`, c: level, b: true },
    ...delta(snap),
    ...(snap.percent >= 85 ? [{ t: '  ⚠ COMPACT SOON', c: PINK, b: true }] : []),
  ]
  const meterWidth = Math.max(8, Math.min(METER_WIDTH, available - 4 - widthOf(figures)))
  const rowOne = [...meter(snap.percent / 100, meterWidth), ...figures]

  // Row two: each category's readout.
  const shown = snap.categories.filter(c => (c.kind === 'used' || c.kind === 'free') && c.tokens > 0)
  const rowTwo: Seg[] = shown.flatMap((c, i) => [
    ...(i > 0 ? [{ t: ' ╱ ', c: PURPLE }] : []),
    { t: `${labelOf(c.name)} `, c: c.kind === 'free' ? HAZE : CYAN },
    { t: formatTokens(c.tokens), b: c.kind !== 'free', c: c.kind === 'free' ? HAZE : undefined },
  ])

  // Bottom edge: the per-turn trend sits in the frame.
  const trend: Seg[] =
    snap.history.length > 1
      ? [{ t: ' ' }, ...snap.history.map(p => ({ t: spark(p), c: neon(p / 100) })), { t: ' ' }]
      : []

  const W = available
  const inner = W - 4
  // A narrow band drops the model name first, then the effort.
  const room = W - widthOf(title) - 2
  const model = [fullTag, modelTag('', effort), []].find(tag => widthOf(tag) <= room) ?? []

  const top = [...title, ...sweep('─', Math.max(0, W - widthOf(title) - widthOf(model) - 2), 0.1, 0.9), ...model, { t: '─╮', c: PINK }]
  const bottom = [{ t: '╰', c: CYAN }, ...sweep('─', W - 3 - widthOf(trend), 0, 0.9), ...trend, { t: '─╯', c: PINK }]
  const side = (segs: Seg[]): Seg[] => [{ t: '│ ', c: CYAN }, ...fit(segs, inner), { t: ' │', c: PINK }]

  return [top, side(rowOne), side(rowTwo), bottom]
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

  // The main loop's requests say which effort they run at.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId && e.effort !== undefined) {
      const effort = String(e.effort)
      // Observer only: recorded off the request's path, never holding it up.
      void read($, effortLevel)
        .then(current => (current === effort ? undefined : update($, effortLevel, () => effort)))
        .catch(() => undefined)
    }
    return yield* next(e)
  })

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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isBandHidden))) return next(e)
    const snap = await read($, snapshot)
    if (!snap) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {bandLines(snap, e.props.bodyColumns, await read($, effortLevel)).map(line => (
          <Text wrap="truncate">
            {line.map(s => (
              <Text color={s.c} bold={s.b}>
                {s.t}
              </Text>
            ))}
          </Text>
        ))}
      </Box>
    )
  })

  // ── Detail pane (/tokens) ─────────────────────────────────────────────────

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    if (!snap) return <Text color={HAZE}>// NO SIGNAL — first reading lands after the next response</Text>

    const W = Math.max(30, e.props.bodyColumns)
    const draw = (segs: Seg[]) => (
      <Text wrap="truncate">
        {fit(segs, W).map(s => (
          <Text color={s.c} bold={s.b}>
            {s.t}
          </Text>
        ))}
      </Text>
    )
    const heading = (title: string): Seg[] => [
      { t: '◢ ', c: PINK },
      { t: title, c: MAGENTA, b: true },
      { t: ' ', c: PURPLE },
      ...sweep('─', Math.max(0, W - title.length - 3), 0.2, 0.9),
    ]
    const branch = (i: number, n: number): Seg => ({ t: i === n - 1 ? ' └─ ' : ' ├─ ', c: PURPLE })

    // Header and the big meter.
    const figures: Seg[] = [
      { t: '  ' },
      { t: formatTokens(snap.total), b: true },
      { t: ' / ', c: HAZE },
      { t: formatTokens(snap.window), c: HAZE },
      { t: `  ${snap.percent}%`, c: levelColor(snap.percent), b: true },
      ...delta(snap),
    ]

    // Categories: one meter each, scaled to the largest row.
    const rows = snap.categories.filter(c => c.kind !== 'deferred')
    const largest = Math.max(1, ...rows.map(c => c.tokens))
    const barWidth = Math.max(6, W - 30)
    const row = (c: TokenCategory): Seg[] => {
      const isUsed = c.kind === 'used'
      const share = snap.window > 0 ? ((c.tokens / snap.window) * 100).toFixed(1) : '0.0'
      const cells = Math.min(barWidth, Math.round((c.tokens / largest) * barWidth))
      const bar: Seg[] = isUsed
        ? meter(c.tokens / largest, barWidth)
        : [{ t: (c.kind === 'free' ? '▱' : '▚').repeat(cells), c: TRACK }, { t: ' '.repeat(barWidth - cells) }]
      return [
        { t: ` ${labelOf(c.name).padEnd(8)}`, c: isUsed ? CYAN : HAZE, b: isUsed },
        ...bar,
        { t: formatTokens(c.tokens).padStart(8), b: isUsed, c: isUsed ? undefined : HAZE },
        { t: `${share.padStart(6)}%`, c: HAZE },
      ]
    }

    const deferred = snap.categories.filter(c => c.kind === 'deferred' && c.tokens > 0)
    const memory = snap.memoryFiles.slice(0, 6)
    const servers = snap.mcpServers.slice(0, 6)
    const skills = snap.skills.slice(0, 5)

    return (
      <Box flexDirection="column">
        {draw([
          { t: '◢ ', c: PINK },
          { t: 'CONTEXT', c: CYAN, b: true },
          { t: '//', c: MAGENTA, b: true },
          { t: 'TOKENS', c: PINK, b: true },
          { t: ' ◣ ', c: PINK },
          ...modelTag(snap.model, await read($, effortLevel)),
        ])}
        {draw([...meter(snap.percent / 100, Math.max(8, Math.min(METER_WIDTH, W - widthOf(figures)))), ...figures])}
        {snap.history.length > 1
          ? draw([
              { t: 'TREND ', c: HAZE },
              ...snap.history.map(p => ({ t: spark(p), c: neon(p / 100) })),
              { t: `  last ${snap.history.length} turns`, c: HAZE },
            ])
          : ''}

        <Box flexDirection="column" marginTop={1}>
          {draw(heading('CATEGORIES'))}
          {rows.map(c => draw(row(c)))}
          {deferred.length > 0
            ? draw([
                { t: ' ON DEMAND ', c: HAZE },
                { t: deferred.map(c => `${labelOf(c.name)} ${formatTokens(c.tokens)}`).join(' ╱ '), c: HAZE },
                { t: '  (outside the window)', c: TRACK },
              ])
            : ''}
        </Box>

        {memory.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            {draw(heading('MEMORY FILES'))}
            {memory.map((f, i) =>
              draw([
                branch(i, memory.length),
                { t: formatTokens(f.tokens).padStart(6), b: true },
                { t: ` ${f.type.toUpperCase().padEnd(8)}`, c: CYAN },
                { t: shortPath(f.path), c: HAZE },
              ]),
            )}
          </Box>
        ) : (
          ''
        )}

        {servers.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            {draw(heading('MCP SERVERS'))}
            {servers.map((s, i) =>
              draw([
                branch(i, servers.length),
                { t: formatTokens(s.tokens).padStart(6), b: true },
                { t: ` ${s.name}`, c: CYAN },
                { t: ` ╱ ${s.tools} tools`, c: HAZE },
              ]),
            )}
          </Box>
        ) : (
          ''
        )}

        {skills.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            {draw(heading('TOP SKILLS'))}
            {skills.map((s, i) =>
              draw([branch(i, skills.length), { t: formatTokens(s.tokens).padStart(6), b: true }, { t: ` ${s.name}`, c: CYAN }]),
            )}
          </Box>
        ) : (
          ''
        )}

        <Box marginTop={1}>{draw([{ t: '// estimated like /context ╱ /tokens hide ╱ /tokens show', c: PURPLE }])}</Box>
      </Box>
    )
  })
}
