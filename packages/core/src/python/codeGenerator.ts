/**
 * Writing the source of a Python tool with a *different* model from the one holding the
 * conversation.
 *
 * A cheap model is fine at deciding a tool is needed and describing what it must do, and much
 * worse at writing the file. This lets the chat model state the requirement and a model chosen
 * for code produce it — the same split as the Claude CLI expert, applied to the one place where
 * the output is a file rather than advice.
 *
 * ## What does not change
 *
 * The generated source goes through the ordinary approval prompt, showing a real diff of the real
 * bytes (invariant 8), and the approved text is what gets hashed into the registry. So the
 * security story is untouched: a second model writing the code does not mean a second model
 * getting past the gate. If anything the gate matters more, which is why the prompt says where
 * the source came from.
 *
 * Absent in the VS Code extension, where the chat model writes the source exactly as it always
 * has. The whole seam is optional and the tool's parameters change shape only when a host
 * supplies one.
 */
export interface CodeGenerationRequest {
  /** The tool being written, so the generator can name the file and the function. */
  toolName: string
  /** What the tool must do, in the chat model's words. */
  specification: string
  /** The current file when updating, so a change is a change rather than a rewrite. */
  existingSource?: string
  signal?: AbortSignal
}

export interface CodeGenerationResult {
  source: string
  /*
   * There is deliberately no token count here.
   *
   * `StreamChunk` carries no usage, so nothing could fill it, and an optional field nobody
   * populates is indistinguishable from one that is always zero — the reader concludes the call
   * was free. Metering this properly means usage reaching the provider layer first, which is a
   * change to every adapter and is not smuggled in behind a field.
   */
  /** Which profile produced it, so the approval prompt can say. */
  producedBy: string
}

export type CodeGenerator = (request: CodeGenerationRequest) => Promise<CodeGenerationResult>

/**
 * The instruction given to the programming provider.
 *
 * Deliberately narrow. It is handed a requirement and asked for one file, with the conventions
 * that make a Python tool loadable stated as requirements rather than hints — the schema is
 * derived from type hints and the description from the docstring, so a file missing either is
 * not a stylistic problem but an unusable tool.
 *
 * It is told to return only the file. A model that explains its work in prose produces a file
 * that will not parse, and stripping prose afterwards means guessing where the code starts.
 */
export function buildCodeGenerationPrompt(request: CodeGenerationRequest): string {
  const lines = [
    'Write one complete Python file implementing the tool described below.',
    '',
    'Requirements, all load-bearing:',
    '- Define a function named `run`. It is the entry point and nothing else is called.',
    '- Annotate every parameter and the return type. The tool’s schema is derived from those',
    '  hints, so an unannotated parameter cannot be passed by the caller.',
    '- Write a module docstring. It becomes the tool description the model reads when choosing',
    '  this tool, so say what it does, not how.',
    '- Document parameters in a Google-style `Args:` block.',
    '- Declare any third-party dependency in a PEP 723 inline block. Standard library needs none.',
    '',
    '**Return the file and nothing else.** No explanation, no fenced code block, no preamble.',
    'Anything that is not Python will be written to the file verbatim and fail to parse.',
    '',
    `Tool name: ${request.toolName}`,
    '',
    'What it must do:',
    request.specification,
  ]

  if (request.existingSource !== undefined && request.existingSource.length > 0) {
    lines.push(
      '',
      'This tool already exists. Change what the requirement asks for and leave the rest alone —',
      'return the whole file, including the parts you did not touch.',
      '',
      'Current file:',
      request.existingSource,
    )
  }

  return lines.join('\n')
}

/**
 * Strips a fenced code block if the model produced one anyway.
 *
 * The prompt asks for bare source, and models comply most of the time. The exception is common
 * enough that writing a ```python fence into a .py file — where it is a syntax error on line one —
 * is a worse outcome than one conservative unwrap. Only a fence that wraps the *entire* response
 * is removed: a fence in the middle is part of a docstring, and cutting there would mangle a file
 * that was otherwise correct.
 */
export function unwrapFencedSource(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return text

  const firstNewline = trimmed.indexOf('\n')
  if (firstNewline === -1) return text

  const opening = trimmed.slice(0, firstNewline).trim()
  // ``` or ```python or ```py — anything else is not a language tag and this is not a fence.
  if (!/^```[a-zA-Z0-9]*$/.test(opening)) return text
  if (!trimmed.endsWith('```')) return text

  return trimmed.slice(firstNewline + 1, trimmed.length - 3).replace(/\s+$/, '') + '\n'
}
