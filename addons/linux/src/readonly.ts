/**
 * Whether a command can only read.
 *
 * The add-on promises that nothing it sends can change a machine. Each command is approved by the user
 * in Light Code as well, but an approval can be set to "always", and a model can be talked into
 * anything - so this check is the guarantee, and it is written to refuse rather than to understand.
 *
 * - **No shell grammar beyond a pipe.** Outside single quotes there may be no `;`, `&`, `>`, `<`,
 *   `$`, backtick, parenthesis or newline, so nothing can chain, redirect, substitute or expand.
 *   `|` joins programs, and every program in the pipe is checked. `$` is fine inside single quotes,
 *   where the shell does not expand it (`grep 'error$'`).
 * - **Programs from a list, by bare name.** `/tmp/x/cat` is not `cat`, and `X=1 cmd` is refused.
 * - **Flags that write or never end are refused per program**: `find -delete`, `sort -o`, `tail -f`,
 *   `journalctl --vacuum-size`, `dmesg -c`, `date -s`. Programs that can write through their own
 *   language (`sed`, `awk`, `perl`, `python`) or run others (`xargs`, `env cmd`, `sudo`) are absent.
 *
 * Unsure means no: an extra program the user trusts can be added on the add-on's tab.
 */

export type Verdict = { ok: true } | { ok: false; reason: string }

type Rule = (args: string[]) => string | undefined

const ANY: Rule = () => undefined

/** Refuses any short-option cluster containing one of `letters`, and any of `long`. */
function noFlags(letters: string, long: string[] = []): Rule {
  return (args) => {
    for (const arg of args) {
      if (arg === '--') break
      if (arg.startsWith('--')) {
        const name = arg.split('=')[0] as string
        if (long.some((flag) => name === flag || (flag.endsWith('*') && name.startsWith(flag.slice(0, -1))))) return `${name} is not read-only`
      } else if (arg.startsWith('-') && arg.length > 1 && !/^-\d+$/.test(arg)) {
        for (const letter of letters) if (arg.slice(1).includes(letter)) return `-${letter} is not read-only`
      }
    }
    return undefined
  }
}

/** The first argument that is not a flag must be one of these words. */
function subcommands(allowed: string[], then: Rule = ANY): Rule {
  return (args) => {
    const word = args.find((arg) => !arg.startsWith('-'))
    if (word === undefined || !allowed.includes(word)) return `only ${allowed.join(', ')}`
    return then(args)
  }
}

const noArgs: Rule = (args) => (args.length === 0 ? undefined : 'no arguments')
const onlyFlags: Rule = (args) => (args.every((arg) => arg.startsWith('-')) ? undefined : 'no arguments other than options')

const RULES: Record<string, Rule> = {
  // Reading files and text.
  cat: ANY, tac: ANY, head: ANY, nl: ANY, wc: ANY, cut: ANY, tr: ANY, rev: ANY, fold: ANY, column: ANY,
  tail: noFlags('fF', ['--follow', '--retry']),
  grep: ANY, egrep: ANY, fgrep: ANY, zgrep: ANY, zegrep: ANY, zfgrep: ANY,
  zcat: ANY, bzcat: ANY, xzcat: ANY, strings: ANY, od: ANY, hexdump: ANY,
  // `xxd in out` writes `out`.
  xxd: (args) => (args.filter((arg) => !arg.startsWith('-')).length > 1 ? 'xxd with an output file writes it' : undefined),
  sort: noFlags('o', ['--output', '--compress-program']),
  // `uniq in out` writes `out`: one file at most.
  uniq: (args) => (args.filter((arg) => !arg.startsWith('-')).length > 1 ? 'uniq with an output file writes it' : undefined),
  comm: ANY, diff: noFlags('', ['--output']), cmp: ANY, jq: ANY, echo: ANY, printf: ANY, true: ANY,
  md5sum: noFlags('c', ['--check']), sha1sum: ANY, sha256sum: ANY, sha512sum: ANY, cksum: ANY,
  // Files and folders.
  ls: ANY, stat: ANY, file: noFlags('C', ['--compile']), du: ANY, df: ANY, readlink: ANY, realpath: ANY, basename: ANY, dirname: ANY,
  find: (args) => {
    const bad = args.find((arg) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(arg))
    return bad === undefined ? undefined : `find ${bad} is not read-only`
  },
  tree: noFlags('o'),
  // The machine.
  uptime: ANY, uname: ANY, whoami: ANY, id: ANY, groups: ANY, nproc: ANY, arch: ANY, free: ANY,
  hostname: onlyFlags, hostnamectl: subcommands(['status']),
  date: (args) => {
    if (args.some((arg) => arg === '-s' || arg.startsWith('--set'))) return 'date -s sets the clock'
    return args.some((arg) => !arg.startsWith('-') && !arg.startsWith('+')) ? 'date with a time sets the clock' : undefined
  },
  ps: ANY, pgrep: ANY, pidof: ANY, top: (args) => (args.includes('-b') && args.some((arg) => arg === '-n' || /^-n\d+$/.test(arg)) ? undefined : 'top needs -b -n 1'),
  vmstat: ANY, iostat: ANY, mpstat: ANY, sar: noFlags('o'), lsof: ANY, w: ANY, who: ANY, last: ANY, lastlog: ANY,
  lscpu: ANY, lsblk: ANY, lsmem: ANY, lspci: ANY, lsusb: ANY, lsmod: ANY, mount: noArgs, findmnt: ANY, blkid: ANY,
  locale: ANY, getent: ANY, which: ANY, whereis: ANY, printenv: ANY, env: noArgs, ulimit: onlyFlags, timedatectl: subcommands(['status', 'show']),
  // Network, looking only.
  ss: noFlags('K', ['--kill']), netstat: ANY, ping: (args) => (args.includes('-c') || args.some((arg) => /^-c\d+$/.test(arg)) ? undefined : 'ping needs -c (a count), or it never ends'),
  ip: (args) => {
    const bad = args.find((arg) => /^(add|del|delete|change|replace|set|flush|append|prepend|save|restore|exec|monitor)$/.test(arg))
    if (bad !== undefined) return `ip ${bad} is not read-only`
    return subcommands(['addr', 'a', 'address', 'route', 'r', 'ro', 'link', 'l', 'neigh', 'n', 'rule', 'ru', '-s', 'maddr', 'tuntap'])(args.filter((arg) => !/^-[46s]$/.test(arg)))
  },
  dig: ANY, nslookup: ANY, host: ANY,
  // Logs and services.
  journalctl: noFlags('fF', ['--follow', '--vacuum-*', '--rotate', '--flush', '--sync', '--relinquish-var', '--smart-relinquish-var', '--setup-keys', '--update-catalog']),
  dmesg: noFlags('cCDEnwW', ['--clear', '--read-clear', '--console-*', '--follow', '--follow-new']),
  systemctl: subcommands(['status', 'show', 'cat', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'list-unit-files', 'list-timers', 'list-sockets', 'list-dependencies']),
  service: (args) => (args.length >= 2 && args[1] === 'status' ? undefined : (args[0] === '--status-all' ? undefined : 'only service <name> status')),
  crontab: (args) => (args[0] === '-l' && (args.length === 1 || (args.length === 3 && args[1] === '-u')) ? undefined : 'only crontab -l'),
  // Containers, looking only.
  docker: subcommands(['ps', 'logs', 'inspect', 'images', 'stats', 'version', 'info', 'top', 'port', 'diff', 'events'], (args) => {
    if (args[0] === 'logs' && args.some((arg) => arg === '-f' || arg === '--follow')) return 'docker logs -f never ends'
    if (args[0] === 'stats' && !args.includes('--no-stream')) return 'docker stats needs --no-stream'
    if (args[0] === 'events' && !args.some((arg) => arg.startsWith('--until'))) return 'docker events needs --until'
    return undefined
  }),
  kubectl: subcommands(['get', 'describe', 'logs', 'top', 'version', 'explain', 'api-resources', 'cluster-info'], (args) =>
    args.some((arg) => /^(-f|--follow|-w|--watch|--watch-only)$/.test(arg)) ? 'kubectl that never ends' : undefined,
  ),
  java: (args) => (args.length === 1 && (args[0] === '-version' || args[0] === '--version') ? undefined : 'only java -version'),
  python3: (args) => (args.length === 1 && (args[0] === '--version' || args[0] === '-V') ? undefined : 'only python3 --version'),
}

