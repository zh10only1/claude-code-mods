import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TokenCategory, TokenSnapshot } from '../types'

const PANE = 'token-breakdown'
const snapshot = atom({ plugin: 'token-breakdown', key: 'snapshot' } as const, null)
const isBandHidden = atom({ plugin: 'token-breakdown', key: 'isBandHidden' } as const, false)
const effortLevel = atom({ plugin: 'token-breakdown', key: 'effort' } as const, null)
const themeId = atom({ plugin: 'token-breakdown', key: 'theme' } as const, 'ghost')

// Refreshes triggered by tool calls are throttled; turn ends always refresh.
const TOOL_REFRESH_MS = 3000
const HISTORY_LENGTH = 16
const METER_WIDTH = 30

// ── Themes ──────────────────────────────────────────────────────────────────
// Each theme is named for an anime and fills the same roles; nothing below
// names a colour directly.

export type Theme = {
  id: string
  name: string
  /** The gradient's three stops, left to right: meter, frame, sparks. */
  a: string
  b: string
  c: string
  /** Title middle (`//`), section titles, the rising-delta mark. */
  accent: string
  /** The title's last word (`TOKENS`) and the frame's right side. */
  title2: string
  /** The percentage from 60%. */
  warn: string
  /** The percentage from 85%, and the COMPACT SOON flag. */
  hot: string
  /** The meter's unfilled part. */
  track: string
  /** Secondary text: the window size, free space, paths. */
  muted: string
  /** Category labels. */
  label: string
  /** Dividers and tree lines. */
  sep: string
  /** How the gradient moves between stops: a smooth blend, or flat bands. */
  blend: 'smooth' | 'blocks'
}

export const THEMES: Record<string, Theme> = {
  ghost: {
    id: 'ghost',
    name: 'Ghost in the Shell',
    a: '#05d9e8',
    b: '#7b2cff',
    c: '#ff2a6d',
    accent: '#d300c5',
    title2: '#ff2a6d',
    warn: '#fcee0c',
    hot: '#ff2a6d',
    track: '#3b1f5c',
    muted: '#8a6fb3',
    label: '#05d9e8',
    sep: '#7b2cff',
    blend: 'smooth',
  },
  // Edo woodblock print meets hip-hop: Jin's indigo, ochre earth, a vermilion
  // seal stamp; Fuu's pink, washed parchment, Mugen's red, olive countryside.
  champloo: {
    id: 'champloo',
    name: 'Samurai Champloo',
    a: '#5a8bc4',
    b: '#d9a441',
    c: '#e0603a',
    accent: '#f07ca0',
    title2: '#e8d8b0',
    warn: '#f08a24',
    hot: '#e63946',
    track: '#2c3a4f',
    muted: '#a39a7c',
    label: '#8f9a5b',
    sep: '#7d8fb0',
    blend: 'smooth',
  },
  // The opening's flat colour panels: blue, yellow, red-orange in hard bands;
  // Spike's suit and shirt, teal, cream, amber bar light, cigarette smoke.
  bebop: {
    id: 'bebop',
    name: 'Cowboy Bebop',
    a: '#3a86d4',
    b: '#f7c531',
    c: '#fc3c04',
    accent: '#2ec4a6',
    title2: '#f3e3c3',
    warn: '#f5a623',
    hot: '#ff1f3d',
    track: '#45391f',
    muted: '#8a96a8',
    label: '#f5a688',
    sep: '#6f8299',
    blend: 'blocks',
  },
}
export const DEFAULT_THEME = 'ghost'

const ALIASES: Record<string, string> = {
  gits: 'ghost',
  ghostintheshell: 'ghost',
  ghostandshell: 'ghost',
  samurai: 'champloo',
  samuraichamploo: 'champloo',
  cowboy: 'bebop',
  cowboybebop: 'bebop',
}

export const themeOf = (id: string | null | undefined): Theme => THEMES[id ?? ''] ?? (THEMES[DEFAULT_THEME] as Theme)

// Accepts an id, an alias or the full name in any case and spacing.
export const findTheme = (query: string): Theme | undefined => {
  const key = query.toLowerCase().replace(/[^a-z0-9]/g, '')
  const byName = Object.values(THEMES).find(t => t.name.toLowerCase().replace(/[^a-z0-9]/g, '') === key)
  return THEMES[key] ?? THEMES[ALIASES[key] ?? ''] ?? byName
}

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

