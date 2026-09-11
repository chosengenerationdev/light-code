import type { PythonWorker } from '../python/worker.js'
import { parseDatasetPayload } from './types.js'

/**
 * The two different things that can be wrong, which need different answers.
 *
 * `reject` rolls the file back: the code is wrong and saving it would register a tool that cannot
 * do its job. `warn` saves it and says something: the code may be fine and simply could not be
 * exercised here.
 */
export interface CollectorCheck {
  reject?: string
  warn?: string
}

/**
 * Runs a freshly written collector and reports what is wrong with what it returned.
 *
 * ## Why at creation rather than at sync
 *
 * A collector has a contract on its *output*, and loading the module proves only that it imports.
 * Without this, a mismatch surfaces when a sync runs — unattended, possibly days later, and
 * reported as the dataset failing rather than as the tool having been written wrong. That is
 * exactly how it was reported.
 *
 * Checked here, the model still has the source in front of it and the error names the real
 * problem, so it is a one-turn fix rather than an investigation.
 *
 * ## Why an empty result passes
 *
 * `[]` is a successful sync. A source with nothing new is the ordinary case, and refusing it would
 * force somebody to fabricate data to get a correct tool saved.
 *
 * ## Why a tool that cannot run is warned about rather than refused
 *
 * A collector usually reaches a network, a database or a credential, none of which is necessarily
 * available at the moment somebody writes it — writing the tool before the credentials exist is a
 * perfectly ordinary order to work in. So an exception means "not verified", which is said
 * plainly; a wrong *shape* means "wrong", which is refused, because that is a fact about the code
 * rather than about this machine.
 */
export async function checkCollector(
  worker: PythonWorker,
  name: string,
  filePath: string,
): Promise<CollectorCheck | undefined> {
  let output: unknown
  try {
    const call = await worker.call(name, filePath, {}, { reload: true, timeoutMs: 30_000 })
    output = call.result
  } catch (error) {
    return {
      warn:
        `It was saved, but could not be run here to check its output: ${
          error instanceof Error ? error.message : String(error)
        }. That may simply mean the source is unreachable from this machine. The record shape has ` +
        'NOT been verified — make sure it returns a list of {"id": ..., "text": ...} dicts before ' +
        'a sync depends on it.',
    }
  }

  const parsed = parseDatasetPayload(output)
  if ('error' in parsed) {
    return {
      reject:
        `It ran, but what it returned cannot be indexed.\n\n${parsed.error}\n\n` +
        'Return a list of dicts, each with a stable `id` from the source and a `text` to index. ' +
        'Not a string, not a formatted report, not a dict of rows.',
    }
  }

  return parsed.records.length === 0
    ? {
        warn:
          'It ran and returned no records, which is a valid empty sync — but the record shape ' +
          'could not be checked against anything. Confirm it produces records when the source has some.',
      }
    : undefined
}
