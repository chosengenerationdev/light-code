/**
 * Carrying on after the agent's process crashed in the middle of a turn.
 *
 * Asked for from Fire Code: "when agent is crashed, when restarted it should continue the work automatically,
 * now it waits for me to give a message to continue". The conversation is already saved during the turn
 * (`persistSoon` in the bridge), so what was missing was knowing that the saved turn never finished, and
 * starting it again.
 *
 * - **The task records that a turn is running** (`Task.turnRunning`), cleared by the save that ends it. A
 *   task reopened with it still set was cut off: by a crash, or by the process being killed.
 * - **Only a host told to resumes** (`HostServices.resumeInterrupted`). Fire Code passes it when it starts a
 *   chat whose last run stopped unexpectedly; it is not "every start", because a turn cut short by quitting
 *   on purpose is not one the user asked to have run again behind their back.
 * - **It is a turn like any other**: approvals, the step cap and saving all apply. The agent is told that a
 *   tool call may have half-happened - a command still running when the process died, a file half-written -
 *   so it checks before repeating anything. An unanswered tool call is answered by `repairUnansweredToolCalls`
 *   as on every request.
 * - **Not for ever.** Three automatic resumes in a row without the turn finishing, and it stops: a turn that
 *   crashes the process every time would otherwise crash it on every Restart.
 */

export const RESUME_PROMPT =
  '[Light Code] The agent process stopped unexpectedly in the middle of this task and has been restarted. ' +
  'Continue the task from where it stopped. Before repeating a step, check whether it already took effect - a command ' +
  'may have finished or been cut off, and a file may already be written - and do not ask me to confirm the task again.'

export const MAX_CRASH_RESUMES = 3

export type ResumeDecision = { resume: true } | { resume: false; reason?: string }

export function resumeDecision(options: { asked: boolean; turnWasRunning: boolean; resumesSoFar: number }): ResumeDecision {
  if (!options.asked || !options.turnWasRunning) return { resume: false }
  if (options.resumesSoFar >= MAX_CRASH_RESUMES) {
    return {
      resume: false,
      reason: `The agent stopped ${String(options.resumesSoFar)} times in a row during this task, so it was not continued automatically. Send a message to continue, or look at the crash log first.`,
    }
  }
  return { resume: true }
}

export function isResumePrompt(text: string): boolean {
  return text.trim() === RESUME_PROMPT
}
