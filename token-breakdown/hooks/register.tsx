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

const CYAN = '#00f6ff'
const PURPLE = '#7b2cff'
const MAGENTA = '#ff2bd6'
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
  return [...sweep('█', filled, 0, filled / Math.max(1, width)), { t: '█'.repeat(width - filled), c: TRACK }]
}

// ── The neon image meter (terminals with the kitty graphics protocol) ───────
// Real pixels, one cell row tall: slanted segments with open gaps, a white-hot
// core fading to the gradient at the edges, a soft bloom around the lit ones,
// unlit ones dark. Anti-aliased by signed distance; the background stays
// transparent so the terminal's own shows through.

const PX_PER_COLUMN = 16
const PX_HEIGHT = 32

type Rgb = [number, number, number]
const rgbOf = (c: string): Rgb => [0, 1, 2].map(i => parseInt(c.slice(1 + i * 2, 3 + i * 2), 16)) as Rgb

// The lit tube's own gradient: brighter and more saturated than the text
// palette, so it reads as light, not paint.
const TUBE = ['#00f6ff', '#4d7dff', '#a64dff', '#ff2bd6', '#ff2a6d'].map(rgbOf)
const tube = (t: number): Rgb => {
  const p = Math.max(0, Math.min(1, t)) * (TUBE.length - 1)
  const i = Math.min(TUBE.length - 2, Math.floor(p))
  const [a, z] = [TUBE[i]!, TUBE[i + 1]!]
  return [0, 1, 2].map(k => a[k]! + (z[k]! - a[k]!) * (p - i)) as Rgb
}

export const neonImage = (fraction: number, columns: number, rows = 1) => {
  const W = columns * PX_PER_COLUMN
  const H = PX_HEIGHT * rows
  const coreHeight = rows === 1 ? 10 : 9 + 9 * rows
  const y0 = (H - coreHeight) / 2 // core top
  const y1 = y0 + coreHeight // core bottom
  const mid = (y0 + y1) / 2
  const slant = coreHeight * 0.5 // the top edge sits this far right of the bottom
  const segW = 11
  const x0 = 8 // room for the bloom to fade before the image's edge
  const count = columns
  const pitch = (W - 2 * x0 - segW - slant) / Math.max(1, count - 1)
  const lit = Math.max(0, Math.min(count, Math.round(fraction * count)))
  const litEnd = lit > 0 ? x0 + (lit - 1) * pitch + segW + slant / 2 : 0
  const track = rgbOf(TRACK)
  const white: Rgb = [255, 255, 255]
  const near = 3 * rows // the tight halo around each lit segment
  const wide = 5 + 4 * rows // the bloom the whole lit tube throws

  // Signed distance from a pixel to segment i, in the sheared frame where
  // segments are upright rectangles: negative inside.
  const dist = (xs: number, y: number, i: number) => {
    const left = x0 + i * pitch
    const dx = Math.max(left - xs, xs - (left + segW))
    const dy = Math.max(y0 - y, y - y1)
    return dx > 0 || dy > 0 ? Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) : Math.max(dx, dy)
  }

  const pixels = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y++) {
    const yc = y + 0.5
    const shear = (slant * (y1 - yc)) / (y1 - y0)
    for (let x = 0; x < W; x++) {
      const xc = x + 0.5
      const xs = xc - shear
      const nearest = Math.round((xs - x0 - segW / 2) / pitch)
      let best = Infinity
      let index = 0
      for (let i = nearest - 1; i <= nearest + 1; i++) {
        if (i < 0 || i >= count) continue
        const d = dist(xs, yc, i)
        if (d < best) [best, index] = [d, i]
      }
      const cover = Math.max(0, Math.min(1, 0.5 - best))
      const hue = tube(xc / W)

      // Light: a halo summed over the nearby lit segments, plus a soft band of
      // bloom along the whole lit stretch of the tube.
      let glow = 0
      if (lit > 0) {
        for (let i = nearest - 2; i <= nearest + 2; i++) {
          if (i < 0 || i >= lit) continue
          const d = Math.max(0, dist(xs, yc, i))
          glow += 0.55 * Math.exp(-((d / near) ** 2))
        }
        const dy = Math.max(0, Math.abs(yc - mid) - coreHeight / 2)
        const dx = Math.max(0, xc - litEnd, x0 - xc)
        glow += 0.5 * Math.exp(-((Math.hypot(dx, dy) / wide) ** 2))
        glow = Math.min(0.92, glow)
      }

      let core: Rgb = track
      if (index < lit) {
        // A thin white-hot line through the middle, pure colour around it.
        const edge = Math.abs(yc - mid) / (coreHeight / 2)
        const hot = Math.max(0, 1 - edge / 0.35) * 0.55
        core = [0, 1, 2].map(k => hue[k]! + (white[k]! - hue[k]!) * hot) as Rgb
      }
      const alpha = cover + glow * (1 - cover)
      const o = (y * W + x) * 4
      if (alpha <= 0) continue
      for (let k = 0; k < 3; k++) pixels[o + k] = Math.round((core[k]! * cover + hue[k]! * glow * (1 - cover)) / alpha)
      pixels[o + 3] = Math.round(Math.min(1, alpha) * 255)
    }
  }
  // toBase64 is in the runtime (see ImageSource), not yet in TypeScript's lib.
  return { rgba: (pixels as Uint8Array & { toBase64(): string }).toBase64(), width: W, height: H }
}

