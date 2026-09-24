/**
 * Compound File Binary Format — the container an Outlook `.msg` is stored in.
 *
 * ## Why this is hand-written
 *
 * The same reason `pdf.ts` is: a library for it is megabytes that every user downloads whether or
 * not they ever open one, and this product's whole posture is that nothing arrives that the user
 * did not ask for. What is needed here is also narrow — read a few named streams out of a
 * directory — rather than the whole of MS-CFB.
 *
 * ## What it does not do, deliberately
 *
 * No writing, no transactions, no DIFAT beyond what a real message needs, no red-black rebalancing
 * of the directory (it is walked, not searched). Anything it cannot make sense of raises, and the
 * caller turns that into a sentence naming the file — a half-parsed message is worse than a
 * refusal, because a model handed fragments summarises them confidently (§17, and the reason
 * `pdf.ts` withholds glyph soup).
 */

/** `D0 CF 11 E0 A1 B1 1A E1` — the signature every compound file starts with. */
const SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

const FREE_SECTOR = 0xffffffff
const END_OF_CHAIN = 0xfffffffe
/** A sector holding FAT entries; it is not part of any stream. */
const FAT_SECTOR = 0xfffffffd
const DIFAT_SECTOR = 0xfffffffc

const DIRECTORY_ENTRY_SIZE = 128

export class CompoundFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CompoundFileError'
  }
}

export interface CompoundEntry {
  name: string
  /** 1 storage (a folder), 2 stream (a file), 5 root. */
  type: number
  size: number
  startSector: number
  /** Directory ids of the children, resolved from the red-black tree. */
  children: number[]
}

export function isCompoundFile(buffer: Buffer): boolean {
  return buffer.length >= SIGNATURE.length && buffer.subarray(0, 8).equals(SIGNATURE)
}

/**
 * A compound file opened for reading.
 *
 * Everything is resolved eagerly — the FAT, the mini FAT and the whole directory — because a
 * `.msg` is small and read once, and lazy chains would mean the same bounds checks written in
 * three places.
 */
export class CompoundFile {
  private readonly sectorSize: number
  private readonly miniSectorSize: number
  private readonly miniCutoff: number
  private readonly fat: number[]
  private readonly miniFat: number[]
  private readonly entries: CompoundEntry[]
  private readonly miniStream: Buffer

  constructor(private readonly buffer: Buffer) {
    if (!isCompoundFile(buffer)) {
      throw new CompoundFileError('not a compound file: the signature does not match')
    }
    if (buffer.length < 512) throw new CompoundFileError('file is too short to hold a header')

    this.sectorSize = 1 << buffer.readUInt16LE(0x1e)
    this.miniSectorSize = 1 << buffer.readUInt16LE(0x20)
    /*
     * Rejected rather than trusted. These come straight from the file, and a corrupt or hostile
     * one naming a 2GB sector would have every read below allocating against it.
     */
    if (this.sectorSize !== 512 && this.sectorSize !== 4096) {
      throw new CompoundFileError(`unsupported sector size ${String(this.sectorSize)}`)
    }
    if (this.miniSectorSize !== 64) {
      throw new CompoundFileError(`unsupported mini sector size ${String(this.miniSectorSize)}`)
    }
    this.miniCutoff = buffer.readUInt32LE(0x38)

    this.fat = this.readFat()
    this.entries = this.readDirectory(buffer.readUInt32LE(0x30))

    const root = this.entries[0]
    if (root === undefined) throw new CompoundFileError('the directory has no root entry')
    this.miniFat = this.readMiniFat(buffer.readUInt32LE(0x3c), buffer.readUInt32LE(0x40))
    // The mini stream is the root entry's own stream, held in ordinary sectors.
    this.miniStream = this.readChain(root.startSector, root.size, this.fat, this.sectorSize)
  }

  /** Every entry, in directory order. Index 0 is the root. */
  list(): readonly CompoundEntry[] {
    return this.entries
  }

