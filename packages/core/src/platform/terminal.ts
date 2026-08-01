export interface TerminalRunOptions {
  cwd?: string
  env?: Record<string, string>
}

export interface TerminalProcess {
  readonly pid: number | undefined
  onData(listener: (chunk: string) => void): void
  onExit(listener: (code: number | null) => void): void
  write(data: string): void
  /**
   * Kill the process and all of its descendants. `child.kill()` alone does not
   * kill grandchildren — see CLAUDE.md §16.
   */
  killTree(): Promise<void>
}

export interface Terminal {
  run(command: string, options?: TerminalRunOptions): TerminalProcess
}
