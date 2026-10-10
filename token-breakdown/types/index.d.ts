export type TokenCategory = {
  name: string
  tokens: number
  color: string
  kind: 'used' | 'free' | 'buffer' | 'deferred'
}

export type TokenSnapshot = {
  total: number
  window: number
  percent: number
  model: string
  categories: TokenCategory[]
  memoryFiles: { path: string; type: string; tokens: number }[]
  mcpServers: { name: string; tokens: number; tools: number }[]
  skills: { name: string; tokens: number }[]
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'token-breakdown': { snapshot: TokenSnapshot | null; isBandHidden: boolean }
  }
}
