import { describe, expect, it } from 'vitest'

import { storeIdFor, type LightCodeConfig } from './schema.js'

/**
 * Sending each corpus to a different vector store.
 *
 * The case this exists for is concrete: a team indexes code into a shared OpenSearch cluster and
 * the same person wants their **mail** in a Qdrant container on their own machine. Those are
 * different sensitivities and cannot be one setting.
 *
 * `storeIdFor` owns the fallback so no call site has to remember it. That matters more than it
 * looks: the alternative is every reader falling back to `activeVectorStoreId` itself, and one of
 * them not doing so — which is this project's most expensive recurring bug shape.
 */
const base: LightCodeConfig = {
  vectorStores: {
    'team-os': { kind: 'opensearch', label: 'Team OpenSearch', url: 'https://cluster.example:9200' },
    'local-qdrant': { kind: 'qdrant', label: 'Local Qdrant', url: 'http://127.0.0.1:6333' },
  },
  activeVectorStoreId: 'team-os',
}

describe('choosing a store per corpus', () => {
  /** An install that wants one store for everything writes nothing and behaves as before. */
  it('falls back to the active store when a purpose names none', () => {
    expect(storeIdFor('mail', base)).toBe('team-os')
    expect(storeIdFor('codebase', base)).toBe('team-os')
    expect(storeIdFor('docs', base)).toBe('team-os')
    expect(storeIdFor('skills', base)).toBe('team-os')
  })

  it('sends mail somewhere else without moving anything else', () => {
    const config: LightCodeConfig = { ...base, retrieval: { stores: { mail: 'local-qdrant' } } }

    expect(storeIdFor('mail', config)).toBe('local-qdrant')
    expect(storeIdFor('codebase', config)).toBe('team-os')
    expect(storeIdFor('docs', config)).toBe('team-os')
  })

  it('lets every corpus go somewhere different', () => {
    const config: LightCodeConfig = {
      ...base,
      retrieval: { stores: { mail: 'local-qdrant', codebase: 'team-os', docs: 'local-qdrant' } },
    }

    expect(storeIdFor('mail', config)).toBe('local-qdrant')
    expect(storeIdFor('codebase', config)).toBe('team-os')
    expect(storeIdFor('docs', config)).toBe('local-qdrant')
  })

  /** Nothing configured at all is undefined, not a guess. */
  it('answers undefined when there is no store at all', () => {
    expect(storeIdFor('mail', {})).toBeUndefined()
  })

  /**
   * Clearing the choice returns to the fallback rather than leaving a dangling name. The UI
   * writes an absent key rather than an empty string precisely so this holds.
   */
  it('returns to the active store when the choice is removed', () => {
    const chosen: LightCodeConfig = { ...base, retrieval: { stores: { mail: 'local-qdrant' } } }
    const cleared: LightCodeConfig = { ...base, retrieval: { stores: {} } }

    expect(storeIdFor('mail', chosen)).toBe('local-qdrant')
    expect(storeIdFor('mail', cleared)).toBe('team-os')
  })
})
