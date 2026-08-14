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
  /**
   * A byte range, so a huge file can be read a piece at a time.
   *
   * `readFile` on a multi-gigabyte log does not merely use a lot of memory — it exceeds V8's
   * maximum string length and throws, so `offset`/`limit` cannot help: the whole read happens
   * before any slicing. This is how a log is read in parts instead.
   *
   * Bytes rather than text, because a range boundary lands mid-character often enough to
   * matter; the caller reassembles with a decoder that carries the partial sequence across.
   * `end` is exclusive and may exceed the file, which simply yields what is there.
   */
  readBytesSlice(path: string, start: number, end: number): Promise<Buffer>
  writeFile(path: string, contents: string): Promise<void>
  stat(path: string): Promise<FileStat>
  readdir(path: string): Promise<DirEntry[]>
  exists(path: string): Promise<boolean>
  mkdir(path: string): Promise<void>
}
