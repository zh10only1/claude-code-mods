import { expect, mock, test } from 'claude-code/testing'

import { THEMES, bandLines, findTheme, neon, prettyModel, widthOf } from '../hooks/register'
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

const engine = (on: On, store: Record<string, unknown> = {}) => {
  mock.clock(on, { now: 1_000 })
  mock.store(on, store)
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

test('/tokens theme lists, picks and remembers a theme', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'tokens', args: '', ...RUN })

  const list = await $.command.run({ command: 'tokens', args: 'theme', ...RUN })
  for (const t of Object.values(THEMES)) expect(list.text).toContain(t.name)
  expect(list.text).toContain('● Ghost in the Shell')

  const other = THEMES.bebop!
  const picked = await $.command.run({ command: 'tokens', args: `theme ${other.name}`, ...RUN })
  expect(picked.text).toBe(`Theme: ${other.name}`)

  // The band now draws in the picked theme's colours.
  const band = await $.ui.mount({ plugin: 'token-breakdown', surface: 'terminal', ...BAND })
  const drawn = JSON.stringify(await band.drawn())
  expect(drawn).toContain(other.a)
  expect(drawn).not.toContain(THEMES.ghost!.a)
  await band.unmount()

  const unknown = await $.command.run({ command: 'tokens', args: 'theme nope', ...RUN })
  expect(unknown.text).toContain('No theme "nope"')
})

test('themes are found by id, alias or full name', () => {
  expect(findTheme('ghost')?.id).toBe('ghost')
  expect(findTheme('Ghost in the Shell')?.id).toBe('ghost')
  expect(findTheme('GHOST-IN-THE-SHELL')?.id).toBe('ghost')
  expect(findTheme('Ghost and Shell')?.id).toBe('ghost')
  expect(findTheme('Samurai Champloo')).toBeUndefined()
  expect(findTheme('cowboy bebop')?.id).toBe('bebop')
  expect(findTheme('nope')).toBeUndefined()
})

test('a theme saved in an earlier session is back at start', async ($, on) => {
  const other = THEMES.bebop!
  engine(on, { theme: other.id })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'tokens', args: '', ...RUN })
  const list = await $.command.run({ command: 'tokens', args: 'theme', ...RUN })
  expect(list.text).toContain(`● ${other.name}`)
})

// WCAG contrast against a dark terminal background.
const contrast = (h: string, bg = '#1e1e1e') => {
  const lum = (c: string) => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
  }
  const [x, y] = [lum(h), lum(bg)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

test('every new theme reads on a dark background; its track stays dim but visible', () => {
  for (const t of Object.values(THEMES).filter(t => t.id !== 'ghost')) {
    for (const key of ['a', 'b', 'c', 'accent', 'title2', 'warn', 'hot', 'muted', 'label', 'sep'] as const) {
      expect(contrast(t[key])).toBeGreaterThanOrEqual(3)
    }
    expect(contrast(t.track)).toBeGreaterThan(1.2)
    expect(contrast(t.track)).toBeLessThan(2)
  }
})

test('Cowboy Bebop draws flat title-card bands, not a blend', () => {
  const bebop = THEMES.bebop!
  expect(neon(bebop, 0.1)).toBe(bebop.a)
  expect(neon(bebop, 0.5)).toBe(bebop.b)
  expect(neon(bebop, 0.9)).toBe(bebop.c)
  expect(neon(THEMES.ghost!, 0.25)).not.toBe(THEMES.ghost!.a)
})

test('a saved theme that no longer exists falls back to Ghost in the Shell', async ($, on) => {
  engine(on, { theme: 'champloo' })
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const list = await $.command.run({ command: 'tokens', args: 'theme', ...RUN })
  expect(list.text).toContain('● Ghost in the Shell')
  expect(list.text).not.toContain('Champloo')
})
