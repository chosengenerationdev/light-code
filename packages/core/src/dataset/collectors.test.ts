import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const bridge = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'host', 'bridge.ts'),
  'utf8',
)

/**
 * The collector picker must offer Python tools and MCP tools.
 *
 * The first version filtered on the tool *group* and showed only the built-ins, because a Python
 * tool is registered as `command` — it runs code — and the built-in readers are the only things
 * in `read`. Reported as exactly that: "collector tool only shows inbuilt tools".
 *
 * Read from the source, because what is wrong is which tools reach the list, and a test of the
 * component would agree with whatever the component was handed. Same reasoning as
 * `config/retrieval.test.ts` reading this file.
 */
describe('the collectors offered for a dataset', () => {
  it('selects Python tools by their prefix, not by permission group', () => {
    expect(bridge).toContain("tool.name.startsWith('py__')")
  })

  it('includes MCP tools', () => {
    expect(bridge).toMatch(/tool\.name\.startsWith\('py__'\) \|\| tool\.group === 'mcp'/)
  })

  it('does not filter collectors on the read group, which held only built-ins', () => {
    expect(bridge).not.toMatch(/tool\.group === 'read' \|\| tool\.group === 'mcp'/)
  })

  it('finds the collector by its bare name first, so a namespaced MCP tool works as written', () => {
    // `jira__search_issues` is the name the user picked; trying `py__` first would miss it.
    expect(bridge).toContain('registry.get(dataset.toolName) ?? registry.get(`py__${dataset.toolName}`)')
  })
})
