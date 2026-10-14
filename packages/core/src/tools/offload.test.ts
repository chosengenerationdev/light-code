import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { isOffloadable, OFFLOAD_FAMILIES, offloadedCatalogue } from './offload.js'
import { toToolDefinitions } from './registry.js'
import type { Tool } from './types.js'

/**
 * Integration tools move into the documentation index when one exists (tools/offload.ts). Measured
 * before: ~33,000 tokens of tool definitions on every request with everything switched on.
 */

/** Every tool the core source defines, found the way the measurement was made: by calling its creators. */
async function allTools(): Promise<Tool[]> {
  const files: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) files.push(full)
    }
  }
  await walk(path.join(import.meta.dirname, '..'))
  const modules: Record<string, unknown>[] = []
  for (const file of files) {
    try {
      modules.push((await import(pathToFileURL(file).href)) as Record<string, unknown>)
    } catch {
      // A module that cannot load on its own here defines no tool this test needs.
    }
  }
  const anything: unknown = new Proxy(function () {}, {
    get: (_t, key) => (key === Symbol.toPrimitive ? () => '' : key === 'then' ? undefined : anything),
    apply: () => undefined,
  })
  const found = new Map<string, Tool>()
  const keep = (value: unknown): void => {
    for (const t of Array.isArray(value) ? value : [value]) {
      const tool = t as Partial<Tool> | undefined
      if (tool !== undefined && tool !== null && typeof tool.name === 'string' && typeof tool.description === 'string' && (tool.parametersSchema !== undefined || tool.rawJsonSchema !== undefined)) {
        if (!found.has(tool.name)) found.set(tool.name, tool as Tool)
      }
    }
  }
  for (const mod of modules) {
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== 'function' || !/^create\w*Tools?$/.test(name)) continue
      for (const args of [[anything], ['fire-fs.exe'], [anything, anything], []]) {
        try {
          keep((value as (...a: unknown[]) => unknown)(...args))
        } catch {
          // This creator wants something else; another argument shape may suit it.
        }
      }
    }
  }
  return [...found.values()]
}

const tokens = (tools: Tool[]): number => Math.round(JSON.stringify(toToolDefinitions(tools)).length / 4)

describe('offloading built-in tools to the documentation index', () => {
  it('keeps what nearly every conversation needs in the prompt', () => {
    for (const name of ['read_file', 'list_files', 'search_files', 'write_to_file', 'apply_diff', 'execute_command', 'ask_followup_question', 'ask_user_form', 'attempt_completion', 'search_docs', 'call_tool', 'light_code_help', 'big_file', 'find_files', 'read_many_files', 'show_diagram', 'show_chart']) {
      expect(isOffloadable(name), name).toBe(false)
    }
  })

  it('puts every integration tool in a family, so a new one cannot sit in the prompt by accident', async () => {
    const families = /^(excel_|outlook_|mail_|confluence_|jira_|bitbucket_|jenkins_|autosys_|hub_|s3_)/
    const loose = (await allTools()).map((tool) => tool.name).filter((name) => families.test(name) && !isOffloadable(name))
    expect(loose).toEqual([])
  }, 60_000)

  it('keeps the always-advertised tool block within budget when the index is in use', async () => {
    const tools = await allTools()
    expect(tools.length).toBeGreaterThan(90)
    // Hidden by the dispatcher already, offloadable or not.
    const alreadyHidden = new Set(['create_role', 'update_role', 'delete_role', 'read_role_prompt', 'update_plan', 'plan_progress', 'light_code_export_config'])
    const advertised = tools.filter((tool) => !isOffloadable(tool.name) && !alreadyHidden.has(tool.name))
    const offloaded = tools.filter((tool) => isOffloadable(tool.name))
    // Every tool on at once - the worst case. Before offloading this was ~38,800.
    expect(tokens(advertised)).toBeLessThan(12_000)
    expect(tokens(offloaded)).toBeGreaterThan(20_000)
    // And the catalogue that replaces them is a small fraction of what it replaces.
    const catalogue = offloadedCatalogue(offloaded, 10) ?? ''
    expect(catalogue.length / 4).toBeLessThan(1_200)
  }, 60_000)

  it('names every hidden tool and tells the agent to look before it acts', () => {
    const catalogue = offloadedCatalogue(['jira_write_issue', 'jira_search', 'excel_read_range', 'http_request'], 3) ?? ''
    expect(catalogue).toContain('call `search_docs` describing what you need to do')
    expect(catalogue).toContain('call_tool(name, arguments)')
    expect(catalogue).toMatch(/\*\*Jira\*\* \([^)]*\): jira_search, jira_write_issue/)
    expect(catalogue).toContain('excel_read_range')
    expect(catalogue).toContain('http_request')
    expect(catalogue).toContain('3 more tool(s) from MCP servers')
    expect(offloadedCatalogue([], 0)).toBeUndefined()
    expect(OFFLOAD_FAMILIES.every((family) => family.about.length > 0)).toBe(true)
  })

  it('offloads only when a documentation index is in use, and always indexes what it may hide', async () => {
    const bridge = await fs.readFile(path.join(import.meta.dirname, '..', 'host', 'bridge.ts'), 'utf8')
    // The user's rule: without search indexing, the existing setup - everything advertised.
    expect(bridge).toMatch(/if \(dispatcher && docs !== undefined\) \{\s*for \(const tool of combined\.list\(\)\) if \(isOffloadable\(tool\.name\)\) combined\.register\(tool, \{ dispatchOnly: true \}\)/)
    // The index must contain them, or the prompt would send the agent to look up missing documentation.
    expect(bridge).toMatch(/registry\.isDispatchOnly\(tool\.name\) \|\| isOffloadable\(tool\.name\)/)
    // The catalogue appears under the same condition, and never for a scheduled run.
    expect(bridge).toMatch(/schedule === undefined && dispatcherEnabled\(config\.retrieval\) && search !== undefined && embedder !== undefined && docsIndex !== undefined/)
    // And keeps the index current while it does: nothing else reindexes when an index is first added or
    // a feature is switched on, which left the hidden tools findable only by name.
    const block = bridge.slice(bridge.indexOf('const catalogue = offloadedCatalogue(offloaded, otherHidden)'))
    expect(block.slice(0, 900)).toContain("scheduleDocsReindex('keeping the tool documentation current')")
  })
})
