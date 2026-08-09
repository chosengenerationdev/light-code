import { describe, expect, it } from 'vitest'
import { providerPresets } from './presets.js'
import { wireFormatSchema } from './types.js'

describe('providerPresets', () => {
  it('every preset has a unique id and a wire format the schema accepts', () => {
    const ids = providerPresets.map((preset) => preset.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const preset of providerPresets) {
      expect(wireFormatSchema.safeParse(preset.wireFormat).success).toBe(true)
    }
  })

  it('covers all three wire formats from Phase 7', () => {
    const formats = new Set(providerPresets.map((preset) => preset.wireFormat))
    expect(formats).toEqual(new Set(['openai', 'anthropic', 'gemini']))
  })

  it('offers a custom preset per wire format, with an empty base URL to fill in', () => {
    // Invariant 3: a preset prefills, it never points anywhere on its own.
    for (const id of ['custom', 'custom-anthropic', 'custom-gemini']) {
      expect(providerPresets.find((preset) => preset.id === id)?.baseUrl).toBe('')
    }
  })
})
