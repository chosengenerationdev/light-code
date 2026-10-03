import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * The language servers Light Code knows how to start, most likely first for each language.
 *
 * None is shipped: they are large, and many arrive through package managers an office network
 * blocks. Each is used only when it is already installed - found on PATH - or the user names a
 * command in Settings (`lsp.servers`). The VS Code extension needs none of this: it asks VS Code,
 * whose own language support is already running.
 */

export interface LspCandidate {
  command: string
  args: string[]
}

export interface LspLanguage {
  id: string
  label: string
  extensions: string[]
  /** The LSP languageId for a file, when one language covers several (TS/TSX/JS). */
  languageIdFor?: (extension: string) => string
  candidates: LspCandidate[]
}

const c = (command: string, ...args: string[]): LspCandidate => ({ command, args })

export const LSP_LANGUAGES: LspLanguage[] = [
  { id: 'python', label: 'Python', extensions: ['py', 'pyi'], candidates: [c('pyright-langserver', '--stdio'), c('basedpyright-langserver', '--stdio'), c('pylsp'), c('jedi-language-server')] },
  {
    id: 'typescript',
    label: 'TypeScript / JavaScript',
    extensions: ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'],
    languageIdFor: (ext) => (ext === 'tsx' ? 'typescriptreact' : ext === 'jsx' ? 'javascriptreact' : ['js', 'mjs', 'cjs'].includes(ext) ? 'javascript' : 'typescript'),
    candidates: [c('typescript-language-server', '--stdio')],
  },
  { id: 'java', label: 'Java', extensions: ['java'], candidates: [c('jdtls')] },
  { id: 'csharp', label: 'C#', extensions: ['cs'], candidates: [c('csharp-ls'), c('OmniSharp', '-lsp')] },
  { id: 'go', label: 'Go', extensions: ['go'], candidates: [c('gopls')] },
  { id: 'rust', label: 'Rust', extensions: ['rs'], candidates: [c('rust-analyzer')] },
  {
    id: 'cpp',
    label: 'C / C++',
    extensions: ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx'],
    languageIdFor: (ext) => (ext === 'c' ? 'c' : 'cpp'),
    candidates: [c('clangd')],
  },
  { id: 'kotlin', label: 'Kotlin', extensions: ['kt', 'kts'], candidates: [c('kotlin-language-server')] },
  { id: 'php', label: 'PHP', extensions: ['php'], candidates: [c('intelephense', '--stdio'), c('phpactor', 'language-server')] },
  { id: 'ruby', label: 'Ruby', extensions: ['rb'], candidates: [c('ruby-lsp'), c('solargraph', 'stdio')] },
  { id: 'swift', label: 'Swift', extensions: ['swift'], candidates: [c('sourcekit-lsp')] },
  { id: 'dart', label: 'Dart', extensions: ['dart'], candidates: [c('dart', 'language-server', '--protocol=lsp')] },
  { id: 'scala', label: 'Scala', extensions: ['scala', 'sc'], candidates: [c('metals')] },
  { id: 'lua', label: 'Lua', extensions: ['lua'], candidates: [c('lua-language-server')] },
  { id: 'shellscript', label: 'Bash', extensions: ['sh', 'bash'], candidates: [c('bash-language-server', 'start')] },
  { id: 'powershell', label: 'PowerShell', extensions: ['ps1', 'psm1'], candidates: [c('PowerShellEditorServices', '-Stdio')] },
  { id: 'yaml', label: 'YAML', extensions: ['yml', 'yaml'], candidates: [c('yaml-language-server', '--stdio')] },
  { id: 'json', label: 'JSON', extensions: ['json', 'jsonc'], candidates: [c('vscode-json-language-server', '--stdio')] },
  { id: 'html', label: 'HTML', extensions: ['html', 'htm'], candidates: [c('vscode-html-language-server', '--stdio')] },
  {
    id: 'css',
    label: 'CSS / SCSS / Less',
    extensions: ['css', 'scss', 'less'],
    languageIdFor: (ext) => ext,
    candidates: [c('vscode-css-language-server', '--stdio')],
  },
  { id: 'terraform', label: 'Terraform', extensions: ['tf', 'tfvars'], candidates: [c('terraform-ls', 'serve')] },
  { id: 'elixir', label: 'Elixir', extensions: ['ex', 'exs'], candidates: [c('elixir-ls'), c('language_server')] },
  { id: 'haskell', label: 'Haskell', extensions: ['hs'], candidates: [c('haskell-language-server-wrapper', '--lsp')] },
  { id: 'zig', label: 'Zig', extensions: ['zig'], candidates: [c('zls')] },
  { id: 'sql', label: 'SQL', extensions: ['sql'], candidates: [c('sql-language-server', 'up', '--method', 'stdio')] },
]

export function languageFor(file: string): LspLanguage | undefined {
  const ext = path.extname(file).slice(1).toLowerCase()
  return LSP_LANGUAGES.find((l) => l.extensions.includes(ext))
}

export function languageIdFor(language: LspLanguage, file: string): string {
  const ext = path.extname(file).slice(1).toLowerCase()
  return language.languageIdFor?.(ext) ?? language.id
}

/**
 * Where a bare command resolves on PATH, Windows extensions included - `npm i -g` puts `.cmd`
 * shims there, which is how most of these servers are installed.
 */
/**
 * PATH lookups, remembered for a minute: the settings panel asks about every candidate of every
 * language at once, and a PATH walk per candidate is about a second on Windows. A server installed
 * meanwhile shows up within the minute.
 */
const found = new Map<string, { at: number; value: string | undefined }>()

export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (path.isAbsolute(command)) return existsSync(command) ? command : undefined
  if (env !== process.env) return searchPath(command, env)
  const hit = found.get(command)
  if (hit !== undefined && Date.now() - hit.at < 60_000) return hit.value
  const value = searchPath(command, env)
  found.set(command, { at: Date.now(), value })
  return value
}

function searchPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter((d) => d.length > 0)
  const exts = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').toLowerCase().split(';')] : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext)
      if (existsSync(candidate) && (process.platform !== 'win32' || ext !== '' || /\.(exe|cmd|bat)$/i.test(candidate))) return candidate
    }
  }
  return undefined
}
