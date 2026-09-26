import type { AtlassianProductId } from '../agent/protocol.js'

/**
 * What differs between the three Atlassian products, in one table the host and the settings panel
 * both read, so the panel can never offer a default the host does not save. Browser-safe.
 */

export interface AtlassianDefaultField {
  /** The key inside the product's config block. */
  key: string
  label: string
  placeholder: string
  hint: string
}

export interface AtlassianProductInfo {
  id: AtlassianProductId
  label: string
  /** Where the token lives in secret storage. Never in config (§15). */
  tokenRef: string
  sitePlaceholder: string
  /** What the product lets the assistant do, in one sentence for the panel. */
  does: string
  defaults: readonly AtlassianDefaultField[]
}

export const ATLASSIAN_PRODUCTS: readonly AtlassianProductInfo[] = [
  {
    id: 'confluence',
    label: 'Confluence',
    tokenRef: 'confluence:token',
    sitePlaceholder: 'https://wiki.example.com/confluence',
    does:
      'search, read and write pages — including the images on a page, attached diagrams, and files',
    defaults: [
      {
        key: 'defaultSpace',
        label: 'Default space for new pages',
        placeholder: 'e.g. TEAM',
        hint: 'The key in the space’s address, e.g. TEAM in /display/TEAM/…. New pages go here unless you ask for another space.',
      },
    ],
  },
  {
    id: 'jira',
    label: 'Jira',
    tokenRef: 'jira:token',
    sitePlaceholder: 'https://jira.example.com',
    does: 'search and read issues, create them, edit them, comment, and move their status',
    defaults: [
      {
        key: 'defaultProject',
        label: 'Default project for new issues',
        placeholder: 'e.g. ABC',
        hint: 'The key issues start with, e.g. ABC in ABC-123. New issues go here unless you ask for another project.',
      },
    ],
  },
  {
    id: 'bitbucket',
    label: 'Bitbucket',
    tokenRef: 'bitbucket:token',
    sitePlaceholder: 'https://git.example.com',
    does:
      'list and read pull requests with their diffs and comments, read files at any branch, open pull requests and comment — never approve or merge',
    defaults: [
      {
        key: 'defaultProject',
        label: 'Default project',
        placeholder: 'e.g. PLAT',
        hint: 'The project key in the repository’s address: /projects/PLAT/repos/….',
      },
      {
        key: 'defaultRepo',
        label: 'Default repository',
        placeholder: 'e.g. service-api',
        hint: 'The repository slug, the part after /repos/. Used when you do not name one.',
      },
    ],
  },
]

export function atlassianProduct(id: AtlassianProductId): AtlassianProductInfo {
  const found = ATLASSIAN_PRODUCTS.find((product) => product.id === id)
  if (found === undefined) throw new Error(`Unknown Atlassian product: ${String(id)}`)
  return found
}
