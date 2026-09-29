import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

import { installArguments } from './deps.js'
import { findMissingPackages, importedModules, interpreterCheck, isInstallableRequirement } from './missingPackages.js'
import { createInstallPackagesTool, type PythonToolContext } from './tools.js'

/**
 * A tool arriving from a bucket may need packages this machine's environment lacks. The assistant
 * should know before calling it, and be able to install them with the user's agreement.
 */

const TOOL = [
  '# /// script',
  '# dependencies = ["python-dateutil>=2.8", "requests"]',
  '# ///',
  '"""Summarise a ledger.',
  '',
  'Remember to import data from the ledger first.',
  '"""',
  'import os, json',
  'from dateutil import parser',
  'import yaml',
  'from . import helpers',
  '',
  'def run(day: str) -> str:',
  '    import pandas as pd',
  '    return day',
].join('\n')

describe('what a tool needs', () => {
  it('reads imports from code, including inside functions, and never from the docstring', () => {
    expect(importedModules(TOOL)).toEqual(['dateutil', 'json', 'os', 'pandas', 'yaml'])
  })

  it('names declared distributions as declared, and undeclared modules by their package', async () => {
    const missing = await findMissingPackages([{ name: 'ledger', source: TOOL }], async (query) => {
      expect(query.distributions.sort()).toEqual(['python-dateutil', 'requests'])
      return { missingModules: ['dateutil', 'yaml', 'pandas'], missingDistributions: ['python-dateutil'] }
    })
    // `dateutil` is provided by the declared `python-dateutil`, so it is not listed twice.
    expect(missing.get('ledger')).toEqual(['python-dateutil', 'pandas', 'PyYAML'])
  })

  it('lists nothing for a tool whose environment is complete', async () => {
    const missing = await findMissingPackages([{ name: 'ok', source: 'import os\n' }], async () => ({
      missingModules: [],
      missingDistributions: [],
    }))
    expect(missing.size).toBe(0)
  })
})

/** A real interpreter, when this machine has one, so the check script is known to run. */
function python(): string | undefined {
  for (const candidate of ['python', 'python3']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' })
      return candidate
    } catch {
      // Next.
    }
  }
  return undefined
}
const interpreter = python()

describe('asking a real interpreter', () => {
  it.skipIf(interpreter === undefined)('finds the standard library and misses what is not there, without importing', async () => {
    const answer = await interpreterCheck(interpreter!, process.env)({
      modules: ['json', 'surely_not_a_module_lc'],
      distributions: ['surely-not-a-distribution-lc'],
    })
    expect(answer).toEqual({ missingModules: ['surely_not_a_module_lc'], missingDistributions: ['surely-not-a-distribution-lc'] })
  })
})

describe('install_python_packages', () => {
  const context = {
    toolsDir: 'D:/proj/.lightcode/tools',
    onChanged: async () => {},
    installDeps: async (packages: readonly string[]) => ({ installed: [...packages] }),
    installCommand: (packages: readonly string[]) =>
      ['uv', ...installArguments({ pythonPath: 'D:/venv/python.exe', packages, indexUrl: 'https://pypi.internal/simple' })].join(' '),
  } as unknown as PythonToolContext & { installCommand: (packages: readonly string[]) => string }
  const tool = createInstallPackagesTool(context)

  it('shows the literal command, with the configured index, and names ending the options', async () => {
    const preview = await tool.preview?.({ packages: ['pandas', 'httpx>=0.27'] }, {} as never)
    expect(preview).toEqual({
      kind: 'command',
      command: 'uv pip install --python D:/venv/python.exe --index-url https://pypi.internal/simple -- pandas httpx>=0.27',
      cwd: 'D:/proj/.lightcode/tools',
    })
  })

  it('refuses anything that is not a package name, before and at execution', async () => {
    expect(isInstallableRequirement('--index-url=https://evil.example')).toBe(false)
    expect(isInstallableRequirement('pkg @ https://evil.example/pkg.whl')).toBe(false)
    expect(isInstallableRequirement('acme-sdk[fast]>=2.1,<3')).toBe(true)
    const preview = await tool.preview?.({ packages: ['--extra-index-url', 'evil'] }, {} as never)
    expect(preview?.kind).toBe('text')
    expect((await tool.execute({ packages: ['-e .'] }, {} as never)).isError).toBe(true)
  })

  it('is always asked about and never available to a schedule', async () => {
    const { ALWAYS_ASK_TOOLS } = await import('../approval/policy.js')
    const { NEVER_AVAILABLE_TO_SCHEDULES } = await import('../schedule/runner.js')
    expect(ALWAYS_ASK_TOOLS.has('install_python_packages')).toBe(true)
    expect(NEVER_AVAILABLE_TO_SCHEDULES).toContain('install_python_packages')
  })
})
