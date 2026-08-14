import { inflateRawSync } from 'node:zlib'

/**
 * Just enough ZIP to read an Office document.
 *
 * `.docx` and `.xlsx` are both ZIP archives of XML, so one small reader covers both formats
 * with no dependency at all. A library would add megabytes to the VSIX to do what amounts to
 * two header structs and `inflateRaw`, which `node:zlib` already provides.
 *
 * Deliberately **read-only and in-memory**: nothing is ever extracted to disk, so the
 * zip-slip class of bug — an entry named `../../etc/passwd` escaping the extraction directory
 * — cannot occur here. Entry names are only ever compared, never used as paths.
 *
 * Not a general ZIP implementation. No ZIP64, no encryption, no multi-disk archives. Office
 * writes none of those for ordinary documents, and failing clearly on one is better than
 * half-supporting it.
 */

const END_OF_CENTRAL_DIRECTORY = 0x06054b50
const CENTRAL_FILE_HEADER = 0x02014b50
const LOCAL_FILE_HEADER = 0x04034b50

const STORED = 0
const DEFLATED = 8

/**
 * Ceiling on what a single entry may inflate to.
 *
 * A deflate stream can expand enormously from very little input, so an untrusted archive can
 * exhaust memory without being large on disk. 128MB is far past any real document and far
 * short of a problem.
 */
const MAX_ENTRY_BYTES = 128 * 1024 * 1024

export class ZipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipError'
  }
}

interface CentralEntry {
  name: string
  compression: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

/** The end-of-central-directory record, found by scanning backwards for its signature. */
function findEndOfCentralDirectory(buffer: Buffer): number {
  // The record is 22 bytes plus an optional comment of up to 64KB, so the search window is
  // bounded rather than scanning the whole file.
  const earliest = Math.max(0, buffer.length - (22 + 0xffff))
  for (let offset = buffer.length - 22; offset >= earliest; offset--) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset
  }
  throw new ZipError('Not a ZIP archive, or the file is truncated.')
}

function readCentralDirectory(buffer: Buffer): Map<string, CentralEntry> {
  const eocd = findEndOfCentralDirectory(buffer)
  const total = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)

  if (offset === 0xffffffff) throw new ZipError('ZIP64 archives are not supported.')

  const entries = new Map<string, CentralEntry>()
  for (let index = 0; index < total; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) {
      throw new ZipError('The ZIP central directory is malformed.')
    }
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)

    entries.set(name, {
      name,
      compression: buffer.readUInt16LE(offset + 10),
      compressedSize: buffer.readUInt32LE(offset + 20),
      uncompressedSize: buffer.readUInt32LE(offset + 24),
      localHeaderOffset: buffer.readUInt32LE(offset + 42),
    })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

export class ZipArchive {
  private constructor(
    private readonly buffer: Buffer,
    private readonly entries: Map<string, CentralEntry>,
  ) {}

  static open(buffer: Buffer): ZipArchive {
    return new ZipArchive(buffer, readCentralDirectory(buffer))
  }

  has(name: string): boolean {
    return this.entries.has(name)
  }

  names(): string[] {
    return [...this.entries.keys()]
  }

  /** Undefined when the entry is absent — a missing optional part is not an error. */
  readText(name: string): string | undefined {
    const entry = this.entries.get(name)
    if (entry === undefined) return undefined

    /*
     * The central directory records the *local* header's position, and that header repeats
     * the name and extra fields at possibly different lengths. The data offset must be
     * computed from the local header, not assumed from the central one.
     */
    const header = entry.localHeaderOffset
    if (header + 30 > this.buffer.length || this.buffer.readUInt32LE(header) !== LOCAL_FILE_HEADER) {
      throw new ZipError(`The entry "${name}" has a malformed local header.`)
    }
    const nameLength = this.buffer.readUInt16LE(header + 26)
    const extraLength = this.buffer.readUInt16LE(header + 28)
    const start = header + 30 + nameLength + extraLength
    const end = start + entry.compressedSize

    if (end > this.buffer.length) throw new ZipError(`The entry "${name}" extends past the end of the file.`)
    if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
      throw new ZipError(`"${name}" expands to ${String(entry.uncompressedSize)} bytes, which is too large to read.`)
    }

    const raw = this.buffer.subarray(start, end)
    if (entry.compression === STORED) return raw.toString('utf8')
    if (entry.compression !== DEFLATED) {
      throw new ZipError(`"${name}" uses an unsupported compression method (${String(entry.compression)}).`)
    }
    // `maxOutputLength` is the real guard: the declared size above can lie, this cannot.
    return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES }).toString('utf8')
  }
}
