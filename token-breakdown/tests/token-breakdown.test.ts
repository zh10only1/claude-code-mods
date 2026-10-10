import { expect, mock, test } from 'claude-code/testing'

import { ribbon } from '../hooks/register'
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

const engine = (on: On) => {
  mock.clock(on, { now: 1_000 })
  on('session.start', () => ({ cwd: '/tmp' }))
  on('session.usage', () => ({ value: USAGE }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
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
  expect(await band.find({ type: 'Text', text: /CONTEXT  52\.0k \/ 200k  26%/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /Messages 32\.3k/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /Tools 12\.0k/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /Free 115k/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /MCP tools/ })).toBeUndefined()
  await band.unmount()

  const pane = await $.ui.mount({
    plugin: 'token-breakdown',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'token-breakdown',
    props: { title: 'Tokens', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  expect(await pane.find({ type: 'Text', text: /outside the window.*MCP tools 9\.0k/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /apify/ })).toBeDefined()
  await pane.unmount()
})

test('/tokens hide removes the band', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'tokens', args: '', ...RUN })
  await $.command.run({ command: 'tokens', args: 'hide', ...RUN })
  const band = await $.ui.mount({ plugin: 'token-breakdown', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: /Context/ })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: 'engine' })).toBeDefined()
  await band.unmount()
})

test('the ribbon fills its width exactly and keeps every used category visible', () => {
  const snap = {
    total: 0, window: 200_000, percent: 26, model: '', memoryFiles: [], mcpServers: [], skills: [],
    delta: 0, history: [], turnBase: 0, at: 0,
    categories: USAGE.context.breakdown!.categories.map(c => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind })),
  }
  for (const width of [20, 57, 80, 143]) {
    const segments = ribbon(snap, width)
    expect(segments.reduce((sum, s) => sum + s.cells, 0)).toBe(width)
    for (const s of segments.filter(s => s.glyph === '█')) expect(s.cells).toBeGreaterThan(0)
    expect(segments.some(s => s.key === 'MCP tools')).toBe(false)
  }
})
