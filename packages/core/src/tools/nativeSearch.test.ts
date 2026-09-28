import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeFileSystem } from '../platform/node/filesystem.js'
import { PathDenylist } from '../fs/denylist.js'
import { listFilesTool } from './listFiles.js'
import { compilePattern, globToRegExp, searchFiles, walkFiles } from './nativeSearch.js'
import { searchFilesTool } from './searchFiles.js'
import type { ToolExecutionContext } from './types.js'

/**
 * The search that runs when ripgrep will not.
 *
 * Reported from real use: search "breaks very often complaining ripgrep is missing", and the model
 * then asks to run `rg` as a shell command every time. On a managed machine the binary under the
 * user profile is commonly refused, so the tools must answer without it — and answer the same way,
 * or the model gets different results depending on the machine.
 */

const roots: string[] = []
const fsImpl = new NodeFileSystem()

function tree(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lc-search-')))
  roots.push(root)
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, ...relative.split('/'))
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, content)
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const sample = {
  '.gitignore': 'dist/\n*.log\n/build\n!keep.log\n',
  'src/app.ts': 'const a = 1\nfunction hello() {\n  return "Hello"\n}\nexport { hello }\n',
  'src/deep/util.tsx':
    'line one\nline two\nhello there\nline four\nline five\nline six\nline seven\nhello again\n',
  'src/notes.log': 'hello in a log\n',
  'keep.log': 'hello kept\n',
  'dist/out.js': 'hello built\n',
  'build/x.txt': 'hello at root build\n',
  'lib/build/y.txt': 'hello in nested build\n',
  'node_modules/pkg/index.js': 'hello dependency\n',
  '.hidden/secret.txt': 'hello hidden\n',
  'bin/blob.bin': 'hello\u0000binary',
}

describe('the built-in walk', () => {
  it('honours .gitignore: directories, extensions, anchoring and negation', async () => {
    const root = tree(sample)
    const { files } = await walkFiles(fsImpl, root, { includeIgnored: false })
    expect(files).toContain('src/app.ts')
    expect(files).toContain('keep.log')
    expect(files).toContain('.hidden/secret.txt')
    // `/build` is anchored to the root, so a nested build folder survives.
    expect(files).toContain('lib/build/y.txt')
    expect(files).not.toContain('build/x.txt')
    expect(files).not.toContain('dist/out.js')
    expect(files).not.toContain('src/notes.log')
    expect(files.some((file) => file.startsWith('node_modules'))).toBe(false)
  })

  it('includes ignored files on request, but never .git or node_modules', async () => {
    const root = tree({ ...sample, '.git/HEAD': 'ref' })
    const { files } = await walkFiles(fsImpl, root, { includeIgnored: true })
    expect(files).toContain('dist/out.js')
    expect(files.some((file) => file.startsWith('.git/') || file.startsWith('node_modules/'))).toBe(
      false,
    )
  })

  /* Found by comparing with ripgrep on a real repository: both of these are honoured there. */
  it('honours .git/info/exclude and the global git excludes file', async () => {
    const root = tree({
      '.git/info/exclude': 'scratch/\n',
      'scratch/notes.txt': 'x',
      'local.settings.json': 'x',
      'kept.txt': 'x',
    })
    const global = path.join(root, 'global-ignore')
    fs.writeFileSync(global, '**/local.settings.json\n')
    const { files } = await walkFiles(fsImpl, root, { includeIgnored: false, globalIgnoreFile: global })
    expect(files).toContain('kept.txt')
    expect(files).not.toContain('scratch/notes.txt')
    expect(files).not.toContain('local.settings.json')
  })

  it('says when it stopped early', async () => {
    const root = tree({ 'a.txt': '', 'b.txt': '', 'c.txt': '' })
    expect(await walkFiles(fsImpl, root, { includeIgnored: false, maxFiles: 2 })).toEqual({
      files: ['a.txt', 'b.txt'],
      truncated: true,
    })
  })
})

