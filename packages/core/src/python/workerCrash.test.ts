import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { Logger } from '../logging/logger.js'
import { describeWorkerExit, PythonWorker } from './worker.js'

/**
 * Reported: the agent crashed, with Windows saying python.exe stopped working. A worker that died left its input
 * pipe broken, the next request written to it raised an 'error' nobody listened for, and Node ended the host.
 */
describe('a Python worker that crashes', () => {
  it('fails the calls and says why, without taking the host down', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-crash-'))
    // A stand-in interpreter: Node running a script that reads one line, prints why, and dies.
    const script = path.join(dir, 'worker.js')
    // Its input closes first and it lingers a moment before dying, as a crashing interpreter tears down - the gap in
    // which the host's next request hits a closed pipe.
    await fs.writeFile(script, "process.stdin.once('data', () => { process.stdin.destroy(); process.stderr.write('Fatal Python error: Segmentation fault\\n'); setTimeout(() => process.exit(3), 400) })\n")
    const unhandled: unknown[] = []
    const onError = (error: unknown): void => void unhandled.push(error)
    process.on('uncaughtException', onError)
    try {
      const worker = new PythonWorker({ pythonPath: process.execPath, workerScript: script, cwd: dir, env: { ...process.env }, logger: new Logger(), timeoutMs: 5000 })
      const first = worker.ping().then(
        () => 'answered',
        (error: Error) => error.message,
      )
      // A write into the dying worker's closed pipe: the 'error' event that, unheard, ended the host. Raised directly,
      // because when the OS reports it depends on timing no test controls.
      await new Promise((resolve) => setTimeout(resolve, 150))
      const pipe = (worker as unknown as { child?: { stdin: NodeJS.EventEmitter } }).child?.stdin
      expect(() => pipe?.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow()
      const second = worker.ping().then(
        () => 'answered',
        (error: Error) => error.message,
      )
      const [a, b] = await Promise.all([first, second])
      expect(a).toContain('exited with code 3')
      expect(a).toContain('Segmentation fault')
      expect(typeof b).toBe('string')
      // And it starts again on the next call.
      const third = await worker.ping().then(
        () => 'answered',
        (error: Error) => error.message,
      )
      expect(third).toContain('exited with code 3')
      await worker.dispose()
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(unhandled).toEqual([])
    } finally {
      process.off('uncaughtException', onError)
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('names the Windows crash codes', () => {
    expect(describeWorkerExit(-1073741819, null)).toContain('0xC0000005: an access violation')
    expect(describeWorkerExit(3221225725, null)).toContain('stack overflow')
    expect(describeWorkerExit(1, null)).toBe('The Python worker exited with code 1.')
    expect(describeWorkerExit(null, 'SIGTERM')).toBe('The Python worker was stopped (SIGTERM).')
  })
})
