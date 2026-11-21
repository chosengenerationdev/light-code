import { isGeminiModel } from '../providers/geminiCompat.js'

/**
 * A few lines for a model family whose habits differ from what the rest of the prompt assumes.
 *
 * Asked for ahead of Gemini arriving at the office: tools and documentation that Gemini uses well. The
 * prompt and the tool descriptions are written for every model; these are the places Gemini is known to
 * go its own way with function calling, each answered in its own terms. Only Gemini gets them - Qwen,
 * in daily use, sees the prompt exactly as before.
 *
 * Fixed for a session (the model is), so it sits in the cached prefix without varying it.
 */
export function modelGuidance(model: string | undefined, baseUrl?: string): string | undefined {
  if (model === undefined || !isGeminiModel(model, baseUrl)) return undefined
  return [
    '## Working with these tools (Gemini)',
    '',
    '- Call a tool only through function calling. Never write a call out as text or as code',
    '  (no `default_api.read_file(...)`, no ```tool_code blocks): written out, nothing runs.',
    '- **One function call per response.** Only the first one runs; send the next after you have',
    '  its result. Do not plan several calls ahead and assume they ran.',
    '- Use the parameter names exactly as the tool declares them, with the declared types. A',
    '  parameter described as "JSON text" takes a JSON string - for `call_tool`, `arguments` is',
    '  the other tool\'s arguments as JSON text, for example `{"path": "src/app.ts"}`.',
    '- Read a description\'s limits ("Default: …", "Minimum …", "One of: …") as part of the schema.',
    '- When you say you will do something, do it in the same response with a function call.',
    '  The task is finished only when you call attempt_completion; a reply with no call ends your',
    '  turn and the user has to prompt you again.',
    '- For apply_diff, copy the SEARCH text exactly from the latest read_file output, without the',
    '  line numbers read_file shows. Whitespace and quotes must match.',
    '- Find files with list_files or search_files before naming them. Do not invent paths.',
  ].join('\n')
}
