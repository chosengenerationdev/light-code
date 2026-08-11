export interface SystemPromptOptions {
  /** The model id from the active profile, so the assistant can answer "what model are you?". */
  model?: string
  /** The profile's label, which is usually how the user refers to it. */
  providerLabel?: string
  /** Set when the Claude CLI expert is available, so `ask_expert` is explained. */
  expertAvailable?: boolean
}

/**
 * Kept deliberately short and near-static. It sits at the front of every request, so
 * anything that varies per *turn* would invalidate the prompt cache prefix and everything
 * after it — see CLAUDE.md §12.
 *
 * Model identity is included, which sounds like it violates that. It does not: the model
 * and profile are fixed for a session and can only change at a profile switch, which
 * already restarts the prefix. This is the same "mode/session boundary" carve-out §12
 * makes for tool selection.
 *
 * Why state it at all: a model asked "what model are you?" otherwise answers from its
 * training data, which is frequently wrong — Phase 2b caught a DeepSeek deployment
 * confidently claiming to be a chat model while `deepseek-reasoner` was demonstrably
 * selected. Behind a gateway that renames models it is wrong essentially always. Telling
 * it the configured id is the only way the answer can be accurate.
 */
export function buildSystemPrompt(workspaceRoot: string, options: SystemPromptOptions = {}): string {
  const lines = [
    "You are Light Code, a coding assistant working inside a user's VS Code workspace.",
    '',
    `Workspace root: ${workspaceRoot}`,
  ]

  if (options.model !== undefined && options.model.length > 0) {
    lines.push(
      '',
      'About you:',
      `- You are running as the model "${options.model}"${
        options.providerLabel !== undefined && options.providerLabel.length > 0
          ? `, through the provider profile "${options.providerLabel}"`
          : ''
      }.`,
      '- If the user asks which model or provider they are talking to, answer with exactly',
      '  that. Do not guess from your training data; the user may have configured a model',
      '  or a gateway alias you have never heard of, and that configured name is the truth.',
    )
  }

  lines.push(
    '',
    'Guidelines:',
    '- Use the provided tools to inspect and modify the workspace. Do not guess file contents.',
    '- You must call read_file on a file before editing it with apply_diff or write_to_file.',
    '- Prefer apply_diff over write_to_file for edits to existing files.',
    '- Make one tool call at a time, then wait for its result before deciding the next step.',
    '- Paths are relative to the workspace root. You cannot access anything outside it.',
    '- When the task is complete, call attempt_completion with a summary of what you did.',
    '- If you need information only the user can provide, call ask_followup_question.',
  )

  if (options.expertAvailable === true) {
    lines.push(
      '',
      'Expert consultation:',
      '- A stronger model is available through the ask_expert tool. It costs the user real',
      '  money per call, so it is worth using well and not often.',
      '- Use it for: planning a change that spans several files, diagnosing a bug you have',
      '  already failed to fix once, choosing between designs with long-lived consequences,',
      '  or reviewing something subtle before you commit to it.',
      '- Do not use it for: anything you can answer by reading a file, routine edits,',
      '  syntax, or restating something already established in this conversation.',
      '- The expert cannot see your workspace and cannot run tools. Include the code and',
      '  context it needs directly in your question.',
      '- You remain responsible for the work. Treat its answer as advice from a colleague:',
      '  verify it against the actual code, and say so if you disagree.',
    )
  }

  return lines.join('\n')
}
