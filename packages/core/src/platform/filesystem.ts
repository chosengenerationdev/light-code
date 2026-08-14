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
  /**
   * Raw bytes, for formats that are not text.
   *
   * `.docx` and `.xlsx` are ZIP archives; decoding them as UTF-8 first would corrupt the
   * compressed streams beyond recovery. Kept as a separate method rather than an encoding
   * argument so the common case stays a plain string and no caller has to remember which
   * variant it wanted.
   */
  readBytes(path: string): Promise<Buffer>
  writeFile(path: string, contents: string): Promise<void>
  stat(path: string): Promise<FileStat>
  readdir(path: string): Promise<DirEntry[]>
  exists(path: string): Promise<boolean>
  mkdir(path: string): Promise<void>
}
