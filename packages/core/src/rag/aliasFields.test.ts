import { describe, expect, it } from 'vitest'
import { aliasFields, codebaseAliases, formatAliases, parseAliases } from './aliases.js'

/**
 * Aliases as a list, written back into the two keys that hold them.
 *
 * The singular key is what earlier versions wrote and still read; the plural one carries the rest.
 * What must hold is that the pair round-trips — a list typed in the panel comes back out of
 * `codebaseAliases` as the same list, in the same order — because the first name is the default
 * scope and reordering it silently changes which circle "team" means.
 */
describe('writing an alias list', () => {
  const roundTrip = (names: string[]): string[] => {
    const { primary, rest } = aliasFields(names)
    return codebaseAliases({
      embedder: {
        ...(primary !== undefined ? { indexAlias: primary } : {}),
        ...(rest !== undefined ? { indexAliases: rest } : {}),
      },
    } as never)
  }

  it('round-trips a list unchanged, in order', () => {
    expect(roundTrip(['my-squad', 'platform', 'everyone'])).toEqual(['my-squad', 'platform', 'everyone'])
  })

  it('puts the first name where older builds still look for it', () => {
    expect(aliasFields(['my-squad', 'everyone']).primary).toBe('my-squad')
  })

  it('omits the plural key entirely for a single name', () => {
    expect(aliasFields(['only-one'])).toEqual({ primary: 'only-one', rest: undefined })
  })

  /* Clearing the box removes the alias rather than writing an empty string. */
  it('clears both keys when the list is empty', () => {
    expect(aliasFields([])).toEqual({ primary: undefined, rest: undefined })
  })

  it('drops blanks and duplicates rather than storing them', () => {
    expect(roundTrip(['team', '', '  ', 'TEAM', 'other'])).toEqual(['team', 'other'])
  })
})

describe('the text of an alias list', () => {
  it('round-trips through the field', () => {
    expect(parseAliases(formatAliases(['a-team', 'b-team']))).toEqual(['a-team', 'b-team'])
  })

  it('accepts newlines as well as commas, for a pasted column', () => {
    expect(parseAliases('a-team\nb-team, c-team')).toEqual(['a-team', 'b-team', 'c-team'])
  })

  it('is empty for an empty box', () => {
    expect(parseAliases('   ')).toEqual([])
  })
})
