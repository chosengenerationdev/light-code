import type { WireFormat } from './types.js'

/**
 * Presets prefill base URL and wire format. Every field remains user-editable — see
 * CLAUDE.md §9. More wire formats (Anthropic, Gemini) arrive in Phase 7.
 */
export interface ProviderPreset {
  id: string
  label: string
  wireFormat: WireFormat
  baseUrl: string
}

export const providerPresets: readonly ProviderPreset[] = [
  { id: 'openai', label: 'OpenAI', wireFormat: 'openai', baseUrl: 'https://api.openai.com/v1' },
  { id: 'deepseek', label: 'DeepSeek', wireFormat: 'openai', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'custom', label: 'Custom (OpenAI-compatible)', wireFormat: 'openai', baseUrl: '' },
]