  /** The children of an entry, resolved through its red-black tree. */
  childrenOf(id: number): CompoundEntry[] {
    const entry = this.entries[id]
    if (entry === undefined) return []
    return entry.children
      .map((child) => this.entries[child])
      .filter((child): child is CompoundEntry => child !== undefined)
  }

  /** A stream's bytes. Empty for a storage, which has no stream of its own. */
  read(entry: CompoundEntry): Buffer {
    if (entry.size === 0) return Buffer.alloc(0)
    /*
     * Small streams live in the mini stream, chained by the mini FAT. That split is the part of
     * this format people get wrong: a `.msg`'s subject is almost always under the cutoff, so a
     * reader that only understood ordinary sectors would return nothing for the one field
     * everybody wants and look like it had worked.
     */
    if (entry.size < this.miniCutoff) {
      return this.readChainFrom(this.miniStream, entry.startSector, entry.size, this.miniFat, this.miniSectorSize)
    }
    return this.readChain(entry.startSector, entry.size, this.fat, this.sectorSize)
  }

  private sectorOffset(sector: number): number {
    // Sector 0 begins immediately after the 512-byte header, whatever the sector size.
    return 512 + sector * this.sectorSize
  }

  private readFat(): number[] {
    const fatSectorCount = this.buffer.readUInt32LE(0x2c)
    const sectors: number[] = []

    // The first 109 FAT sector numbers live in the header itself.
    for (let index = 0; index < 109 && sectors.length < fatSectorCount; index += 1) {
      const sector = this.buffer.readUInt32LE(0x4c + index * 4)
      if (sector === FREE_SECTOR || sector === END_OF_CHAIN) break
      sectors.push(sector)
    }

    // Anything beyond that is chained through DIFAT sectors.
    let difat = this.buffer.readUInt32LE(0x44)
    let guard = 0
    const perSector = this.sectorSize / 4
    while (difat !== END_OF_CHAIN && difat !== FREE_SECTOR && sectors.length < fatSectorCount) {
      if (guard++ > 1_000_000) throw new CompoundFileError('the DIFAT chain does not terminate')
      const base = this.sectorOffset(difat)
      this.requireSector(base)
      for (let index = 0; index < perSector - 1 && sectors.length < fatSectorCount; index += 1) {
        const sector = this.buffer.readUInt32LE(base + index * 4)
        if (sector === FREE_SECTOR || sector === END_OF_CHAIN) continue
        sectors.push(sector)
      }
      difat = this.buffer.readUInt32LE(base + (perSector - 1) * 4)
    }

    const fat: number[] = []
    for (const sector of sectors) {
      const base = this.sectorOffset(sector)
      this.requireSector(base)
      for (let index = 0; index < perSector; index += 1) fat.push(this.buffer.readUInt32LE(base + index * 4))
    }
    return fat
  }

  private readMiniFat(first: number, count: number): number[] {
    const miniFat: number[] = []
    let sector = first
    const perSector = this.sectorSize / 4
    for (let read = 0; read < count && sector !== END_OF_CHAIN && sector !== FREE_SECTOR; read += 1) {
      const base = this.sectorOffset(sector)
      this.requireSector(base)
      for (let index = 0; index < perSector; index += 1) miniFat.push(this.buffer.readUInt32LE(base + index * 4))
      sector = this.fat[sector] ?? END_OF_CHAIN
    }
    return miniFat
  }

