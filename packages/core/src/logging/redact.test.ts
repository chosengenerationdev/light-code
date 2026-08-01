import { describe, expect, it } from 'vitest'
import { redact } from './redact.js'

describe('redact', () => {
  it('replaces every occurrence of a known secret value', () => {
    const result = redact('key=sk-test the key sk-test again', ['sk-test'])
    expect(result).toBe('key=[REDACTED] the key [REDACTED] again')
  })

  it('redacts Bearer tokens even without being told about them', () => {
    const result = redact('Authorization: Bearer abc123.def456-token')
    expect(result).toBe('Authorization: Bearer [REDACTED]')
  })

  it('redacts sk-style keys even without being told about them', () => {
    const result = redact('OPENAI_API_KEY=sk-abcdefghij1234567890')
    expect(result).toBe('OPENAI_API_KEY=[REDACTED]')
  })

  it('leaves ordinary text untouched', () => {
    const result = redact('the quick brown fox')
    expect(result).toBe('the quick brown fox')
  })

  it('ignores an empty known-secret value instead of matching everything', () => {
    const result = redact('the quick brown fox', [''])
    expect(result).toBe('the quick brown fox')
  })
})