describe('globs and patterns', () => {
  it('reads globs the way ripgrep -g and .gitignore do', () => {
    expect(globToRegExp('*.ts', false).test('src/a.ts')).toBe(true)
    expect(globToRegExp('*.ts', false).test('src/a.tsx')).toBe(false)
    expect(globToRegExp('*.{ts,tsx}', false).test('src/a.tsx')).toBe(true)
    expect(globToRegExp('src/**/*.ts', true).test('src/a/b/c.ts')).toBe(true)
    expect(globToRegExp('src/**/*.ts', true).test('src/c.ts')).toBe(true)
    expect(globToRegExp('src/**/*.ts', true).test('lib/src/c.ts')).toBe(false)
    expect(globToRegExp('file?.[ch]', false).test('file1.c')).toBe(true)
  })

  it('understands a leading (?i), which models write and JavaScript does not', () => {
    expect(compilePattern('(?i)hello').test('HELLO')).toBe(true)
    // Legal in ripgrep, a syntax error in JavaScript's Unicode mode.
    expect(compilePattern('a\\-b').test('a-b')).toBe(true)
    expect(() => compilePattern('(unclosed')).toThrow(/not a valid regular expression/)
  })
})

/** The same binary the extension resolves when running from source. */
function ripgrepForComparison(): string | undefined {
  try {
    const require = createRequire(import.meta.url)
    const { rgPath } = require('@vscode/ripgrep') as { rgPath: string }
    return fs.existsSync(rgPath) ? rgPath : undefined
  } catch {
    return undefined
  }
}

const rg = ripgrepForComparison()

describe('agreement with ripgrep', () => {
  const normalise = (text: string): string[] =>
    text
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .sort()

  it.skipIf(rg === undefined)(
    'finds the same lines, with the same context and separators',
    async () => {
      const root = tree({ ...sample, '.git/HEAD': 'ref' })
      const expected = execFileSync(
        rg!,
        [
          '--line-number',
          '--context',
          '2',
          '--hidden',
          '-g',
          '!.git',
          '-g',
          '!node_modules',
          '--regexp',
          'hello',
          '.',
        ],
        { cwd: root, encoding: 'utf8' },
      )
      const { output } = await searchFiles(fsImpl, root, {
        pattern: 'hello',
        includeIgnored: false,
      })
      expect(normalise(output)).toEqual(normalise(expected))
    },
  )

  it.skipIf(rg === undefined)('lists the same files', async () => {
    const root = tree({ ...sample, '.git/HEAD': 'ref' })
    const expected = execFileSync(
      rg!,
      ['--files', '--hidden', '-g', '!.git', '-g', '!node_modules'],
      {
        cwd: root,
        encoding: 'utf8',
      },
    )
    const { files } = await walkFiles(fsImpl, root, { includeIgnored: false })
    expect(normalise(files.join('\n'))).toEqual(normalise(expected.split(path.sep).join('/')))
  })
})

describe('the tools without a working ripgrep', () => {
  const contextFor = (root: string, ripgrepPath?: string): ToolExecutionContext =>
    ({
      fs: fsImpl,
      workspaceRoot: root,
      denylist: new PathDenylist(),
      readFiles: new Set<string>(),
      ...(ripgrepPath !== undefined ? { ripgrepPath } : {}),
    }) as unknown as ToolExecutionContext

  // A path that no longer exists: what an update or a policy block leaves the tool holding.
  for (const [label, ripgrepPath] of [
    ['with none at all', undefined],
    ['when the binary will not start', path.join(os.tmpdir(), 'no-such-dir', 'rg.exe')],
  ] as const) {
    it(`search_files still answers ${label}`, async () => {
      const root = tree(sample)
      const result = await searchFilesTool.execute(
        { path: '.', pattern: 'hello', filePattern: '*.ts' },
        contextFor(root, ripgrepPath),
      )
      expect(result.isError).not.toBe(true)
      expect(result.content).toContain(`src${path.sep}app.ts:2:function hello() {`)
      expect(result.content).not.toContain('util.tsx')
    })

    it(`list_files still lists recursively ${label}`, async () => {
      const root = tree(sample)
      const result = await listFilesTool.execute(
        { path: '.', recursive: true },
        contextFor(root, ripgrepPath),
      )
      expect(result.isError).not.toBe(true)
      expect(result.content).toContain(`src${path.sep}deep${path.sep}util.tsx`)
      expect(result.content).not.toContain('out.js')
    })
  }

  it('still reports a bad pattern as a bad pattern', async () => {
    const root = tree(sample)
    const result = await searchFilesTool.execute(
      { path: '.', pattern: '(unclosed' },
      contextFor(root),
    )
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/not a valid regular expression/)
  })
})
