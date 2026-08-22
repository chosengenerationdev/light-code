import { describe, expect, it } from 'vitest'

import type { Principal } from './identity.js'
import { adminListPolicy, ADMIN_ONLY_MESSAGES, isAdminOnly, refusalFor, SINGLE_USER_POLICY } from './roles.js'

const alice: Principal = { id: 'entra-object-id-alice', displayName: 'Alice' }
const bob: Principal = { id: 'entra-object-id-bob', displayName: 'Bob' }

describe('who owns configuration', () => {
  it('gives the local user everything, because there is only one of them', () => {
    expect(SINGLE_USER_POLICY.shared).toBe(false)
    expect(SINGLE_USER_POLICY.roleFor(alice)).toBe('admin')
  })

  it('names administrators by id, not by display name', () => {
    const policy = adminListPolicy([alice.id])
    expect(policy.roleFor(alice)).toBe('admin')
    expect(policy.roleFor(bob)).toBe('user')
    // A leaver's username can be reassigned to a different human; a directory id cannot.
    expect(policy.roleFor({ id: 'someone-else', displayName: 'Alice' })).toBe('user')
  })

  /** A legitimate deployment: the operator writes the config file and the server never does. */
  it('treats an empty admin list as "nobody", not "everybody"', () => {
    expect(adminListPolicy([]).roleFor(alice)).toBe('user')
  })
})

describe('which messages are an administrator’s', () => {
  it('covers the things invariant 5 already judged too dangerous to delegate', () => {
    for (const type of [
      'saveProfile',
      'setActiveProfile',
      'saveMcpServer',
      'setPython',
      'setExpert',
      'saveNetwork',
      'setReadRoots',
      'saveSchedule',
      'saveSearchConnection',
    ]) {
      expect(isAdminOnly(type)).toBe(true)
    }
  })

  /**
   * As considered as the list itself. Appearance, mode and the per-chat expert budget belong to
   * the person using the session, and an administrator has no business owning them.
   */
  it('leaves personal preferences alone', () => {
    for (const type of ['setMode', 'setAccentColor', 'setExpertColor', 'setMaxIterations', 'setTaskExpertLimits']) {
      expect(isAdminOnly(type)).toBe(false)
    }
  })

  it('lets ordinary work through untouched', () => {
    for (const type of ['sendMessage', 'cancel', 'approvalResponse', 'requestTasks', 'openTask', 'runSearchProbe']) {
      expect(isAdminOnly(type)).toBe(false)
    }
  })

  /**
   * The safety net. Forgetting to add a new settings message to the list should mean "an admin
   * has to do it", never "anyone may repoint the gateway" — so unknown mutating verbs default
   * to restricted.
   */
  it('restricts a settings message nobody remembered to list', () => {
    expect(isAdminOnly('saveSomethingInventedTomorrow')).toBe(true)
    expect(isAdminOnly('deleteWhateverComesNext')).toBe(true)
    expect(isAdminOnly('setSomeFutureThing')).toBe(true)
  })

  it('refuses with a sentence that says what still works', () => {
    const message = refusalFor('saveProfile')
    expect(message).toContain('saveProfile')
    expect(message).toMatch(/administrator/)
    // §17: an error names what to do next. Here that is "your own session is fine, go ask".
    expect(message).toMatch(/unaffected/)
  })

  it('lists every restricted message exactly once', () => {
    expect(new Set(ADMIN_ONLY_MESSAGES).size).toBe(ADMIN_ONLY_MESSAGES.length)
  })
})

/**
 * Named individually at the user's request (2026-08-22), because these three are the ones they
 * called out and a prefix rule that happens to catch them is not the same as a decision.
 *
 * Each also fails dangerously if it drifts: Python runs model-authored code, a search connection
 * chooses where the workspace is uploaded, and a schedule executes with nobody watching.
 */
describe('the three the user named', () => {
  it('keeps enabling Python to an administrator', () => {
    expect(isAdminOnly('setPython')).toBe(true)
  })

  it('keeps search connections and indexing to an administrator', () => {
    for (const type of [
      'saveSearchConnection',
      'deleteSearchConnection',
      'setActiveSearchConnection',
      'saveEmbedder',
      'startIndexing',
      'indexDocs',
      'syncVectorStore',
    ]) {
      expect(isAdminOnly(type), type).toBe(true)
    }
  })

  it('keeps schedules to an administrator, including running one by hand', () => {
    for (const type of ['saveSchedule', 'deleteSchedule', 'setScheduleEnabled', 'runScheduleNow', 'duplicateSchedule']) {
      expect(isAdminOnly(type), type).toBe(true)
    }
  })

  /** Added after the list was written, and caught by the prefix rule rather than by memory. */
  it('catches the retrieval toggles nobody added to the list', () => {
    expect(isAdminOnly('setSkillRetrieval')).toBe(true)
    expect(isAdminOnly('setDispatcher')).toBe(true)
  })
})
