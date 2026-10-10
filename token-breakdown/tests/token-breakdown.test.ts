import { expect, mock, test } from 'claude-code/testing'

import { bandLines, framePieces, neonImage, prettyModel, widthOf } from '../hooks/register'
import type { On, RenderElement, SessionUsage } from 'claude-code'

const USAGE: SessionUsage = {
  startedAt: 0,
  rateLimits: [],
  context: {
    tokens: 52_000,
    window: 200_000,
    percent: 26,
    breakdown: {
      categories: [
        { name: 'System prompt', tokens: 3_200, color: 'promptBorder', isDeferred: false, kind: 'used' },
        { name: 'System tools', tokens: 12_000, color: 'inactive', isDeferred: false, kind: 'used' },
        { name: 'Memory files', tokens: 4_500, color: 'claude', isDeferred: false, kind: 'used' },
        { name: 'Messages', tokens: 32_300, color: 'permission', isDeferred: false, kind: 'used' },
        { name: 'MCP tools', tokens: 9_000, color: 'subtle', isDeferred: true, kind: 'deferred' },
        { name: 'Free space', tokens: 115_000, color: 'subtle', isDeferred: false, kind: 'free' },
        { name: 'Autocompact buffer', tokens: 33_000, color: 'subtle', isDeferred: false, kind: 'buffer' },
      ],
      totalTokens: 52_000,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      autocompactSource: 'auto',
      percentage: 26,
      gridRows: [],
      model: 'claude-opus-5-5',
      memoryFiles: [{ path: '/home/me/CLAUDE.md', type: 'User', tokens: 4_500 }],
      mcpTools: [
        { name: 'mcp__a__x', serverName: 'apify', tokens: 600, isLoaded: true },
        { name: 'mcp__a__y', serverName: 'apify', tokens: 400, isLoaded: true },
      ],
      agents: [],
      isAutoCompactEnabled: true,
      apiUsage: null,
    },
  },
}

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

const engine = (on: On, env: Record<string, string> = {}) => {
  mock.clock(on, { now: 1_000 })
  mock.env(on, env)
  on('session.start', () => ({ cwd: '/tmp' }))
  on('session.usage', () => ({ value: USAGE }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('config.list', () => ({
    value: [{ key: 'effortLevel', label: 'Effort', kind: 'choice', value: 'high', provider: { plugin: 'core', tier: 'core' }, isLocked: false }],
  }))
  // What the engine would draw when the mod passes.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, { key: 'engine' }, 'engine') as RenderElement
  })
}

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

test('band shows total and each used category; pane itemizes', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'tokens', args: '', ...RUN })

  const band = await $.ui.mount({ plugin: 'token-breakdown', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: /52\.0K \/ 200K  26%/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /MSG 32\.3K/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /TOOLS 12\.0K/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /FREE 115K/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /CONTEXT\/\/TOKENS/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /Opus 5\.5 ◆ HIGH/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /MCP/ })).toBeUndefined()
  await band.unmount()

  const pane = await $.ui.mount({
    plugin: 'token-breakdown',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'token-breakdown',
    props: { title: 'Tokens', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  expect(await pane.find({ type: 'Text', text: /ON DEMAND MCP 9\.0K/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /apify/ })).toBeDefined()
  await pane.unmount()
})

test('/tokens hide removes the band', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'tokens', args: '', ...RUN })
  await $.command.run({ command: 'tokens', args: 'hide', ...RUN })
  const band = await $.ui.mount({ plugin: 'token-breakdown', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: /CONTEXT/ })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: 'engine' })).toBeDefined()
  await band.unmount()
})

test('the frame spans the band; the meter stays short; model and effort sit top right', () => {
  const snap = {
    total: 52_000, window: 200_000, percent: 26, model: 'claude-opus-5-5', memoryFiles: [], mcpServers: [], skills: [],
    delta: 3_100, history: [10, 14, 19, 26], turnBase: 48_900, at: 0,
    categories: USAGE.context.breakdown!.categories.map(c => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind })),
  }
  for (const width of [40, 57, 80, 143, 200]) {
    const lines = bandLines(snap, width, 'high')
    expect(lines.length).toBe(4)
    for (const line of lines) expect(widthOf(line)).toBe(width)
  }
  const wide = bandLines(snap, 200, 'high').map(l => l.map(s => s.t).join(''))
  expect((wide[1]?.match(/█/g) ?? []).length).toBe(30)
  expect(wide[0]).toMatch(/─ Opus 5\.5 ◆ HIGH ─╮$/)
  expect(wide[3]).toMatch(/^╰─+╯$/)
  for (const line of bandLines({ ...snap, percent: 91 }, 120)) expect(widthOf(line)).toBe(120)
})

test('model ids read as names', () => {
  expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(prettyModel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
  expect(prettyModel('claude-opus-5-5[1m]')).toBe('Opus 5.5 1M')
  expect(prettyModel('Claude Opus 5.5')).toBe('Opus 5.5')
  expect(prettyModel('Opus 5.5')).toBe('Opus 5.5')
})

test('in Ghostty the meter is a real image; elsewhere it stays glyphs', async ($, on) => {
  engine(on, { TERM_PROGRAM: 'ghostty' })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'tokens', args: '', ...RUN })
  const band = await $.ui.mount({ plugin: 'token-breakdown', surface: 'terminal', ...BAND })
  expect((await band.findAll({ type: 'Image' })).length).toBe(7)
  expect(await band.find({ type: 'Text', text: /52\.0K \/ 200K  26%/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /CONTEXT\/\/TOKENS/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /TOOLS 12\.0K/ })).toBeDefined()
  await band.unmount()
})

test('inside tmux the glyph meter stays, even in Ghostty', async ($, on) => {
  engine(on, { TERM_PROGRAM: 'ghostty', TMUX: '/tmp/tmux-501/default,1,0' })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'tokens', args: '', ...RUN })
  const band = await $.ui.mount({ plugin: 'token-breakdown', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Image' })).toBeUndefined()
  await band.unmount()
})

test('the image: lit segments glow, unlit ones do not, gaps stay open', () => {
  const img = neonImage(0.5, 30)
  expect(img.width).toBe(480)
  expect(img.height).toBe(32)
  const px = (Uint8Array as unknown as { fromBase64(s: string): Uint8Array }).fromBase64(img.rgba)
  expect(px.length).toBe(480 * 32 * 4)
  const alpha = (x: number, y: number) => px[(y * 480 + x) * 4 + 3] ?? 0
  // Above the core: bloom over the lit half, nothing over the unlit half.
  expect(Math.max(...Array.from({ length: 200 }, (_, x) => alpha(x, 5)))).toBeGreaterThan(0)
  expect(Math.max(...Array.from({ length: 150 }, (_, x) => alpha(320 + x, 5)))).toBe(0)
  // Along the unlit core row, some pixels are fully open: the gaps.
  expect(Array.from({ length: 150 }, (_, x) => alpha(320 + x, 16)).some(a => a === 0)).toBe(true)
})

test('the frame pieces tile every edge of the band exactly', () => {
  for (const W of [60, 120, 200]) {
    const pieces = framePieces(W, 21, 18)
    const top = pieces.filter(p => p.row === 0).reduce((n, p) => n + p.columns, 0)
    expect(top + 21 + 18).toBe(W)
    expect(pieces.find(p => p.key === 'frame-b')?.columns).toBe(W)
    expect(pieces.find(p => p.key === 'frame-r')?.col).toBe(W - 1)
  }
})