// The theme's sweep a → b → c, t from 0 to 1.
export const neon = (th: Theme, t: number): string => {
  const p = Math.max(0, Math.min(1, t))
  if (th.blend === 'blocks') return p < 1 / 3 ? th.a : p < 2 / 3 ? th.b : th.c
  return p < 0.5 ? mix(th.a, th.b, p / 0.5) : mix(th.b, th.c, (p - 0.5) / 0.5)
}

const levelColor = (th: Theme, percent: number) => (percent >= 85 ? th.hot : percent >= 60 ? th.warn : th.a)

const SPARKS = '▁▂▃▄▅▆▇█'
const spark = (percent: number) => SPARKS[Math.max(0, Math.min(7, Math.round((percent / 100) * 7)))] ?? '▁'

const shortPath = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~')

// claude-opus-5-5 → Opus 5.5; a date suffix dropped, [1m] kept.
export const prettyModel = (id: string): string => {
  const wide = /\[1m\]/i.test(id) ? ' 1M' : ''
  const base = id.replace(/\[.*?\]/g, '').trim()
  if (!base.startsWith('claude-')) return base.replace(/^Claude\s+/i, '') + wide
  const parts = base.slice('claude-'.length).split('-').filter(p => !/^\d{8}$/.test(p))
  const words = parts.filter(p => !/^\d+$/.test(p)).map(p => p[0]?.toUpperCase() + p.slice(1))
  const version = parts.filter(p => /^\d+$/.test(p)).join('.')
  return [...words, version].filter(Boolean).join(' ') + wide
}

// Effort climbs the theme: low a, medium b, high accent, xhigh c, max warn.
const effortColor = (th: Theme, effort: string) =>
  ({ low: th.a, medium: th.b, high: th.accent, xhigh: th.c, max: th.warn })[effort] ?? th.a

// Top-right of the frame: model, then the effort it runs at.
const modelTag = (th: Theme, model: string, effort: string | null): Seg[] => {
  const tag: Seg[] = model ? [{ t: ` ${prettyModel(model)} `, c: th.muted }] : effort ? [{ t: ' ' }] : []
  if (effort) tag.push({ t: '◆ ', c: th.sep }, { t: `${effort.toUpperCase()} `, c: effortColor(th, effort), b: true })
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
const sweep = (th: Theme, glyph: string, count: number, t0: number, t1: number, steps = 24): Seg[] => {
  const out: Seg[] = []
  for (let i = 0; i < count; ) {
    const run = Math.max(1, Math.ceil(count / steps))
    const n = Math.min(run, count - i)
    out.push({ t: glyph.repeat(n), c: neon(th, t0 + ((t1 - t0) * (i + n / 2)) / Math.max(1, count)) })
    i += n
  }
  return out
}

// The meter: filled cells take the gradient by position, so the bar turns
// from cyan to hot pink as the window fills.
export const meter = (th: Theme, fraction: number, width: number): Seg[] => {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)))
  return [...sweep(th, '█', filled, 0, filled / Math.max(1, width)), { t: '█'.repeat(width - filled), c: th.track }]
}

const delta = (th: Theme, snap: TokenSnapshot): Seg[] =>
  snap.delta === 0
    ? []
    : [{ t: `  ${snap.delta > 0 ? '▲' : '▼'}${formatTokens(Math.abs(snap.delta))}`, c: snap.delta > 0 ? th.accent : th.a }]

// The title, as the band's top edge and the pane's header both draw it.
const titleSegs = (th: Theme): Seg[] => [
  { t: '◢ ', c: th.title2 },
  { t: 'CONTEXT', c: th.a, b: true },
  { t: '//', c: th.accent, b: true },
  { t: 'TOKENS', c: th.title2, b: true },
  { t: ' ◣', c: th.title2 },
]

// ── The band: a framed HUD ──────────────────────────────────────────────────
//   ╭─◢ CONTEXT//TOKENS ◣──────────────────────────── claude-opus-5-5 ─╮
//   │ █████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  52.0K / 200K  26%  ▲3.1K │
//   │ SYS 3.2K ╱ TOOLS 12.0K ╱ MEM 4.5K ╱ SKILLS 1.1K ╱ MSG 32.3K ╱ FREE 115K │
//   ╰─────────────────────────────────────────────────────── ▁▂▃▄▅▆ ─╯

