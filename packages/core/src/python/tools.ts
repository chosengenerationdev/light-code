import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { confine } from '../fs/confine.js'
import type { Tool, ToolPreview, ToolResult } from '../tools/types.js'
import { unwrapFencedSource, type CodeGenerator } from './codeGenerator.js'
import { describeInstallFailure, parseInlineDependencies } from './deps.js'
import { approveTool, forgetTool, isValidToolName, toolFileName } from './registry.js'
import type { PythonWorker, WorkerToolDescription } from './worker.js'

/**
 * The three tools that let the model author its own tools.
 *
 * This is the sharpest surface in the product. Everywhere else, approval gates *calling*
 * something that already exists; here it gates the creation of a body that will run later,
 * so an injected instruction could otherwise plant a persistent code path (§13).
 *
 * Three things carry the weight:
 *
 * 1. **The preview is a real diff of the real source.** Not a summary, not the model's
 *    description of what it wrote — the file's current content against exactly what will be
 *    written (invariant 8).
 * 2. **Validation happens before approval.** The code is parsed, imported and its schema
 *    derived first, so the user is never asked to approve something that cannot even load,
 *    and the model gets the traceback back instead.
 * 3. **Approval records a hash of the approved source.** A later edit — by anything — fails
 *    the check at load time rather than running unreviewed.
 */

export interface PythonToolContext {
  toolsDir: string
  worker: PythonWorker
  /**
   * Installs a tool's PEP 723 dependencies. Absent means dependency installation is
   * unavailable, and a tool declaring any is rejected with that said plainly rather than
   * failing later on an ImportError nobody can trace back to here.
   */
  installDeps?: ((packages: readonly string[]) => Promise<{ installed: string[]; error?: string }>) | undefined
  /**
   * Reloads the registry after a successful create/update/delete. Awaited, so `status()`
   * is accurate the moment the tool returns rather than a tick later.
   */
  onChanged: () => Promise<void>
  /**
   * Writes the source from a specification, using a model chosen for code.
   *
   * Optional. Absent — as in the VS Code extension — the chat model writes the file itself and
   * these tools behave exactly as they always have, down to the shape of their parameters.
   */
  generateSource?: CodeGenerator | undefined
  /**
   * Submits the source for someone else to approve, instead of saving it.
   *
   * Present only where the author may not approve their own work — a shared server, for a user who
   * is not an administrator. It returns the message the model is given, and nothing is written:
   * §13 makes the registry the boundary, and a file with no registry entry never loads, so holding
   * the file outside the tools directory is that same boundary used deliberately.
   *
   * Absent everywhere else, including the whole VS Code extension, where the person approving is
   * the person asking and the ordinary prompt is the right mechanism.
   */
  submitForReview?:
    | ((request: {
        name: string
        content: string
        existingContent: string
        producedBy?: string
      }) => Promise<string>)
    | undefined
}

const createParams = z.object({
  name: z
    .string()
    .describe('Tool name: lowercase letters, digits and underscores. Becomes py__<name> and <name>.py.'),
  source: z
    .string()
    .describe(
      'The complete Python file. Must define `run`. Use type hints — the parameter schema is derived from them. ' +
        'The module docstring becomes the tool description; document parameters in a Google-style Args: block. ' +
        'Declare dependencies in a PEP 723 inline block if you need any.',
    ),
})
export type CreatePythonToolParams = z.infer<typeof createParams>

/**
 * The same tool when a programming provider is configured: describe it, do not write it.
 *
 * A separate schema rather than one with both fields optional. Offering `source` *and*
 * `specification` and asking the model to pick invites it to send both, or to send a
 * specification that is really source, and the failure is a file nobody meant to write. One field
 * means one instruction.
 *
 * The shape is fixed for a session — it depends on configuration, not on the turn — so the prompt
 * prefix stays byte-stable (§12).
 */
