import { describe, expect, it } from 'vitest'
import { providerPresets } from './presets.js'

describe('providerPresets', () => {
  it('every preset has a unique id and a valid wire format', () => {
    const ids = providerPresets.map((preset) => preset.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const preset of providerPresets) {
      expect(preset.wireFormat).toBe('openai')
    }
  })

  it('includes a custom preset with an empty base URL to fill in', () => {
    const custom = providerPresets.find((preset) => preset.id === 'custom')
    expect(custom?.baseUrl).toBe('')
  })
})
