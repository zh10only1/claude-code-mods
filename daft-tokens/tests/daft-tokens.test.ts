import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement, SessionUsage } from 'claude-code'

import { HELMET_COLUMNS, helmetCells, readout, widthOf } from '../hooks/register'

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
        { name: 'Messages', tokens: 36_800, color: 'permission', isDeferred: false, kind: 'used' },
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
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      isAutoCompactEnabled: true,
      apiUsage: null,
    },
  },
}

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

const engine = (on: On, effortSource: 'env' | 'settings' | 'config' = 'config') => {
  mock.clock(on, { now: 1_000 })
  mock.env(on, effortSource === 'env' ? { CLAUDE_EFFORT: 'medium' } : {})
  on('settings.read', () => ({ value: effortSource === 'settings' ? { effortLevel: 'xhigh' } : {} }))
  on('session.start', () => ({ cwd: '/tmp' }))
  on('session.usage', () => ({ value: USAGE }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('config.list', () => ({
    value: [{ key: 'effortLevel', label: 'Effort', kind: 'choice', value: effortSource === 'config' ? 'high' : '', provider: { plugin: 'core', tier: 'core' }, isLocked: false }],
  }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, { key: 'engine' }, 'engine') as RenderElement
  })
}

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 19 }, view: {} },
} as const

test('the HUD shows the figures, the categories, RANDOM ACCESS MEMORIES and the helmet', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'daft', args: 'show', ...RUN })
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'daft-tokens', surface, ...BAND })
    expect(await band.find({ type: 'Text', text: /52\.0K \/ 200K  26%/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /MSG 36\.8K/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /Opus 5\.5 ◆ HIGH/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: 'RANDOM ACCESS MEMORIES' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /▀/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /MCP/ })).toBeUndefined()
    await band.unmount()
  }
})

test('/daft hide gives the band back', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'daft', args: 'hide', ...RUN })
  const band = await $.ui.mount({ plugin: 'daft-tokens', surface: 'terminal', ...BAND })
  expect(await band.find({ type: 'Text', text: 'engine' })).toBeDefined()
  await band.unmount()
})

test('the helmet is 8 rows of half-blocks, taller than wide, every row the same width', () => {
  const rows = helmetCells()
  expect(rows.length).toBe(8)
  expect(rows.length * 2).toBeGreaterThan(HELMET_COLUMNS)
  for (const row of rows) expect(row.length).toBe(HELMET_COLUMNS)
})

test('readout lines never overflow; the last says RANDOM ACCESS MEMORIES; 85% inverts the percentage', () => {
  const snap = {
    total: 52_000, window: 200_000, percent: 26, model: 'claude-opus-5-5', delta: 3_100, turnBase: 0,
    categories: USAGE.context.breakdown!.categories.map(c => ({ name: c.name, tokens: c.tokens, kind: c.kind })),
  }
  for (const width of [30, 60, 101]) for (const line of readout(snap, width, 'high')) expect(widthOf(line)).toBeLessThanOrEqual(width)
  expect(readout(snap, 101, null)[3]?.map(s => s.t).join('')).toBe('RANDOM ACCESS MEMORIES')
  const gauge = readout(snap, 101, null)[1] ?? []
  expect(gauge[0]).toEqual({ t: '█'.repeat(8), c: '#ffffff' })
  const hot = readout({ ...snap, percent: 91 }, 101, null)
  expect(hot[1]?.some(s => s.inv)).toBe(true)
})

for (const [source, level] of [['env', 'MEDIUM'], ['settings', 'XHIGH'], ['config', 'HIGH']] as const) {
  test(`the effort shows before any request, read from ${source}`, async ($, on) => {
    engine(on, source)
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.command.run({ command: 'daft', args: 'show', ...RUN })
    const band = await $.ui.mount({ plugin: 'daft-tokens', surface: 'terminal', ...BAND })
    expect(await band.find({ type: 'Text', text: new RegExp(`Opus 5\\.5 ◆ ${level}`) })).toBeDefined()
    await band.unmount()
  })
}
