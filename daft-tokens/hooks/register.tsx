import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DaftSnapshot } from '../types'

const snapshot = atom({ plugin: 'daft-tokens', key: 'snapshot' } as const, null)
const isHidden = atom({ plugin: 'daft-tokens', key: 'isHidden' } as const, false)
const effortLevel = atom({ plugin: 'daft-tokens', key: 'effort' } as const, null)

// Refreshes triggered by tool calls are throttled; turn ends always refresh.
const TOOL_REFRESH_MS = 3000
const METER_WIDTH = 30

// ── Monochrome ──────────────────────────────────────────────────────────────

// Pure black panel, pure white frame and figures, greys between.
const BLACK = '#000000'
const WHITE = '#ffffff'
const LIGHT = '#d4d4d4'
const MID = '#a0a0a0'
const DIM = '#707070'
const DARK = '#4a4a4a'
const TRACK = '#333333'
const FRAME = '#ffffff'

// ── The helmet: Thomas's chrome dome and black visor, as pixel art ──────────
// Drawn with half-blocks: each character cell holds two stacked pixels, so
// these 16 rows of pixels fill 8 rows of the terminal. Taller than wide,
// as the helmet is.
//
//   .  nothing     O  outline     S  silver     H  highlight
//   D  shade       V  visor       R  bright reflection   r  soft reflection

const HELMET = [
  '....OOSSOO....',
  '..OSHHSSSSSO..',
  '.OSHHSSSSSSDO.',
  '.OSHSSSSSSSDO.',
  'OSHSSSSSSSSSDO',
  'OSHSSSSSSSSSDO',
  'OSSSSSSSSSSSDO',
  'OSVVVVVVVVVVDO',
  'OSVRRrVVVVrVDO',
  'OSVVRRrVVVVVDO',
  'OSDVVVrVVVVDDO',
  'OSDVVVVVVVVDDO',
  '.OSDVVVVVVDDO.',
  '.OSSDVVVVDDSO.',
  '..OSSDDDDSSO..',
  '...OOSSSSOO...',
]

const PIXEL: Record<string, string | null> = {
  '.': null,
  O: '#5a5a5a',
  S: '#c0c0c0',
  H: '#ffffff',
  D: '#808080',
  // Glossy black: just off the panel's pure black, so the visor reads as a surface.
  V: '#161616',
  R: '#a8a8a8',
  r: '#505050',
}

export type Cell = { ch: string; fg?: string; bg?: string }

// Packs pairs of pixel rows into half-block cells.
export const helmetCells = (art: string[] = HELMET): Cell[][] => {
  const rows: Cell[][] = []
  for (let y = 0; y < art.length; y += 2) {
    const top = art[y] ?? ''
    const bottom = art[y + 1] ?? ''
    const width = Math.max(top.length, bottom.length)
    rows.push(
      Array.from({ length: width }, (_, x) => {
        const t = PIXEL[top[x] ?? '.'] ?? null
        const b = PIXEL[bottom[x] ?? '.'] ?? null
        if (!t && !b) return { ch: ' ' }
        if (!t) return { ch: '▄', fg: b ?? undefined }
        return b ? { ch: '▀', fg: t, bg: b } : { ch: '▀', fg: t }
      }),
    )
  }
  return rows
}

export const HELMET_COLUMNS = Math.max(...HELMET.map(r => r.length))

// ── Formatting ──────────────────────────────────────────────────────────────

export const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}K`
  return String(Math.round(n))
}

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

const LABELS: Record<string, string> = {
  'System prompt': 'SYS',
  'System tools': 'TOOLS',
  'MCP tools': 'MCP',
  'Custom agents': 'AGENTS',
  'Memory files': 'MEM',
  Skills: 'SKILLS',
  Messages: 'MSG',
  'Free space': 'FREE',
}
const labelOf = (name: string) => LABELS[name] ?? name.toUpperCase()

// Unused since the meter went pure white; kept for a future gradient.
// const hex = (c: string) => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))
// const mix = (a: string, z: string, t: number) => {
//   const [x, y] = [hex(a), hex(z)]
//   return `#${x.map((v, i) => Math.round(v + ((y[i] ?? v) - v) * t).toString(16).padStart(2, '0')).join('')}`
// }

