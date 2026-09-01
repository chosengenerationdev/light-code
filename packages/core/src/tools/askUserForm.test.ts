import { describe, expect, it } from 'vitest'

import { coerceFormValue, type FormField } from './askUserForm.js'

/**
 * The form validates in the browser too, and that is for the person filling it in. This is the
 * half that decides what actually reaches the model — a number field yielding the string
 * "twelve" would be found much later and somewhere else entirely.
 */
const field = (overrides: Partial<FormField> & Pick<FormField, 'name' | 'type'>): FormField => ({
  label: overrides.name,
  ...overrides,
})

describe('coercing a submitted field', () => {
  it('reads a number as a number, not as the text of one', () => {
    expect(coerceFormValue(field({ name: 'n', type: 'number' }), '42')).toEqual({ value: 42 })
  })

  it('refuses a number field holding words', () => {
    expect(coerceFormValue(field({ name: 'n', type: 'number' }), 'twelve')).toHaveProperty('error')
  })

  it('treats anything but true as false, so a missing checkbox is not a missing answer', () => {
    expect(coerceFormValue(field({ name: 'b', type: 'boolean' }), undefined)).toEqual({ value: false })
    expect(coerceFormValue(field({ name: 'b', type: 'boolean' }), true)).toEqual({ value: true })
  })

  it('accepts only values the assistant offered', () => {
    const choice = field({ name: 'c', type: 'choice', options: [{ value: 'a' }, { value: 'b' }] })
    expect(coerceFormValue(choice, 'b')).toEqual({ value: 'b' })
    expect(coerceFormValue(choice, 'z')).toHaveProperty('error')
  })

  it('rejects an empty required field rather than passing a blank on as an answer', () => {
    expect(coerceFormValue(field({ name: 's', type: 'string' }), '   ')).toHaveProperty('error')
    expect(coerceFormValue(field({ name: 's', type: 'string', required: false }), '')).toEqual({ value: '' })
  })
})

/**
 * Asked for directly: "if multiple inputs are needed, like many trade ids, user should be able
 * to input that as comma separated list in a input field."
 */
describe('a list field', () => {
  const ids = field({ name: 'ids', type: 'list' })

  it('answers as an array, so nothing downstream has to guess at the separator', () => {
    expect(coerceFormValue(ids, 'T-1, T-2, T-3')).toEqual({ value: ['T-1', 'T-2', 'T-3'] })
  })

  it('takes a pasted column just as well as a typed line', () => {
    expect(coerceFormValue(ids, 'T-1\nT-2\nT-3')).toEqual({ value: ['T-1', 'T-2', 'T-3'] })
  })

  /** A trailing comma is what a careful typist leaves behind, not a request for a blank entry. */
  it('drops empty entries rather than inventing an unnamed one', () => {
    expect(coerceFormValue(ids, 'T-1, T-2, ,')).toEqual({ value: ['T-1', 'T-2'] })
  })

  it('keeps a single value as a one-item array, not as a string', () => {
    expect(coerceFormValue(ids, 'T-1')).toEqual({ value: ['T-1'] })
  })

  it('refuses an empty required list', () => {
    expect(coerceFormValue(ids, '  ,  ')).toHaveProperty('error')
    expect(coerceFormValue(field({ name: 'ids', type: 'list', required: false }), '')).toEqual({ value: [] })
  })
})
