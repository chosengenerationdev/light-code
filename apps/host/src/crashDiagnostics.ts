import { mkdirSync } from 'node:fs'
import path from 'node:path'
import v8 from 'node:v8'

/**
 * What a host run leaves behind when it dies, so the log says why.
 *
 * Reported from real use: Fire Code's agent stopped often, and its log showed only startup lines -
 * the restart had begun a new log, and nothing in the old one named a cause. Ordinary errors are
 * already survived (`keepRunning` in `cli.ts`); what remains is everything JavaScript cannot catch,
 * so each line here records evidence that is otherwise gone the moment the process is:
 *
 * - **A diagnostic report on a fatal error.** V8 running out of heap ends the process from C++, with
 *   no JavaScript handler run. Node can still write a report - heap statistics, the JavaScript and
 *   native stacks - and that file is the only account of an out-of-memory death there is.
 * - **The exit code and reason, when JavaScript is the one exiting.** A process that writes this line
 *   ended through Node; one that does not was killed or crashed natively, which is itself the answer.
 * - **Memory, every ten minutes, and a warning near the limit.** Steady growth before a crash points
 *   at a leak and says roughly how fast; a flat line rules one out.
 *
 * Only for Fire Code (`--control-stdin`): a person running `light-code` in a terminal reads the
 * terminal, and periodic memory lines there would be noise.
 */
export function installCrashDiagnostics(dataDir: string, write: (line: string) => void = (line) => process.stderr.write(line)): void {
  const reports = path.join(dataDir, 'crash-reports')
  try {
    mkdirSync(reports, { recursive: true })
    process.report.directory = reports
    process.report.reportOnFatalError = true
    process.report.compact = true
  } catch (error) {
    write(`[diagnostics] crash reports unavailable: ${String(error)}\n`)
  }

  const limitMb = Math.round(v8.getHeapStatistics().heap_size_limit / 1048576)
  write(`[diagnostics] node ${process.version}, pid ${String(process.pid)}, heap limit ${String(limitMb)} MB, crash reports in ${reports}\n`)

  process.on('exit', (code) => {
    // Synchronous on purpose: nothing asynchronous runs after 'exit'.
    write(`[diagnostics] exiting through Node with code ${String(code)} after ${uptime()}\n`)
  })

  let warned = false
  const sample = (): void => {
    const line = memoryLine(limitMb)
    write(`[memory] ${line.text}\n`)
    if (line.fraction >= 0.8 && !warned) {
      warned = true
      write(`[memory] warning: the heap is ${String(Math.round(line.fraction * 100))}% of its limit - an out-of-memory stop is likely if it keeps growing\n`)
    }
  }
  setInterval(sample, 10 * 60 * 1000).unref()
}

export function memoryLine(limitMb: number): { text: string; fraction: number } {
  const usage = process.memoryUsage()
  const mb = (bytes: number): string => `${String(Math.round(bytes / 1048576))} MB`
  const fraction = limitMb > 0 ? usage.heapUsed / 1048576 / limitMb : 0
  return {
    text: `rss ${mb(usage.rss)}, heap ${mb(usage.heapUsed)} of ${String(limitMb)} MB, external ${mb(usage.external)}, up ${uptime()}`,
    fraction,
  }
}

function uptime(): string {
  const minutes = Math.floor(process.uptime() / 60)
  return minutes < 60 ? `${String(minutes)} min` : `${String(Math.floor(minutes / 60))} h ${String(minutes % 60)} min`
}