// ── The neon frame (same terminals) ─────────────────────────────────────────
// The border becomes light too: one rounded-rectangle tube through the middle
// of the band's edge cells, drawn once on a canvas the band's size and cut into
// the pieces that sit around the text (the title and model break the top edge).

export type FramePiece = { key: string; col: number; row: number; columns: number; rows: number }

export const framePieces = (W: number, titleCols: number, modelCols: number): FramePiece[] => {
  const midStart = 2 + titleCols
  const midCols = Math.max(0, W - 2 - titleCols - modelCols - 2)
  return [
    { key: 'frame-tl', col: 0, row: 0, columns: 2, rows: 1 },
    { key: 'frame-tm', col: midStart, row: 0, columns: midCols, rows: 1 },
    { key: 'frame-tr', col: W - 2, row: 0, columns: 2, rows: 1 },
    { key: 'frame-l', col: 0, row: 1, columns: 1, rows: 2 },
    { key: 'frame-r', col: W - 1, row: 1, columns: 1, rows: 2 },
    { key: 'frame-b', col: 0, row: 3, columns: W, rows: 1 },
  ].filter(piece => piece.columns > 0)
}

export const frameImage = (W: number, piece: FramePiece) => {
  // Sized so the widest piece stays inside an image's 2048 pixels.
  const pc = Math.max(4, Math.min(12, Math.floor(2048 / W)))
  const pr = pc * 2
  const Wpx = W * pc
  const width = piece.columns * pc
  const height = piece.rows * pr
  // The tube's path: a rounded rectangle through the edge cells' centres.
  const cx = Wpx / 2
  const cy = 2 * pr
  const hx = Wpx / 2 - pc / 2
  const hy = 1.5 * pr
  const radius = pc * 1.1
  const thick = Math.max(1, pc / 6)
  const near = pc * 0.38
  const wide = pc * 0.85
  const white: Rgb = [255, 255, 255]

  const pixels = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const gx = piece.col * pc + x + 0.5
      const gy = piece.row * pr + y + 0.5
      const qx = Math.abs(gx - cx) - (hx - radius)
      const qy = Math.abs(gy - cy) - (hy - radius)
      const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
      const d = Math.abs(outside)
      const cover = Math.max(0, Math.min(1, thick + 0.5 - d))
      const glow = Math.min(0.9, 0.6 * Math.exp(-((d / near) ** 2)) + 0.32 * Math.exp(-((d / wide) ** 2)))
      const hue = tube(gx / Wpx)
      const hot = Math.max(0, 1 - d / (thick * 0.7)) * 0.5
      const core = [0, 1, 2].map(k => hue[k]! + (white[k]! - hue[k]!) * hot) as Rgb
      const alpha = cover + glow * (1 - cover)
      if (alpha <= 0.004) continue
      const o = (y * width + x) * 4
      for (let k = 0; k < 3; k++) pixels[o + k] = Math.round((core[k]! * cover + hue[k]! * glow * (1 - cover)) / alpha)
      pixels[o + 3] = Math.round(Math.min(1, alpha) * 255)
    }
  }
  return { rgba: (pixels as Uint8Array & { toBase64(): string }).toBase64(), width, height }
}

let frameCache: { key: string; pieces: (FramePiece & { source: ReturnType<typeof frameImage> })[] } | null = null
const cachedFrame = (W: number, titleCols: number, modelCols: number) => {
  const key = `${W}:${titleCols}:${modelCols}`
  if (frameCache?.key !== key) {
    frameCache = { key, pieces: framePieces(W, titleCols, modelCols).map(p => ({ ...p, source: frameImage(W, p) })) }
  }
  return frameCache.pieces
}

// Redrawn only when the bar changes.
let imageCache: { key: string; source: ReturnType<typeof neonImage> } | null = null
const cachedNeonImage = (fraction: number, columns: number) => {
  const key = `${Math.round(fraction * columns)}:${columns}`
  if (imageCache?.key !== key) imageCache = { key, source: neonImage(fraction, columns) }
  return imageCache.source
}

// Terminals that draw real pixels (the kitty graphics protocol). tmux passes
// none through, so a session inside it keeps the glyph meter.
async function canDrawImages($: EngineInterface) {
  const program = ((await $.env.get('TERM_PROGRAM')) ?? '').toLowerCase()
  const term = ((await $.env.get('TERM')) ?? '').toLowerCase()
  if (await $.env.get('TMUX')) return false
  return program === 'ghostty' || program === 'kitty' || term.includes('kitty') || term.includes('ghostty')
}

const delta = (snap: TokenSnapshot): Seg[] =>
  snap.delta === 0
    ? []
    : [{ t: `  ${snap.delta > 0 ? '▲' : '▼'}${formatTokens(Math.abs(snap.delta))}`, c: snap.delta > 0 ? MAGENTA : CYAN }]

