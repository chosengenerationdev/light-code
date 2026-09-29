import { execFile } from 'node:child_process'

import { parseInlineDependencies } from './deps.js'

/**
 * Which packages a Python tool needs that the tools' environment does not have.
 *
 * ## Why
 *
 * Tools travel between machines through a bucket, and the machine they land on has its own
 * virtualenv. A tool that imports `pandas` arrives, is approved from its cached description, and
 * fails with `ModuleNotFoundError` the first time anybody asks for it — and a tool whose import
 * fails cannot be approved at all, because approving means loading it. Asked for directly: the
 * assistant should know before that happens, tell the user, and offer to install what is missing.
 *
 * ## Two sources, one check
 *
 * - **Declared** dependencies, from the tool's PEP 723 block — the authoritative list, and in
 *   distribution names (`python-dateutil`), which is what an install needs.
 * - **Imported** modules, read from the source — because plenty of tools import something they
 *   never declared, and those are exactly the ones that fail on the next machine.
 *
 * Both are checked in one interpreter start for every tool at once: `importlib.metadata` for a
 * distribution and `importlib.util.find_spec` for a module, neither of which imports anything, so
 * checking cannot run a tool's code.
 */

/** Import names whose distribution is called something else. Only well-known, stable cases. */
const DISTRIBUTION_FOR_MODULE: Record<string, string> = {
  yaml: 'PyYAML',
  cv2: 'opencv-python',
  PIL: 'Pillow',
  sklearn: 'scikit-learn',
  bs4: 'beautifulsoup4',
  dateutil: 'python-dateutil',
  docx: 'python-docx',
  pptx: 'python-pptx',
  jwt: 'PyJWT',
  dotenv: 'python-dotenv',
  win32com: 'pywin32',
  win32api: 'pywin32',
  pythoncom: 'pywin32',
  Crypto: 'pycryptodome',
  magic: 'python-magic',
  serial: 'pyserial',
  usb: 'pyusb',
  attr: 'attrs',
  pkg_resources: 'setuptools',
}

/** Modules provided by Light Code's own worker, never installable. */
const PROVIDED = new Set(['__future__', 'light_code'])

/** Top-level modules the source imports, including imports inside functions. Never relative ones. */
export function importedModules(source: string): string[] {
  /*
   * Triple-quoted strings removed first. A docstring saying "import data from the ledger" would
   * otherwise read as `import data`, and suggesting an install of whatever a sentence happened to
   * name is how a typo-squatted package ends up on somebody's machine.
   */
  const code = source.replace(/("""|''')[\s\S]*?\1/g, '')
  const found = new Set<string>()
  for (const match of code.matchAll(/^[ \t]*import[ \t]+([^\n#;]+)/gm)) {
    for (const part of (match[1] ?? '').split(',')) {
      const name = /^\s*([A-Za-z_]\w*)/.exec(part)?.[1]
      if (name !== undefined) found.add(name)
    }
  }
  for (const match of code.matchAll(/^[ \t]*from[ \t]+([A-Za-z_]\w*)[\w.]*[ \t]+import\b/gm)) {
    const name = match[1]
    if (name !== undefined) found.add(name)
  }
  return [...found].filter((name) => !PROVIDED.has(name)).sort()
}

/** `acme-sdk[extra]>=2.1; python_version>"3.9"` → `acme-sdk`. */
export function distributionName(requirement: string): string | undefined {
  return /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(requirement)?.[1]
}

/** PEP 503: distribution names compare case-insensitively with `-`, `_` and `.` alike. */
export function normaliseDistribution(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

export interface ToolSource {
  name: string
  source: string
}

export interface EnvironmentAnswer {
  missingModules: string[]
  missingDistributions: string[]
}

export type EnvironmentCheck = (query: { modules: string[]; distributions: string[] }) => Promise<EnvironmentAnswer>

const CHECK_SCRIPT = [
  'import sys, json, importlib.util, importlib.metadata as md',
  'q = json.load(sys.stdin)',
  'mods = []',
  'for m in q["modules"]:',
  '    try:',
  '        if importlib.util.find_spec(m) is None: mods.append(m)',
  '    except Exception:',
  '        mods.append(m)',
  'dists = []',
  'for d in q["distributions"]:',
  '    try: md.version(d)',
  '    except Exception: dists.append(d)',
  'print("@@LC@@" + json.dumps({"missingModules": mods, "missingDistributions": dists}))',
].join('\n')

/**
 * Asks an interpreter what it has. Behind a marker, because site customisations and libraries on
 * the path can print on import and a check that parsed "the output" would read noise as an answer.
 */
export function interpreterCheck(pythonPath: string, env: NodeJS.ProcessEnv): EnvironmentCheck {
  return (query) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        pythonPath,
        ['-c', CHECK_SCRIPT],
        { timeout: 30_000, windowsHide: true, env, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => {
          const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith('@@LC@@'))
          if (line === undefined) {
            reject(error ?? new Error('The Python environment did not answer the package check.'))
            return
          }
          resolve(JSON.parse(line.slice('@@LC@@'.length)) as EnvironmentAnswer)
        },
      )
      child.stdin?.end(JSON.stringify(query))
    })
}

/**
 * The packages each tool needs and the environment lacks, as names to install.
 *
 * A declared distribution that is missing is listed by its declared name. An imported module that
 * is missing and not covered by a declared distribution is listed by its known distribution name,
 * or its own name — right far more often than not, and the install shows exactly what it will run.
 */
export async function findMissingPackages(tools: readonly ToolSource[], check: EnvironmentCheck): Promise<Map<string, string[]>> {
  const perTool = tools.map((tool) => {
    const declared = parseInlineDependencies(tool.source)
      .map(distributionName)
      .filter((name): name is string => name !== undefined)
    return { name: tool.name, declared, modules: importedModules(tool.source) }
  })
  const modules = [...new Set(perTool.flatMap((tool) => tool.modules))]
  const distributions = [...new Set(perTool.flatMap((tool) => tool.declared))]
  const result = new Map<string, string[]>()
  if (modules.length === 0 && distributions.length === 0) return result

  const answer = await check({ modules, distributions })
  const missingModules = new Set(answer.missingModules)
  const missingDistributions = new Set(answer.missingDistributions.map(normaliseDistribution))

  for (const tool of perTool) {
    const needed: string[] = tool.declared.filter((name) => missingDistributions.has(normaliseDistribution(name)))
    const declaredNormalised = new Set(tool.declared.map(normaliseDistribution))
    for (const module of tool.modules) {
      if (!missingModules.has(module)) continue
      const distribution = DISTRIBUTION_FOR_MODULE[module] ?? module
      // A declared distribution is assumed to provide the module of the same or a mapped name;
      // listing it twice would install one package under two spellings.
      if (declaredNormalised.has(normaliseDistribution(distribution)) || declaredNormalised.has(normaliseDistribution(module))) continue
      if (!needed.some((name) => normaliseDistribution(name) === normaliseDistribution(distribution))) needed.push(distribution)
    }
    if (needed.length > 0) result.set(tool.name, needed)
  }
  return result
}

/** A package name as it may be passed to an installer: a requirement, never an option. */
export function isInstallableRequirement(requirement: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._-]+\])?\s*([<>=!~]=?\s*[A-Za-z0-9.*+!_-]+(\s*,\s*[<>=!~]=?\s*[A-Za-z0-9.*+!_-]+)*)?$/.test(
    requirement.trim(),
  )
}
