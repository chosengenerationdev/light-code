import { redact } from './redact.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export interface LoggerOptions {
  level?: LogLevel
  /** Called lazily on each log line so newly-added secrets are covered without re-registering. */
  knownSecrets?: () => readonly string[]
  sink?: (line: string) => void
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

/** All logging goes through here so redaction can never be bypassed by a stray `console.log`. */
export class Logger {
  private readonly level: LogLevel
  private readonly knownSecrets: () => readonly string[]
  private readonly sink: (line: string) => void

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? 'info'
    this.knownSecrets = options.knownSecrets ?? (() => [])
    this.sink = options.sink ?? ((line) => console.log(line))
  }

  debug(message: string, ...args: unknown[]): void {
    this.write('debug', message, args)
  }

  info(message: string, ...args: unknown[]): void {
    this.write('info', message, args)
  }

  warn(message: string, ...args: unknown[]): void {
    this.write('warn', message, args)
  }

  error(message: string, ...args: unknown[]): void {
    this.write('error', message, args)
  }

  private write(level: LogLevel, message: string, args: unknown[]): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return
    const rendered = [message, ...args.map(formatArg)].join(' ')
    this.sink(`[${level}] ${redact(rendered, this.knownSecrets())}`)
  }
}
