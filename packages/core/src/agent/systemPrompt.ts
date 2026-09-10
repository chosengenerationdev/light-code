export interface SystemPromptOptions {
  /** The model id from the active profile, so the assistant can answer "what model are you?". */
  model?: string
  /** The profile's label, which is usually how the user refers to it. */
  providerLabel?: string
  /** Set when the Claude CLI expert is available, so `ask_expert` is explained. */
  expertAvailable?: boolean
  /**
   * Set when mail has been indexed, so the index is named as the default way to answer.
   *
   * Gated rather than always present: with mail indexing off there is no index to prefer, and a
   * standing instruction about one would be paid for on every request by every user who never
   * turns it on.
   */
  mailIndexed?: boolean
  /**
   * Name + description + path per skill. Bodies are deliberately absent — they are read on
   * demand with `read_file`, so a skill costs a few tokens whether it is short or enormous.
   */
  skills?: string
  /**
   * Set when Python tools are switched off, so "create a tool" is not silently answered with a
   * script.
   *
   * Without this the model has no `create_python_tool`, writes an ordinary `.py` file, and says
   * it created a tool — which is true in English and false in this product. The user is left
   * with a script that is not registered, not hash-pinned and not callable, and nothing anywhere
   * explains the gap. Costing two lines of prompt to convert that into a question is a good
   * trade; costing them only while the feature is off is a better one.
   */
  pythonToolsDisabled?: boolean
  /**
   * Set when Python tools are on, so the model is told the capability exists.
   *
   * Separate from the negation of `pythonToolsDisabled` on purpose: neither line should appear
   * when there is no workspace and the feature is simply not in play.
   */
  pythonToolsAvailable?: boolean
  /** Set when `write_skill` is offered, so the model knows it can record what it learns. */
  canWriteSkills?: boolean
  /**
   * True when skills are found with `search_docs` rather than listed above.
   *
   * Only changes the wording of the write guidance, but it has to: "check the list above"
   * is an instruction to consult something that is no longer there, and following it would
   * mean concluding no skill covers the subject without having looked.
   */
  skillsSearchable?: boolean
  /** Set when a shared team pool exists, so the prompt can say when to reach for it. */
  teamSkillsAvailable?: boolean
  /**
   * Extra instructions from the active mode — Junior mode's delegation rules, for instance.
   *
   * Appended last so it can qualify everything above it, which is exactly what Junior mode
   * needs: it tightens the general "consult when it seems worthwhile" advice into a budget.
   * Prefix-safe because mode is resolved once per turn (§12).
   */
  modeGuidance?: string
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
    /*
     * The person watching sees a list of tool names and nothing else unless this is filled in.
     * Phrased as what they will read rather than as a field to populate, because a model told to
     * "set the why parameter" writes "reading a file" - which is the tool name again.
     */
    '- Every tool takes an optional `why`: one short sentence, in plain language, saying what you',
    '  are trying to find out or change with this call. The user sees it beside the tool name, so',
    '  write it for them — "checking which gateway the profile points at", not "reading a file".',
    '- Paths are relative to the workspace root. You cannot access anything outside it.',
    '- When the task is complete, call attempt_completion with a summary of what you did.',
    '- If you need information only the user can provide, call ask_followup_question.',
  )

  if (options.skills !== undefined && options.skills.length > 0) {
    lines.push('', options.skills)
  }

  if (options.pythonToolsDisabled === true) {
    lines.push(
      '',
      'Python tools:',
      '- You cannot create runnable tools right now — the feature is switched off in Settings',
      '  → Python.',
      // One line, unwrapped: it is the instruction that matters and a test asserts it verbatim.
      '- Do not write a script and call it a tool.',
      '- If the user asks for a "tool", say it is switched off and let them choose: enable it in',
      '  Settings → Python, or have you write an ordinary script instead.',
    )
  } else if (options.pythonToolsAvailable === true) {
    /*
     * The positive half, which was missing entirely.
     *
     * Reported: asked to create a tool, the model wrote an ordinary .py file into the workspace
     * root. Two causes, both fixed — the tool was hidden behind the dispatcher (see
     * `PythonManager.managementTools`), and nothing in the prompt ever said the capability
     * existed. Guidance for the *off* case had been written and the *on* case assumed to need
     * none, which is the asymmetry that produced a confident wrong answer.
     */
    lines.push(
      '',
      'Python tools:',
      '- `create_python_tool` makes a real, registered, callable tool. Use it whenever the user',
      '  asks for a "tool", even if writing a script would be easier.',
      '- Writing a .py file with `write_to_file` does NOT create a tool. It is just a file, and',
      '  nothing can call it. Never describe that as having created a tool.',
      '- `update_python_tool` edits one, `delete_python_tool` removes one.',
    )
  }

  /*
   * Skills first, and local before team.
   *
   * Requested directly: "make the agent always remember to check the skills as first thing (local
   * skills), if told it can check the global team skills." The ordering is not arbitrary - a
   * local skill describes *this* project and is authoritative for it, where a colleague's
   * describes theirs and may be wrong here. Reaching for the team pool unprompted is how a
   * convention from another team quietly becomes advice about this one.
   */
  if (options.skills !== undefined || options.skillsSearchable === true) {
    lines.push(
      '',
      'Skills, before anything else:',
      '- Check the skills for this workspace before you plan or answer. They record how *this*',
      '  project works, and they exist because someone was tired of explaining it.',
      '- A skill that applies overrides your general knowledge. Do not restate a convention it',
      '  contradicts.',
      ...(options.teamSkillsAvailable === true
        ? [
            '- `search_team_skills` searches what OTHER people have taught their assistants. Use it',
            '  only when the user asks, or when this workspace plainly has nothing on the subject',
            '  and the question is about another team\'s system.',
            '- A team skill describes someone else\'s project. Never apply one to this workspace',
            '  without saying whose it is and that you are doing so.',
          ]
        : []),
    )
  }

  if (options.canWriteSkills === true) {
    lines.push(
      '',
      'Recording what you learn:',
      '- When the user explains something durable about their environment — an internal',
      '  library and how to use it, a house convention, the shape of an in-house API, a',
      '  gotcha specific to this codebase — offer to record it with write_skill. Ask first;',
      '  do not write one unprompted.',
      '- "Durable" means it would be true again next week and useful to a future',
      '  conversation. A one-off instruction for the current task is not a skill.',
      options.skillsSearchable === true
        ? '- Before writing a new skill, search for one with search_docs: if a note already ' +
          'covers the subject, read it and update that instead of creating a near-duplicate.'
        : '- Before writing a new skill, check the list above: if one already covers the ' +
          'subject, read it and update that instead of creating a near-duplicate.',
      '- When you learn something *corrects* an existing skill, say so and offer to update',
      '  it. A stale skill is worse than a missing one, because it is trusted.',
      '- Write for a reader who has none of this conversation: name the package, the import',
      '  path, the function, and show a short example. Avoid "as discussed" and "the usual".',
      options.skillsSearchable === true
        ? '- The description line is what search matches on, so make it say what subject the ' +
          'skill covers in the words someone would search for — it is a trigger, not a summary.'
        : '- The description line is the only part always in context, so make it say what ' +
          'subject the skill covers — it is a trigger for reading, not a summary.',
    )
  }

  if (options.mailIndexed === true) {
    lines.push(
      '',
      'Email:',
      '- **Always answer questions about email from the index, using search_mail and',
      '  mail_patterns.** That is what it is for. It is fast, it answers questions about time',
      '  and recurrence that a live search cannot, and it does not disturb the running Outlook.',
      '- **Only search Outlook itself when the user asks you to.** "Check Outlook", "look at my',
      '  actual mailbox", "is it there now" and anything similar are the instruction to use',
      '  outlook_search. Do not reach for it on your own initiative.',
      '- If the index has nothing, say so plainly and say when it was last synced. Do not',
      '  quietly fall back to scanning Outlook - a slow live scan that nobody asked for reads',
      '  as the assistant having hung.',
      '- One exception worth naming: if the user is asking about something that arrived in the',
      '  last few minutes, the index may not have it yet. Say that, and offer to check Outlook',
      '  rather than doing it unasked.',
    )
  }

  if (options.expertAvailable === true) {
    lines.push(
      '',
      'Expert consultation:',
      '- A stronger model, Claude, is available through the ask_expert tool. You CAN talk to',
      '  it. Never tell the user you have no way to reach another model — you do.',
      '- **If the user asks you to consult it, do so.** "Ask Claude", "check with the',
      '  expert", "what does Claude think" and anything similar are direct instructions.',
      '  It is their money and their decision; do not talk them out of it or decide the',
      '  question is too simple to be worth asking.',
      '- Otherwise, judge it yourself. It costs real money per call, so on your own',
      '  initiative use it for: planning a change spanning several files, diagnosing a bug',
      '  you have already failed to fix once, choosing between designs with long-lived',
      '  consequences, or reviewing something subtle before committing to it.',
      '- On your own initiative, do not use it for anything you could answer by reading a',
      '  file, for routine edits, or for restating something already established here.',
      '- If you decide against consulting it, say that you chose not to and why. Do not say',
      '  you are unable to.',
      '- The expert can read and search this workspace but cannot edit or run anything. It',
      '  cannot see this conversation, so put the context it needs in your question.',
      '- You remain responsible for the work. Treat its answer as advice from a colleague:',
      '  verify it against the actual code, and say so if you disagree.',
    )
  }

  // Last, so a mode can narrow anything above it rather than being contradicted by it.
  if (options.modeGuidance !== undefined && options.modeGuidance.length > 0) {
    lines.push('', options.modeGuidance)
  }

  return lines.join('\n')
}