// ── Lines as plain segments ─────────────────────────────────────────────────

export type Seg = { t: string; c?: string; b?: boolean; inv?: boolean }

export const widthOf = (segs: Seg[]) => segs.reduce((n, s) => n + [...s.t].length, 0)

// Cuts a run of segments to at most `width` cells.
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
  return out
}

// Filled cells are pure white so the bar pops; the rest is a dark track.
export const meter = (fraction: number, width: number): Seg[] => {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)))
  return [
    { t: '█'.repeat(filled), c: WHITE },
    { t: '█'.repeat(width - filled), c: TRACK },
  ]
}

// ── The readout beside the helmet (helmet on the left) ───────────────────────────────────────────
//   CONTEXT ─────────────────────────────── Opus 5.5 ◆ HIGH
//   ████████░░░░░░░░░░░░░░░░░░░░░░  52.0K / 200K  26%  ▲3.1K
//   SYS 3.2K · TOOLS 12.0K · MEM 4.5K · MSG 32.3K · FREE 115K
//   RANDOM ACCESS MEMORIES

export const readout = (snap: DaftSnapshot, width: number, effort: string | null): Seg[][] => {
  const model: Seg[] = [
    { t: ` ${prettyModel(snap.model)}`, c: MID },
    ...(effort ? [{ t: ' ◆ ', c: DIM }, { t: effort.toUpperCase(), c: LIGHT, b: true }] : []),
  ]
  const title: Seg[] = [{ t: 'CONTEXT ', c: WHITE, b: true }]
  const rule = Math.max(0, width - widthOf(title) - widthOf(model))
  const top = [...title, { t: '─'.repeat(rule), c: DARK }, ...(rule > 0 ? model : [])]

  const isHot = snap.percent >= 85
  const figures: Seg[] = [
    { t: '  ' },
    { t: formatTokens(snap.total), c: WHITE, b: true },
    { t: ' / ', c: DIM },
    { t: formatTokens(snap.window), c: MID },
    { t: '  ' },
    { t: isHot ? ` ${snap.percent}% ` : `${snap.percent}%`, c: snap.percent >= 60 ? WHITE : LIGHT, b: true, inv: isHot },
    ...(snap.delta !== 0
      ? [{ t: `  ${snap.delta > 0 ? '▲' : '▼'}${formatTokens(Math.abs(snap.delta))}`, c: MID }]
      : []),
    ...(isHot ? [{ t: '  ⚠ COMPACT SOON', c: WHITE, b: true }] : []),
  ]
  const meterWidth = Math.max(8, Math.min(METER_WIDTH, width - widthOf(figures)))
  const gauge = [...meter(snap.percent / 100, meterWidth), ...figures]

  const shown = snap.categories.filter(c => (c.kind === 'used' || c.kind === 'free') && c.tokens > 0)
  const categories: Seg[] = shown.flatMap((c, i) => [
    ...(i > 0 ? [{ t: ' · ', c: DARK }] : []),
    { t: `${labelOf(c.name)} `, c: c.kind === 'free' ? DIM : MID },
    { t: formatTokens(c.tokens), c: c.kind === 'free' ? DIM : WHITE, b: c.kind !== 'free' },
  ])

  const encore: Seg[] = [{ t: 'RANDOM ACCESS MEMORIES', c: WHITE, b: true }]

  return [top, gauge, categories, encore].map(line => fit(line, width))
}

// ── Readings ────────────────────────────────────────────────────────────────

let inFlight: Promise<void> | null = null
let lastToolRefresh = 0

// Concurrent callers share one in-flight read; a turn end also moves the
// baseline the per-turn delta counts from.
function refresh($: EngineInterface, isTurnEnd = false): Promise<void> {
  const run = (inFlight ?? Promise.resolve()).then(() => takeReading($, isTurnEnd))
  inFlight = run.finally(() => {
    if (inFlight === run) inFlight = null
  })
  return run
}

