import { execFile, spawn, type ChildProcess } from 'node:child_process'
import type { Terminal, TerminalProcess, TerminalRunOptions } from '@light-code/core'

class NodeTerminalProcess implements TerminalProcess {
  private readonly dataListeners: Array<(chunk: string) => void> = []
  private readonly exitListeners: Array<(code: number | null) => void> = []

  constructor(private readonly child: ChildProcess) {
    child.stdout?.on('data', (chunk: Buffer) => this.emitData(chunk.toString('utf8')))
    child.stderr?.on('data', (chunk: Buffer) => this.emitData(chunk.toString('utf8')))
    child.on('exit', (code) => this.emitExit(code))
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  onData(listener: (chunk: string) => void): void {
    this.dataListeners.push(listener)
  }

  onExit(listener: (code: number | null) => void): void {
    this.exitListeners.push(listener)
  }

  write(data: string): void {
    this.child.stdin?.write(data)
  }

  /** `child.kill()` alone leaves grandchildren running — see CLAUDE.md §16. */
  async killTree(): Promise<void> {
    const pid = this.child.pid
    if (pid === undefined) return

    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve())
      })
      return
    }

    try {
      // Negative pid targets the whole process group (requires `detached: true` at spawn).
      process.kill(-pid, 'SIGKILL')
    } catch {
      this.child.kill('SIGKILL')
    }
  }

  private emitData(chunk: string): void {
    for (const listener of this.dataListeners) listener(chunk)
  }

  private emitExit(code: number | null): void {
    for (const listener of this.exitListeners) listener(code)
  }
}

/**
 * `node:child_process`-backed implementation. Phase 3's `execute_command` tool may
 * swap this for VS Code's terminal shell-integration API for richer UX (visible
 * terminal, shell-reported exit codes) — see CLAUDE.md §19 for the open question.
 */
export class NodeTerminal implements Terminal {
  run(command: string, options: TerminalRunOptions = {}): TerminalProcess {
    const child = spawn(command, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      shell: true,
      detached: process.platform !== 'win32',
    })
    return new NodeTerminalProcess(child)
  }
}
