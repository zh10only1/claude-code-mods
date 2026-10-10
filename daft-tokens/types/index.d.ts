export type DaftCategory = {
  name: string
  tokens: number
  kind: 'used' | 'free' | 'buffer' | 'deferred'
}

export type DaftSnapshot = {
  total: number
  window: number
  percent: number
  model: string
  categories: DaftCategory[]
  /** Tokens added since the last completed turn. */
  delta: number
  /** Total at the end of the last completed turn. */
  turnBase: number
}

declare module 'claude-code' {
  interface PluginState {
    'daft-tokens': { snapshot: DaftSnapshot | null; isHidden: boolean; effort: string | null }
  }
}