async function takeReading($: EngineInterface, isTurnEnd: boolean) {
  try {
    const b = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
    if (!b) return
    const prev = await read($, snapshot)
    const turnBase = prev?.turnBase ?? b.totalTokens
    const next: DaftSnapshot = {
      total: b.totalTokens,
      window: b.rawMaxTokens,
      percent: b.percentage,
      model: b.model,
      categories: b.categories.map(c => ({ name: c.name, tokens: c.tokens, kind: c.kind })),
      delta: b.totalTokens - turnBase,
      turnBase: isTurnEnd ? b.totalTokens : turnBase,
    }
    await update($, snapshot, () => next)
  } catch {
    // No session bound yet, or the breakdown failed: keep the last snapshot.
  }
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

// The effort this session runs at, before any request says so: the
// session's CLAUDE_EFFORT, then the settings files' effortLevel, then the
// /config row. turn.step corrects it to what each request is sent with.
async function readEffortSetting($: EngineInterface) {
  const candidates: (() => Promise<unknown>)[] = [
    () => $.env.get('CLAUDE_EFFORT'),
    async () => (await $.settings.read()).effortLevel,
    async () => (await $.config.list()).find(r => /effort/i.test(r.key) || /effort/i.test(r.label))?.value,
  ]
  for (const candidate of candidates) {
    try {
      const value = String((await candidate()) ?? '').toLowerCase()
      if (!EFFORTS.includes(value)) continue
      if ((await read($, effortLevel)) !== value) await update($, effortLevel, () => value)
      return
    } catch {
      // That source is unavailable here: try the next.
    }
  }
}

// Whether the HUD is hidden is kept across sessions in the mod's store.
async function loadHidden($: EngineInterface) {
  try {
    const hidden = await $.store.get('hidden')
    if (typeof hidden === 'boolean' && (await read($, isHidden)) !== hidden) {
      await update($, isHidden, () => hidden)
    }
  } catch {
    // No store: the HUD shows.
  }
}

// ── Hooks ───────────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await loadHidden($)
    void readEffortSetting($)
    await $.command.register({ name: 'daft', description: 'Daft Punk token HUD: hide or show it' })
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
      void read($, effortLevel)
        .then(current => (current === effort ? undefined : update($, effortLevel, () => effort)))
        .catch(() => undefined)
    }
    return yield* next(e)
  })

  on('command.run', { command: 'daft' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'hide') {
      await update($, isHidden, () => true)
      await $.store.set('hidden', true)
      return { text: 'Daft Punk HUD hidden, in this and later sessions. /daft show brings it back.' }
    }
    await update($, isHidden, () => false)
    await $.store.set('hidden', false)
    await refresh($)
    return { text: 'Daft Punk HUD shown. /daft hide hides it.' }
  })

  // ── Band above the prompt ─────────────────────────────────────────────────

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const snap = await read($, snapshot)
    if (!snap) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(40, e.props.bodyColumns)
    const helmet = helmetCells()
    // Border (2), padding (4), the gap beside the helmet (3), the helmet.
    const room = width - 6 - 3 - HELMET_COLUMNS
    const lines = readout(snap, room, await read($, effortLevel))
    // The readout sits level with the middle of the helmet.
    const lift = Math.max(0, Math.floor((helmet.length - lines.length) / 2))

    return (
      <Box
        flexDirection="row"
        borderStyle="round"
        borderColor={FRAME}
        backgroundColor={BLACK}
        width={width}
        paddingX={2}
      >
        <Box flexDirection="column" marginRight={3}>
          {helmet.map(row => (
            <Text>
              {row.map(cell => (
                <Text color={cell.fg} backgroundColor={cell.bg ?? BLACK}>
                  {cell.ch}
                </Text>
              ))}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" width={room} marginTop={lift}>
          {lines.map(line => (
            <Text wrap="truncate">
              {line.map(s => (
                <Text color={s.c} backgroundColor={s.inv ? undefined : BLACK} bold={s.b} inverse={s.inv}>
                  {s.t}
                </Text>
              ))}
            </Text>
          ))}
        </Box>
      </Box>
    )
  })
}
