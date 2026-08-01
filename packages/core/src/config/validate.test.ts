import { describe, expect, it } from 'vitest'
import { validateProviderForm } from './validate.js'

describe('validateProviderForm', () => {
  it('returns no errors for valid input', () => {
    const errors = validateProviderForm({
      label: 'DeepSeek',
      wireFormat: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
    })
    expect(errors).toEqual([])
  })

  it('reports a field-level error for a missing label', () => {
    const errors = validateProviderForm({
      label: '',
      wireFormat: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
    })
    expect(errors).toEqual([{ path: 'label', message: 'Label is required' }])
  })

  it('reports a field-level error for a malformed base URL', () => {
    const errors = validateProviderForm({
      label: 'DeepSeek',
      wireFormat: 'openai',
      baseUrl: 'not-a-url',
      model: 'deepseek-chat',
    })
    expect(errors).toEqual([{ path: 'baseUrl', message: 'Must be a valid URL' }])
  })

  it('reports multiple field-level errors at once', () => {
    const errors = validateProviderForm({ label: '', wireFormat: 'openai', baseUrl: '', model: '' })
    const paths = new Set(errors.map((e) => e.path))
    expect(paths).toEqual(new Set(['baseUrl', 'label', 'model']))
  })
})