/** The built-in program list, for the tool description and the README. */
export const READ_ONLY_PROGRAMS = Object.keys(RULES).sort()

const PROGRAM = /^[A-Za-z0-9._+-]+$/

/** Splits on unquoted pipes into argument lists, refusing every other piece of shell grammar. */
export function splitPipeline(command: string): string[][] | string {
  const segments: string[][] = [[]]
  let token: string | undefined
  let quote: "'" | '"' | undefined
  const push = (): void => {
    if (token !== undefined) segments[segments.length - 1]?.push(token)
    token = undefined
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string
    if (quote === "'") {
      if (c === "'") quote = undefined
      else token = (token ?? '') + c
      continue
    }
    if (c === '\n' || c === '\r') return 'more than one line'
    if (quote === '"') {
      if (c === '"') quote = undefined
      else if (c === '$' || c === '`') return `${c} inside double quotes is expanded by the shell - use single quotes`
      else if (c === '\\') {
        const next = command[i + 1]
        if (next === undefined) return 'a trailing backslash'
        token = (token ?? '') + next
        i++
      } else token = (token ?? '') + c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      token = token ?? ''
    } else if (c === ' ' || c === '\t') push()
    else if (c === '|') {
      if (command[i + 1] === '|') return '|| runs another command'
      push()
      segments.push([])
    } else if (';&<>`$()'.includes(c)) return `"${c}" chains, redirects or substitutes - only a plain command, or several joined with |`
    else if (c === '\\') {
      const next = command[i + 1]
      if (next === undefined || next === '\n') return 'a trailing backslash'
      token = (token ?? '') + next
      i++
    } else token = (token ?? '') + c
  }
  if (quote !== undefined) return 'an unclosed quote'
  push()
  if (segments.some((segment) => segment.length === 0)) return 'an empty command around |'
  return segments
}

export function checkReadOnly(command: string, extraPrograms: readonly string[] = []): Verdict {
  if (command.trim().length === 0) return { ok: false, reason: 'No command.' }
  if (command.length > 4000) return { ok: false, reason: 'The command is longer than 4000 characters.' }
  const segments = splitPipeline(command)
  if (typeof segments === 'string') return { ok: false, reason: `Refused: ${segments}.` }
  for (const [program, ...args] of segments) {
    const name = program as string
    if (!PROGRAM.test(name)) {
      return { ok: false, reason: `Refused: "${name}" - name a program by its bare name, without a path or variable assignments.` }
    }
    const rule = RULES[name]
    if (rule === undefined) {
      if (extraPrograms.includes(name)) continue
      return {
        ok: false,
        reason:
          `Refused: "${name}" is not on the read-only list. Use a read-only program instead, or ask the user to add ` +
          `"${name}" under "Also allow these programs" on the Linux tab if they know it only reads.`,
      }
    }
    const problem = rule(args)
    if (problem !== undefined) return { ok: false, reason: `Refused: ${name} - ${problem}.` }
  }
  return { ok: true }
}