export const bandLines = (
  snap: TokenSnapshot,
  width: number,
  effort: string | null = null,
  th: Theme = themeOf(DEFAULT_THEME),
): Seg[][] => {
  const available = Math.max(30, width)
  const level = levelColor(th, snap.percent)

  // Title and model, for the top edge.
  const title: Seg[] = [{ t: '╭─', c: th.a }, ...titleSegs(th)]
  const fullTag = modelTag(th, snap.model, effort)

  // Row one: a fixed-length meter and the figures.
  const figures: Seg[] = [
    { t: '  ' },
    { t: formatTokens(snap.total), b: true },
    { t: ' / ', c: th.muted },
    { t: formatTokens(snap.window), c: th.muted },
    { t: `  ${snap.percent}%`, c: level, b: true },
    ...delta(th, snap),
    ...(snap.percent >= 85 ? [{ t: '  ⚠ COMPACT SOON', c: th.hot, b: true }] : []),
  ]
  const meterWidth = Math.max(8, Math.min(METER_WIDTH, available - 4 - widthOf(figures)))
  const rowOne = [...meter(th, snap.percent / 100, meterWidth), ...figures]

  // Row two: each category's readout.
  const shown = snap.categories.filter(c => (c.kind === 'used' || c.kind === 'free') && c.tokens > 0)
  const rowTwo: Seg[] = shown.flatMap((c, i) => [
    ...(i > 0 ? [{ t: ' ╱ ', c: th.sep }] : []),
    { t: `${labelOf(c.name)} `, c: c.kind === 'free' ? th.muted : th.label },
    { t: formatTokens(c.tokens), b: c.kind !== 'free', c: c.kind === 'free' ? th.muted : undefined },
  ])

  const W = available
  const inner = W - 4
  // A narrow band drops the model name first, then the effort.
  const room = W - widthOf(title) - 2
  const model = [fullTag, modelTag(th, '', effort), []].find(tag => widthOf(tag) <= room) ?? []

  const top = [...title, ...sweep(th, '─', Math.max(0, W - widthOf(title) - widthOf(model) - 2), 0.1, 0.9), ...model, { t: '─╮', c: th.title2 }]
  const bottom = [{ t: '╰', c: th.a }, ...sweep(th, '─', W - 3, 0, 0.9), { t: '─╯', c: th.title2 }]
  const side = (segs: Seg[]): Seg[] => [{ t: '│ ', c: th.a }, ...fit(segs, inner), { t: ' │', c: th.title2 }]

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

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

// The effort setting as /config shows it; turn.step corrects it to what a
// request is actually sent with.
async function readEffortSetting($: EngineInterface) {
  try {
    const row = (await $.config.list()).find(r => /effort/i.test(r.key) || /effort/i.test(r.label))
    const value = typeof row?.value === 'string' ? row.value.toLowerCase() : ''
    if (EFFORTS.includes(value) && (await read($, effortLevel)) !== value) {
      await update($, effortLevel, () => value)
    }
  } catch {
    // No such row on this build: turn.step fills it in on the next request.
  }
}

// The chosen theme is kept across sessions in the mod's store.
async function loadTheme($: EngineInterface) {
  try {
    const saved = await $.store.get('theme')
    if (typeof saved === 'string' && THEMES[saved] && (await read($, themeId)) !== saved) {
      await update($, themeId, () => saved)
    }
  } catch {
    // No store: the default theme stands.
  }
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
    await loadTheme($)
    void readEffortSetting($)
    await $.command.register({
      name: 'tokens',
      description: 'Token breakdown: no args opens the pane; hide/show toggles the band; theme [name] lists or picks a theme',
    })
    void refresh($, true)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    void refresh($, true)
    void readEffortSetting($)
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
    if (arg === 'theme' || arg.startsWith('theme ')) {
      const query = arg.slice('theme'.length).trim()
      const current = themeOf(await read($, themeId))
      if (!query) {
        const list = Object.values(THEMES)
          .map(t => `${t.id === current.id ? '●' : '○'} ${t.name}  (/tokens theme ${t.id})`)
          .join('\n')
        return { text: `Themes:\n${list}` }
      }
      const picked = findTheme(query)
      if (!picked) {
        return { text: `No theme "${query}". Try: ${Object.values(THEMES).map(t => t.id).join(', ')}` }
      }
      await update($, themeId, () => picked.id)
      await $.store.set('theme', picked.id)
      return { text: `Theme: ${picked.name}` }
    }
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
    const th = themeOf(await read($, themeId))
    return (
      <Box flexDirection="column">
        {bandLines(snap, e.props.bodyColumns, await read($, effortLevel), th).map(line => (
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
    const th = themeOf(await read($, themeId))
    const snap = await read($, snapshot)
    if (!snap) return <Text color={th.muted}>// NO SIGNAL — first reading lands after the next response</Text>

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
      { t: '◢ ', c: th.title2 },
      { t: title, c: th.accent, b: true },
      { t: ' ' },
      ...sweep(th, '─', Math.max(0, W - title.length - 3), 0.2, 0.9),
    ]
    const branch = (i: number, n: number): Seg => ({ t: i === n - 1 ? ' └─ ' : ' ├─ ', c: th.sep })

    // Header and the big meter.
    const figures: Seg[] = [
      { t: '  ' },
      { t: formatTokens(snap.total), b: true },
      { t: ' / ', c: th.muted },
      { t: formatTokens(snap.window), c: th.muted },
      { t: `  ${snap.percent}%`, c: levelColor(th, snap.percent), b: true },
      ...delta(th, snap),
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
        ? meter(th, c.tokens / largest, barWidth)
        : [{ t: (c.kind === 'free' ? '█' : '▚').repeat(cells), c: th.track }, { t: ' '.repeat(barWidth - cells) }]
      return [
        { t: ` ${labelOf(c.name).padEnd(8)}`, c: isUsed ? th.label : th.muted, b: isUsed },
        ...bar,
        { t: formatTokens(c.tokens).padStart(8), b: isUsed, c: isUsed ? undefined : th.muted },
        { t: `${share.padStart(6)}%`, c: th.muted },
      ]
    }

    const deferred = snap.categories.filter(c => c.kind === 'deferred' && c.tokens > 0)
    const memory = snap.memoryFiles.slice(0, 6)
    const servers = snap.mcpServers.slice(0, 6)
    const skills = snap.skills.slice(0, 5)

    return (
      <Box flexDirection="column">
        {draw([...titleSegs(th), { t: ' ' }, ...modelTag(th, snap.model, await read($, effortLevel))])}
        {draw([...meter(th, snap.percent / 100, Math.max(8, Math.min(METER_WIDTH, W - widthOf(figures)))), ...figures])}
        {snap.history.length > 1
          ? draw([
              { t: 'TREND ', c: th.muted },
              ...snap.history.map(p => ({ t: spark(p), c: neon(th, p / 100) })),
              { t: `  last ${snap.history.length} turns`, c: th.muted },
            ])
          : ''}

        <Box flexDirection="column" marginTop={1}>
          {draw(heading('CATEGORIES'))}
          {rows.map(c => draw(row(c)))}
          {deferred.length > 0
            ? draw([
                { t: ' ON DEMAND ', c: th.muted },
                { t: deferred.map(c => `${labelOf(c.name)} ${formatTokens(c.tokens)}`).join(' ╱ '), c: th.muted },
                { t: '  (outside the window)', c: th.track },
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
                { t: ` ${f.type.toUpperCase().padEnd(8)}`, c: th.label },
                { t: shortPath(f.path), c: th.muted },
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
                { t: ` ${s.name}`, c: th.label },
                { t: ` ╱ ${s.tools} tools`, c: th.muted },
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
              draw([branch(i, skills.length), { t: formatTokens(s.tokens).padStart(6), b: true }, { t: ` ${s.name}`, c: th.label }]),
            )}
          </Box>
        ) : (
          ''
        )}

        <Box marginTop={1}>{draw([{ t: `// ${th.name.toUpperCase()} ╱ estimated like /context ╱ /tokens theme ╱ /tokens hide`, c: th.sep }])}</Box>
      </Box>
    )
  })
}
