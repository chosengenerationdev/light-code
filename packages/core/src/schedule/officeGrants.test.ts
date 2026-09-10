import { describe, expect, it } from 'vitest'

import type { Tool } from '../tools/types.js'
import { filterToolsForSchedule, NEVER_AVAILABLE_TO_SCHEDULES } from './runner.js'

/**
 * Which Office tools an unattended run may be granted.
 *
 * User-requested: "scheduled prompts should have access to outlook tools too". The obvious
 * reading is that they do not, so this pins what is actually true rather than leaving it to be
 * re-derived — the schedule allowlist is an *allow* list, so a tool is grantable unless it is
 * named in `NEVER_AVAILABLE_TO_SCHEDULES`, and no reading tool is.
 *
 * The line the split has to hold is between *reading* and *executing*. Searching a mailbox at
 * 6am is the whole point of a scheduled alert check. Running a macro is arbitrary VBA with
 * nobody reading the source first, which is what section 13 forbids.
 */
function tool(name: string): Tool {
  return { name, group: 'read', description: '', parametersSchema: {} as never, execute: async () => ({ content: '' }) } as unknown as Tool
}

const OUTLOOK_READS = ['outlook_folders', 'outlook_search', 'outlook_read_email']
const EXCEL_READS = ['excel_sessions', 'excel_read_range', 'excel_trace_cell', 'excel_check_macro']
const EXECUTES = ['excel_run_macro', 'excel_write_macro']

describe('Office tools in a scheduled run', () => {
  it('grants every Outlook reading tool the schedule names', () => {
    const granted = filterToolsForSchedule(OUTLOOK_READS.map(tool), { allowedTools: OUTLOOK_READS })
    expect(granted.map((entry) => entry.name).sort()).toEqual([...OUTLOOK_READS].sort())
  })

  it('grants Excel reading tools too, on the same footing', () => {
    const granted = filterToolsForSchedule(EXCEL_READS.map(tool), { allowedTools: EXCEL_READS })
    expect(granted.map((entry) => entry.name).sort()).toEqual([...EXCEL_READS].sort())
  })

  /**
   * The other half, and the one that must not drift. Unattended execution of a macro means
   * arbitrary code running as the user with nobody to read it first.
   */
  it('never grants macro execution, even when the schedule names it', () => {
    const granted = filterToolsForSchedule(EXECUTES.map(tool), { allowedTools: EXECUTES })
    expect(granted).toEqual([])
    for (const name of EXECUTES) expect(NEVER_AVAILABLE_TO_SCHEDULES).toContain(name)
  })

  /** A tool the schedule did not name stays absent, whatever kind it is. */
  it('does not grant an Outlook tool the schedule left unticked', () => {
    const granted = filterToolsForSchedule(OUTLOOK_READS.map(tool), { allowedTools: ['outlook_search'] })
    expect(granted.map((entry) => entry.name)).toEqual(['outlook_search'])
  })
})
