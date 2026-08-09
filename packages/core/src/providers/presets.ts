import type { WireFormat } from './types.js'

/**
 * Presets prefill base URL and wire format. Every field remains user-editable — see
 * CLAUDE.md §9.
 *
 * These are prefills, not defaults: a fresh install has no profile at all, so nothing here
 * is contacted until the user picks one and saves it (invariant 3).
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
  { id: 'anthropic', label: 'Anthropic', wireFormat: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  { id: 'gemini', label: 'Google Gemini', wireFormat: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  { id: 'custom', label: 'Custom (OpenAI-compatible)', wireFormat: 'openai', baseUrl: '' },
  { id: 'custom-anthropic', label: 'Custom (Anthropic-compatible)', wireFormat: 'anthropic', baseUrl: '' },
  { id: 'custom-gemini', label: 'Custom (Gemini-compatible)', wireFormat: 'gemini', baseUrl: '' },
]