const specifyParams = z.object({
  name: z
    .string()
    .describe('Tool name: lowercase letters, digits and underscores. Becomes py__<name> and <name>.py.'),
  specification: z
    .string()
    .describe(
      'What the tool must do, in prose. A model configured for code writes the file from this; you do not ' +
        'write Python here. Say what it takes, what it returns, and any library or endpoint it must use. ' +
        'The user approves the generated source before anything runs.',
    ),
})
export type SpecifyPythonToolParams = z.infer<typeof specifyParams>

const deleteParams = z.object({
  name: z.string().describe('The tool to remove.'),
})
export type DeletePythonToolParams = z.infer<typeof deleteParams>

/**
 * Resolves a tool's path, refusing anything that escapes the tools directory.
 *
 * The name arrives from the model, so it is untrusted input being turned into a filesystem
 * path — `confine` plus a strict name pattern, exactly as every other path-taking tool does.
 */
async function resolveToolPath(toolsDir: string, name: string): Promise<string> {
  if (!isValidToolName(name)) {
    throw new Error(
      `"${name}" is not a valid tool name. Use lowercase letters, digits and underscores, starting with a letter.`,
    )
  }
  // Created first: `confine` calls `realpath` on the root, which fails if it does not exist
  // — and the tools directory legitimately does not until the first tool is written.
  await fs.mkdir(toolsDir, { recursive: true })
  // Argument order is (requestedPath, root), and the request must be absolute — a bare
  // filename resolves against the process CWD, which is not the workspace.
  return confine(path.join(toolsDir, toolFileName(name)), toolsDir)
}

async function readIfPresent(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}