// ── The band: a framed HUD ──────────────────────────────────────────────────
//   ╭─◢ CONTEXT//TOKENS ◣──────────────────────────── claude-opus-5-5 ─╮
//   │ █████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  52.0K / 200K  26%  ▲3.1K │
//   │ SYS 3.2K ╱ TOOLS 12.0K ╱ MEM 4.5K ╱ SKILLS 1.1K ╱ MSG 32.3K ╱ FREE 115K │
//   ╰─────────────────────────────────────────────────────── ▁▂▃▄▅▆ ─╯

export type BandParts = {
  top: Seg[]
  title: Seg[]
  model: Seg[]
  figures: Seg[]
  meterWidth: number
  inner: number
  readout: Seg[]
  bottom: Seg[]
}

export const side = (segs: Seg[], inner: number): Seg[] => [{ t: '│ ', c: CYAN }, ...fit(segs, inner), { t: ' │', c: PINK }]

export const bandParts = (snap: TokenSnapshot, width: number, effort: string | null = null): BandParts => {
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

  // Row two: each category's readout.
  const shown = snap.categories.filter(c => (c.kind === 'used' || c.kind === 'free') && c.tokens > 0)
  const rowTwo: Seg[] = shown.flatMap((c, i) => [
    ...(i > 0 ? [{ t: ' ╱ ', c: PURPLE }] : []),
    { t: `${labelOf(c.name)} `, c: c.kind === 'free' ? HAZE : CYAN },
    { t: formatTokens(c.tokens), b: c.kind !== 'free', c: c.kind === 'free' ? HAZE : undefined },
  ])

  const W = available
  const inner = W - 4
  // A narrow band drops the model name first, then the effort.
  const room = W - widthOf(title) - 2
  const model = [fullTag, modelTag('', effort), []].find(tag => widthOf(tag) <= room) ?? []

  const top = [...title, ...sweep('─', Math.max(0, W - widthOf(title) - widthOf(model) - 2), 0.1, 0.9), ...model, { t: '─╮', c: PINK }]
  const bottom = [{ t: '╰', c: CYAN }, ...sweep('─', W - 3, 0, 0.9), { t: '─╯', c: PINK }]
  return { top, title: title.slice(1), model, figures, meterWidth, inner, readout: rowTwo, bottom }
}

// The band as text lines, the meter drawn with glyphs.
export const bandLines = (snap: TokenSnapshot, width: number, effort: string | null = null): Seg[][] => {
  const p = bandParts(snap, width, effort)
  const rowOne = [...meter(snap.percent / 100, p.meterWidth), ...p.figures]
  return [p.top, side(rowOne, p.inner), side(p.readout, p.inner), p.bottom]
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
    void readEffortSetting($)
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

    const effort = await read($, effortLevel)
    const { Box, Text } = $.ui.resolve(e)
    const line = (segs: Seg[]) =>
      segs.map(s => (
        <Text color={s.c} bold={s.b}>
          {s.t}
        </Text>
      ))

    if (e.surface === 'terminal' && (await canDrawImages($))) {
      const { Image } = $.ui.resolve(e)
      const W = Math.max(30, e.props.bodyColumns)
      const p = bandParts(snap, W, effort)
      const title: Seg[] = [{ t: ' ' }, ...p.title, { t: ' ' }]
      const model = p.model
      const frame = cachedFrame(W, widthOf(title), widthOf(model))
      const piece = (key: string) => {
        const f = frame.find(one => one.key === key)
        return f ? <Image key={f.key} columns={f.columns} rows={f.rows} source={f.source} alt={' '} /> : ''
      }
      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            {piece('frame-tl')}
            <Text wrap="truncate">{line(title)}</Text>
            {piece('frame-tm')}
            <Text wrap="truncate">{line(model)}</Text>
            {piece('frame-tr')}
          </Box>
          <Box flexDirection="row">
            {piece('frame-l')}
            <Box flexDirection="column">
              <Box flexDirection="row">
                <Text> </Text>
                <Image
                  key="meter"
                  columns={p.meterWidth}
                  rows={1}
                  source={cachedNeonImage(snap.percent / 100, p.meterWidth)}
                  alt={'▰'.repeat(Math.round((snap.percent / 100) * p.meterWidth)).padEnd(p.meterWidth, '▱')}
                />
                <Text wrap="truncate">{line(fit(p.figures, W - 3 - p.meterWidth))}</Text>
              </Box>
              <Text wrap="truncate">{line([{ t: ' ' }, ...fit(p.readout, W - 3)])}</Text>
            </Box>
            {piece('frame-r')}
          </Box>
          {piece('frame-b')}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {bandLines(snap, e.props.bodyColumns, effort).map(segs => (
          <Text wrap="truncate">{line(segs)}</Text>
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
        : [{ t: (c.kind === 'free' ? '█' : '▚').repeat(cells), c: TRACK }, { t: ' '.repeat(barWidth - cells) }]
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
