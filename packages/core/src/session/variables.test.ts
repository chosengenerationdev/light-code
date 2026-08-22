import { describe, expect, it } from 'vitest'

import { isValidVariableName, resolveSessionVariables, toEnvironment } from './variables.js'

const admin = [{ name: 'REGISTRY', value: 'https://pypi.internal/simple' }]
const user = [
  { name: 'REGISTRY', value: 'https://pypi.org/simple' },
  { name: 'MY_TICKET', value: 'ABC-1234' },
]

describe('whose value a session actually gets', () => {
  /**
   * The specified rule. An administrator sets a variable for everyone precisely when it has to be
   * the same everywhere, so a per-user value quietly winning would defeat the only reason to set
   * one centrally.
   */
  it('gives the administrator’s value precedence over the user’s', () => {
    const resolved = resolveSessionVariables(admin, user)
    const registry = resolved.find((variable) => variable.name === 'REGISTRY')
    expect(registry?.value).toBe('https://pypi.internal/simple')
    expect(registry?.scope).toBe('admin')
  })

  /**
   * The loser is reported, not discarded. Rendering only the winning value under the user's own
   * edit box is how someone spends an afternoon on a variable that was never going to apply.
   */
  it('says what the user’s value was, so the UI can show it as overridden', () => {
    const registry = resolveSessionVariables(admin, user).find((variable) => variable.name === 'REGISTRY')
    expect(registry?.overriddenUserValue).toBe('https://pypi.org/simple')
  })

  it('leaves a user variable alone when no administrator set one of that name', () => {
    const ticket = resolveSessionVariables(admin, user).find((variable) => variable.name === 'MY_TICKET')
    expect(ticket).toMatchObject({ value: 'ABC-1234', scope: 'user' })
    expect(ticket?.overriddenUserValue).toBeUndefined()
  })

  it('carries an administrator variable the user never had', () => {
    const resolved = resolveSessionVariables([{ name: 'PROXY', value: 'http://proxy:8080' }], [])
    expect(resolved).toEqual([{ name: 'PROXY', value: 'http://proxy:8080', scope: 'admin' }])
  })

  it('is stable in order, so what a session was given can be diffed', () => {
    const shuffled = resolveSessionVariables(
      [{ name: 'ZED', value: '1' }],
      [
        { name: 'ALPHA', value: '2' },
        { name: 'MIDDLE', value: '3' },
      ],
    )
    expect(shuffled.map((variable) => variable.name)).toEqual(['ALPHA', 'MIDDLE', 'ZED'])
  })

  it('handles both sides being empty', () => {
    expect(resolveSessionVariables([], [])).toEqual([])
  })

  /** A later duplicate within one scope is the edit that was made most recently. */
  it('takes the last of two same-named variables in the same scope', () => {
    const resolved = resolveSessionVariables([], [
      { name: 'X', value: 'first' },
      { name: 'X', value: 'second' },
    ])
    expect(resolved[0]?.value).toBe('second')
  })
})

describe('names a platform can actually set', () => {
  it.each(['PATH_EXTRA', '_UNDERSCORE', 'a1', 'A_1_B'])('accepts %j', (name) => {
    expect(isValidVariableName(name)).toBe(true)
  })

  /**
   * Refused where it is typed rather than at spawn time, because the failure otherwise is a
   * process that starts with a *silently different* environment instead of an error.
   */
  it.each(['has space', 'has=equals', '1LEADING_DIGIT', '', 'DASH-ED', 'DOT.TED', 'UNIçODE'])(
    'refuses %j',
    (name) => {
      expect(isValidVariableName(name)).toBe(false)
    },
  )
})

describe('what the spawned process receives', () => {
  it('is a plain map of the winning values', () => {
    expect(toEnvironment(resolveSessionVariables(admin, user))).toEqual({
      REGISTRY: 'https://pypi.internal/simple',
      MY_TICKET: 'ABC-1234',
    })
  })

  it('drops a name the platform cannot express rather than passing it through', () => {
    const env = toEnvironment([
      { name: 'GOOD', value: '1', scope: 'user' },
      { name: 'not good', value: '2', scope: 'user' },
    ])
    expect(env).toEqual({ GOOD: '1' })
  })

  /** An empty value is a real setting — "defined but blank" differs from "not set". */
  it('keeps an empty value', () => {
    expect(toEnvironment([{ name: 'EMPTY', value: '', scope: 'admin' }])).toEqual({ EMPTY: '' })
  })
})
