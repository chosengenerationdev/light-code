export interface FileStat {
  size: number
  mtimeMs: number
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
}

export interface DirEntry {
  name: string
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
}

/**
 * Plain string paths only — no `vscode.Uri`. Uri conversion happens at the host
 * boundary (apps/vscode), never in core. See CLAUDE.md §4.
 */
export interface FileSystem {
  readFile(path: string): Promise<string>
  writeFile(path: string, contents: string): Promise<void>
  stat(path: string): Promise<FileStat>
  readdir(path: string): Promise<DirEntry[]>
  exists(path: string): Promise<boolean>
  mkdir(path: string): Promise<void>
}