  private readDirectory(first: number): CompoundEntry[] {
    const raw = this.readChain(first, Number.MAX_SAFE_INTEGER, this.fat, this.sectorSize)
    const entries: CompoundEntry[] = []
    const siblings: { left: number; right: number; child: number }[] = []

    for (let offset = 0; offset + DIRECTORY_ENTRY_SIZE <= raw.length; offset += DIRECTORY_ENTRY_SIZE) {
      const nameLength = raw.readUInt16LE(offset + 0x40)
      // The length counts bytes and includes the terminating NUL, hence the -2.
      const name =
        nameLength > 2 ? raw.subarray(offset, offset + Math.min(nameLength - 2, 64)).toString('utf16le') : ''
      const type = raw.readUInt8(offset + 0x42)
      if (type !== 1 && type !== 2 && type !== 5) {
        // Unallocated. Kept as a placeholder so directory ids still index correctly.
        entries.push({ name: '', type: 0, size: 0, startSector: FREE_SECTOR, children: [] })
        siblings.push({ left: FREE_SECTOR, right: FREE_SECTOR, child: FREE_SECTOR })
        continue
      }
      entries.push({
        name,
        type,
        // Read as two 32-bit halves: a `.msg` never approaches 4GB, and `readBigUInt64LE` would
        // hand every caller a bigint to convert.
        size: raw.readUInt32LE(offset + 0x78) + raw.readUInt32LE(offset + 0x7c) * 0x1_0000_0000,
        startSector: raw.readUInt32LE(offset + 0x74),
        children: [],
      })
      siblings.push({
        left: raw.readUInt32LE(offset + 0x44),
        right: raw.readUInt32LE(offset + 0x48),
        child: raw.readUInt32LE(offset + 0x4c),
      })
    }

    /*
     * The directory is a red-black tree per storage, and it is *walked* rather than searched.
     * Walking needs no understanding of the colouring or the ordering - both of which real files
     * get subtly wrong often enough that libraries carry workarounds - and this only ever needs
     * "every child of this storage".
     */
    for (let id = 0; id < entries.length; id += 1) {
      const start = siblings[id]?.child ?? FREE_SECTOR
      if (start === FREE_SECTOR) continue
      const found: number[] = []
      const stack = [start]
      const seen = new Set<number>()
      while (stack.length > 0) {
        const current = stack.pop() as number
        if (current === FREE_SECTOR || seen.has(current) || entries[current] === undefined) continue
        seen.add(current)
        found.push(current)
        const node = siblings[current]
        if (node !== undefined) stack.push(node.left, node.right)
      }
      ;(entries[id] as CompoundEntry).children = found
    }

    return entries
  }

  private requireSector(offset: number): void {
    if (offset < 0 || offset + this.sectorSize > this.buffer.length) {
      throw new CompoundFileError('a sector points past the end of the file')
    }
  }

  private readChain(start: number, size: number, fat: number[], sectorSize: number): Buffer {
    const parts: Buffer[] = []
    let sector = start
    let remaining = size
    let guard = 0
    while (sector !== END_OF_CHAIN && sector !== FREE_SECTOR && remaining > 0) {
      if (guard++ > 10_000_000) throw new CompoundFileError('a sector chain does not terminate')
      if (sector === FAT_SECTOR || sector === DIFAT_SECTOR) break
      const offset = this.sectorOffset(sector)
      this.requireSector(offset)
      const take = Math.min(sectorSize, remaining)
      parts.push(this.buffer.subarray(offset, offset + take))
      remaining -= take
      sector = fat[sector] ?? END_OF_CHAIN
    }
    return Buffer.concat(parts)
  }

  /** The same walk, over the mini stream rather than the file. */
  private readChainFrom(
    source: Buffer,
    start: number,
    size: number,
    fat: number[],
    sectorSize: number,
  ): Buffer {
    const parts: Buffer[] = []
    let sector = start
    let remaining = size
    let guard = 0
    while (sector !== END_OF_CHAIN && sector !== FREE_SECTOR && remaining > 0) {
      if (guard++ > 10_000_000) throw new CompoundFileError('a mini sector chain does not terminate')
      const offset = sector * sectorSize
      if (offset < 0 || offset >= source.length) {
        throw new CompoundFileError('a mini sector points past the end of the mini stream')
      }
      const take = Math.min(sectorSize, remaining, source.length - offset)
      parts.push(source.subarray(offset, offset + take))
      remaining -= take
      sector = fat[sector] ?? END_OF_CHAIN
    }
    return Buffer.concat(parts)
  }
}