/** Shared by create and update — they differ only in wording and in what already exists. */
function makeWriteTool(
  context: PythonToolContext,
  options: { name: 'create_python_tool' | 'update_python_tool'; description: string; mustExist: boolean },
): Tool<CreatePythonToolParams> {
  const generator = context.generateSource

  /**
   * Where the source comes from.
   *
   * With a programming provider the chat model sends a specification and this produces the file;
   * without one the chat model wrote it already. Cached per `name`+input for the length of a
   * single tool call, because `preview()` and `execute()` are separate calls and generating twice
   * would show the user one file and write another — the exact thing invariant 8 forbids.
   */
  const pending = new Map<string, Promise<{ source: string; producedBy?: string }>>()

  const sourceFor = async (params: CreatePythonToolParams & { specification?: string }): Promise<{ source: string; producedBy?: string }> => {
    if (generator === undefined || params.specification === undefined) {
      return { source: params.source }
    }
    const key = `${params.name}::${params.specification}`
    let inFlight = pending.get(key)
    if (inFlight === undefined) {
      const toolPath = resolveToolPath(context.toolsDir, params.name)
      inFlight = (async () => {
        // An update is a change, not a rewrite, so the generator is shown what is already there.
        const before = await readIfPresent(await toolPath)
        const generated = await generator({
          toolName: params.name,
          specification: params.specification ?? '',
          ...(before.length > 0 ? { existingSource: before } : {}),
        })
        return { source: unwrapFencedSource(generated.source), producedBy: generated.producedBy }
      })()
      pending.set(key, inFlight)
    }
    return inFlight
  }

  return {
    name: options.name,
    group: 'edit',
    description: options.description,
    parametersSchema: (generator !== undefined ? specifyParams : createParams) as unknown as typeof createParams,

    /**
     * A real diff of the real file: its current content against exactly the bytes that
     * will be written. Not a summary and not the model's account of what it wrote
     * (invariant 8) — this *is* the thing the user is approving, and the same string is
     * later hashed, so what was reviewed is what can run.
     */
    async preview(params): Promise<ToolPreview> {
      const filePath = await resolveToolPath(context.toolsDir, params.name)
      const before = await readIfPresent(filePath)
      const { source, producedBy } = await sourceFor(params)
      /*
       * The generated bytes, not the specification. This is what will be written and what gets
       * hashed, so it is what has to be reviewed (invariant 8) — and where it came from is part
       * of the judgement, since source a second model wrote is not source this conversation did.
       */
      return {
        kind: 'diff',
        path: filePath,
        before,
        after: source,
        ...(producedBy !== undefined ? { note: `Written by ${producedBy}` } : {}),
      }
    },

    async execute(params): Promise<ToolResult> {
      try {
        const filePath = await resolveToolPath(context.toolsDir, params.name)
        const before = await readIfPresent(filePath)

        if (options.mustExist && before.length === 0) {
          return { content: `There is no tool called "${params.name}" to update. Use create_python_tool.`, isError: true }
        }
        if (!options.mustExist && before.length > 0) {
          return {
            content: `A tool called "${params.name}" already exists. Use update_python_tool to change it.`,
            isError: true,
          }
        }

        // The same promise `preview` resolved, so the approved bytes are the written bytes.
        const { source, producedBy } = await sourceFor(params)

        /*
         * Submitted rather than saved, where the author cannot approve their own work. Checked
         * before anything is written: a file that appeared and then had to be removed would be
         * loadable for as long as it existed, and "briefly" is not a security property.
         */
        if (context.submitForReview !== undefined) {
          return {
            content: await context.submitForReview({
              name: params.name,
              content: source,
              existingContent: before,
              ...(producedBy !== undefined ? { producedBy } : {}),
            }),
          }
        }

        await fs.mkdir(context.toolsDir, { recursive: true })
        await fs.writeFile(filePath, source, 'utf8')

        /*
         * Puts the file back as it was. Leaving a broken or unapproved .py behind would sit
         * in the workspace and be reported as an issue on every load — noise from a mistake
         * the model already knows about and can fix.
         */
        const restore = async (): Promise<void> => {
          if (before.length > 0) await fs.writeFile(filePath, before, 'utf8')
          else await fs.rm(filePath, { force: true })
        }

        /*
         * Dependencies first. The validation step imports the module, so a declared package
         * that is not installed surfaces as an ImportError from deep inside the worker —
         * technically accurate and completely unhelpful. Installing first means the failure,
         * when it comes, names the package and the index it was looked for on.
         */
        const declared = parseInlineDependencies(source)
        if (declared.length > 0) {
          if (context.installDeps === undefined) {
            await restore()
            return {
              content:
                `This tool declares dependencies (${declared.join(', ')}) but dependency installation is ` +
                'not available — uv could not be found. Rewrite it using only the standard library, ' +
                'or ask the user to configure uv in Settings → Python.',
              isError: true,
            }
          }
          const install = await context.installDeps(declared)
          if (install.error !== undefined) {
            await restore()
            return { content: describeInstallFailure(install), isError: true }
          }
        }

        let described: WorkerToolDescription
        try {
          described = await context.worker.validate(params.name, filePath)
        } catch (error) {
          await restore()

          const message = error instanceof Error ? error.message : String(error)
          const traceback = (error as { traceback?: string }).traceback
          // The traceback is the payload: it is what lets the model fix its own code.
          return { content: `The tool was not saved.\n\n${message}\n\n${traceback ?? ''}`.trim(), isError: true }
        }

        // Only now, with the source proven to load, is the approval recorded — pinned to
        // exactly the bytes that were shown in the diff.
        await approveTool(context.toolsDir, params.name, source, described)
        await context.onChanged()

        return {
          content:
            `Saved and registered as py__${params.name}.\n` +
            `Description: ${described.description || '(none — add a module docstring)'}\n` +
            `Parameters: ${JSON.stringify(described.schema)}\n\n` +
            // Accurate about *when*. The tool block is fixed for the whole turn so the
            // prompt-cache prefix stays byte-stable (§12), which means a tool created now
            // becomes callable on the next message rather than later in this one. Saying
            // "callable now" would have the model try it and fail.
            'It will be available as a tool from your next message onward.',
          path: filePath,
        }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }
}

export function createCreatePythonTool(context: PythonToolContext): Tool<CreatePythonToolParams> {
  return makeWriteTool(context, {
    name: 'create_python_tool',
    mustExist: false,
    /*
     * Opens by claiming the word "tool", because the observed failure was the model reaching
     * for `write_to_file` when the user asked it to "write a tool" — producing a standalone
     * script that nothing can call. Both tools write Python to a file; only this one registers
     * it, and the description has to make that the obvious reading.
     */
    description:
      'THE way to create a tool when the user asks for one. Writes a Python tool and registers it, so it becomes ' +
      'callable as py__<name> from the next message onwards. Use this — not write_to_file — for anything described ' +
      'as a "tool", and for work awkward in shell commands: parsing, data transformation, anything needing a library. ' +
      'Define a `run` function with type hints; the schema and description are derived from the code, so there is no ' +
      'metadata to keep in sync. The user must approve the source before it is saved.',
  })
}

export function createUpdatePythonTool(context: PythonToolContext): Tool<CreatePythonToolParams> {
  return makeWriteTool(context, {
    name: 'update_python_tool',
    mustExist: true,
    description:
      'Replace the source of an existing Python tool. Send the complete file, not a patch. ' +
      'The user must approve the change before it is saved.',
  })
}

export function createDeletePythonTool(context: PythonToolContext): Tool<DeletePythonToolParams> {
  return {
    name: 'delete_python_tool',
    group: 'edit',
    description: 'Remove a Python tool and its registration.',
    parametersSchema: deleteParams,

    async preview(params): Promise<ToolPreview> {
      const filePath = await resolveToolPath(context.toolsDir, params.name)
      // Shown as a diff to nothing, so the user sees exactly what is being removed rather
      // than just its name.
      return { kind: 'diff', path: filePath, before: await readIfPresent(filePath), after: '' }
    },

    async execute(params): Promise<ToolResult> {
      try {
        const filePath = await resolveToolPath(context.toolsDir, params.name)
        await fs.rm(filePath, { force: true })
        await forgetTool(context.toolsDir, params.name)
        await context.onChanged()
        return { content: `Removed py__${params.name}.`, path: filePath }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }
}

/**
 * Adapts a registered Python tool into the ordinary `Tool` interface.
 *
 * The same move MCP tools make, and for the same reason: the agent loop, the approval gate
 * and mode filtering then treat a Python tool exactly like `execute_command`, with no
 * special-casing anywhere upstream. It is approval-gated for free.
 *
 * Group is `command`, not `read` — this executes arbitrary code, so it belongs with the
 * other thing that does, and Ask mode excludes it.
 */
export function adaptPythonTool(
  registered: { name: string; description: string; schema: Record<string, unknown>; filePath: string },
  context: { worker: PythonWorker; timeoutMs?: number },
): Tool<Record<string, unknown>> {
  return {
    name: `py__${registered.name}`,
    group: 'command',
    description: registered.description.length > 0 ? registered.description : `Python tool "${registered.name}".`,
    // Permissive locally; the schema the model sees is the derived one, passed through
    // untouched rather than round-tripped through zod, which would drop keywords (§11).
    parametersSchema: z.record(z.string(), z.unknown()),
    rawJsonSchema: registered.schema,

    async preview(params): Promise<ToolPreview> {
      return {
        kind: 'text',
        text: `Run ${registered.filePath}\n\nrun(${JSON.stringify(params, null, 2)})`,
      }
    },

    async execute(params): Promise<ToolResult> {
      try {
        const call = await context.worker.call(registered.name, registered.filePath, params, {
          // Reloaded every call: the file is the source of truth, and an edit between calls
          // must take effect without restarting the session (§13).
          reload: true,
          ...(context.timeoutMs !== undefined ? { timeoutMs: context.timeoutMs } : {}),
        })
        const printed = call.stdout.trim()
        const value = typeof call.result === 'string' ? call.result : JSON.stringify(call.result, null, 2)
        return { content: printed.length > 0 ? `${value}\n\n--- stdout ---\n${printed}` : value }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const traceback = (error as { traceback?: string }).traceback
        return { content: traceback !== undefined ? `${message}\n\n${traceback}` : message, isError: true }
      }
    },
  }
}
