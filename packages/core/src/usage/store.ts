import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { S3Client } from '../s3/client.js'
import { normalisePrefix } from '../s3/keys.js'
import type { VectorIndexWriter } from '../rag/vectorStore.js'
import { isUsageEvent, parseUsageLines, writeFileAtomically, type UsageEvent } from './events.js'

/**
 * Where a team's usage is kept: one **shard** per person, per day, per install, plus one **profile**
 * per person.
 *
 * Every backend reduces to "put a named text, list names, read texts" - which a shared folder, an S3
 * bucket and all three vector stores can each do - so one shape covers them and the dashboard never
 * learns which is in use. A shard is rewritten whole with that day's events, which makes a push
 * idempotent: sending the same day twice changes nothing, and two pushes racing write the same text.
 *
 * Per install as well as per person, because one person runs several windows (and Fire Code one
 * host per chat), each with its own local queue; keyed by person and day alone, they would overwrite
 * each other's shard and the dashboard would undercount that person every day.
 *
 * **Nothing here deletes.** A shared store holds colleagues' records too, and the S3 client's one
 * destructive call stays with `s3/remove.ts`, where a person presses a button. Old shards are simply
 * outside the range anybody asks for.
 */
export interface UsageShard {
  user: string
  /** `YYYY-MM-DD`, UTC. */
  day: string
  instance: string
}

/**
 * Who a user name is, for a dashboard people can read: "Ann Example, Rates" rather than "aex1234".
 * Filled from a user-info tool the agent called (see `usage/profileTool.ts`); every field optional.
 */
export interface UsageProfile {
  displayName?: string
  email?: string
  team?: string
  department?: string
  title?: string
  location?: string
  /** Which tool it came from. */
  source?: string
  /** ISO time it was recorded. */
  updated?: string
}

export const PROFILE_FIELDS = ['displayName', 'email', 'team', 'department', 'title', 'location', 'source', 'updated'] as const

/** Only the known fields, as short strings - a profile is read by every colleague. */
export function cleanProfile(value: unknown): UsageProfile {
  const profile: UsageProfile = {}
  if (value === null || typeof value !== 'object') return profile
  for (const field of PROFILE_FIELDS) {
    const raw = (value as Record<string, unknown>)[field]
    if (typeof raw === 'string' && raw.trim().length > 0) profile[field] = raw.trim().slice(0, 200)
  }
  return profile
}

/** One person's month on one install, after roll-up: `YYYY-MM__<install>.jsonl`. */
export interface MonthShard {
  user: string
  /** `YYYY-MM`. */
  month: string
  instance: string
}

/** A shard as listed: a day or, once rolled up, a month. */
export interface ListedShard {
  user: string
  day?: string
  month?: string
  instance: string
}

export interface UsageShardStore {
  /** Said in the dashboard, so nobody has to guess where the numbers came from. */
  readonly label: string
  put(shard: UsageShard, events: readonly UsageEvent[]): Promise<void>
  /**
   * Every event in shards covering `[fromDay, toDay]`, inclusive: day shards in range and month shards
   * overlapping it (whose events outside the range are returned too - callers filter by time). **Where a
   * month shard exists, that person's and install's day shards of the month are skipped**: they are the
   * leftovers of a roll-up between writing the month and deleting the days, and counting both would count
   * every event twice.
   */
  read(fromDay: string, toDay: string): Promise<UsageEvent[]>
  /** The monthly roll-up (`usage/rollup.ts`). Only ever called for this install's own shards. */
  listOwn(instance: string): Promise<ListedShard[]>
  readShard(shard: ListedShard): Promise<UsageEvent[] | undefined>
  putMonth(shard: MonthShard, events: readonly UsageEvent[]): Promise<void>
  /** Deletes one of this install's own shards - the roll-up's day shards, once the month is verified. */
  removeShard(shard: ListedShard): Promise<void>
  /** One person's details, as a user-info tool gave them. Replaces what was there. */
  putProfile(user: string, profile: UsageProfile): Promise<void>
  /** Everybody's details, by user name as it appears in events. */
  readProfiles(): Promise<Record<string, UsageProfile>>
  /** Files the last read could not use, with the reason - shown, never swallowed. */
  readonly lastProblems?: readonly string[]
}

/** Runs one `fire-fs` request; supplied when Fire Code's helper is present. */
export type UsageHelper = (request: object) => Promise<Record<string, unknown>>

/** A user name as a path segment - never a separator, never `..`. */
export function shardSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._@-]/g, '_').replace(/^\.+/, '_')
  return cleaned.length > 0 ? cleaned.slice(0, 80) : '_'
}

/** `YYYY-MM-DD__instance.jsonl`, parsed back; undefined for any other file. */
export function parseShardName(name: string): { day: string; instance: string } | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})__([A-Za-z0-9]+)\.jsonl$/.exec(name)
  return match === null ? undefined : { day: match[1]!, instance: match[2]! }
}

/** `YYYY-MM__instance.jsonl`, a rolled-up month; undefined for any other file. */
export function parseMonthName(name: string): { month: string; instance: string } | undefined {
  const match = /^(\d{4}-\d{2})__([A-Za-z0-9]+)\.jsonl$/.exec(name)
  return match === null ? undefined : { month: match[1]!, instance: match[2]! }
}

/** A shard's file name: the day's, or the month's. */
export function shardFileName(shard: ListedShard): string {
  return `${shard.day ?? shard.month ?? ''}__${shard.instance}.jsonl`
}

/**
 * Which of a store's files a read covers, applying the roll-up rule: month files overlapping the range,
 * day files in it - except days of a month that person and install have rolled up.
 * Each entry is `{ user, name }` as it sits in the store.
 */
export function selectShards<T extends { user: string; name: string }>(files: readonly T[], fromDay: string, toDay: string): T[] {
  const rolled = new Set<string>()
  for (const file of files) {
    const month = parseMonthName(file.name)
    if (month !== undefined) rolled.add(`${file.user}|${month.month}|${month.instance}`)
  }
  return files.filter((file) => {
    const month = parseMonthName(file.name)
    if (month !== undefined) return month.month >= fromDay.slice(0, 7) && month.month <= toDay.slice(0, 7)
    const day = parseShardName(file.name)
    if (day === undefined || day.day < fromDay || day.day > toDay) return false
    return !rolled.has(`${file.user}|${day.day.slice(0, 7)}|${day.instance}`)
  })
}

/** This install's shards among a store's files. */
function ownShards(files: readonly { user: string; name: string }[], instance: string): ListedShard[] {
  const own: ListedShard[] = []
  for (const file of files) {
    const day = parseShardName(file.name)
    if (day !== undefined && day.instance === instance) own.push({ user: file.user, day: day.day, instance })
    const month = parseMonthName(file.name)
    if (month !== undefined && month.instance === instance) own.push({ user: file.user, month: month.month, instance })
  }
  return own
}

function shardText(events: readonly UsageEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n') + '\n'
}

/** Runs `work` over `items` a few at a time - a year of shards for a team is thousands of reads. */
async function pooled<T, R>(items: readonly T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        results[index] = await work(items[index]!)
      }
    }),
  )
  return results
}

/**
 * A folder every member can reach - a network share, a synced drive.
 * `<root>/<user>/<day>__<instance>.jsonl`, profiles in `<root>/_profiles/<user>.json`.
 *
 * Through Fire Code's Rust helper when it is installed (`usage_store.rs`): thousands of small files on
 * a share read in parallel, every unreadable one named with the reason. Plain Node otherwise, with the
 * same layout, so a team mixing the two reads one store.
 */
export class FolderShardStore implements UsageShardStore {
  readonly label: string
  lastProblems: string[] = []
  private profilesFromRead: Record<string, UsageProfile> | undefined

  constructor(
    private readonly root: string,
    private readonly helper?: UsageHelper,
  ) {
    this.label = `the shared folder ${root}`
  }

  private async ask(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const answer = await this.helper!({ op: 'usage', root: this.root, ...request })
    if (answer['ok'] !== true) throw new Error(typeof answer['error'] === 'string' ? answer['error'] : 'The file helper refused the request.')
    return answer
  }

  /**
   * Temp-and-rename, so a colleague reading mid-write sees the old day or the new one, never half. The
   * temporary name is random: one named after the process collided when one session wrote a day twice.
   */
  private async writeAtomically(target: string, text: string): Promise<void> {
    await writeFileAtomically(target, text)
  }

  async put(shard: UsageShard, events: readonly UsageEvent[]): Promise<void> {
    if (this.helper !== undefined) {
      await this.ask({ action: 'write', user: shardSegment(shard.user), day: shard.day, instance: shard.instance, events })
      return
    }
    await this.writeAtomically(path.join(this.root, shardSegment(shard.user), `${shard.day}__${shard.instance}.jsonl`), shardText(events))
  }

  async read(fromDay: string, toDay: string): Promise<UsageEvent[]> {
    this.lastProblems = []
    if (this.helper !== undefined) {
      const answer = await this.ask({ action: 'read', fromDay, toDay })
      this.lastProblems = (Array.isArray(answer['unreadable']) ? answer['unreadable'] : []).map((entry: unknown) => {
        const problem = entry as { path?: unknown; error?: unknown }
        return `${String(problem.path)}: ${String(problem.error)}`
      })
      this.profilesFromRead = {}
      const profiles = answer['profiles']
      if (profiles !== null && typeof profiles === 'object') {
        for (const [user, value] of Object.entries(profiles as Record<string, unknown>)) this.profilesFromRead[user] = cleanProfile(value)
      }
      return (Array.isArray(answer['events']) ? (answer['events'] as unknown[]) : []).filter(isUsageEvent)
    }
    const files = await this.listFiles()
    const wanted = selectShards(files, fromDay, toDay)
    const texts = await pooled(wanted, 8, (file) =>
      fs.readFile(path.join(this.root, file.user, file.name), 'utf8').catch((error: unknown) => {
        this.lastProblems.push(`${path.join(this.root, file.user, file.name)}: ${error instanceof Error ? error.message : String(error)}`)
        return ''
      }),
    )
    return texts.flatMap(parseUsageLines)
  }

  /** Every shard file, as `{ user, name }` - the person's folder and the file in it. */
  private async listFiles(): Promise<{ user: string; name: string }[]> {
    let users: string[]
    try {
      users = (await fs.readdir(this.root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name !== '_profiles')
        .map((entry) => entry.name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const files: { user: string; name: string }[] = []
    for (const user of users) {
      const folder = path.join(this.root, user)
      let names: string[]
      try {
        names = await fs.readdir(folder)
      } catch (error) {
        names = []
        this.lastProblems.push(`${folder}: ${error instanceof Error ? error.message : String(error)}`)
      }
      for (const name of names) if (parseShardName(name) !== undefined || parseMonthName(name) !== undefined) files.push({ user, name })
    }
    return files
  }

  async listOwn(instance: string): Promise<ListedShard[]> {
    return ownShards(await this.listFiles(), instance)
  }

  async readShard(shard: ListedShard): Promise<UsageEvent[] | undefined> {
    try {
      return parseUsageLines(await fs.readFile(path.join(this.root, shardSegment(shard.user), shardFileName(shard)), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async putMonth(shard: MonthShard, events: readonly UsageEvent[]): Promise<void> {
    await this.writeAtomically(path.join(this.root, shardSegment(shard.user), shardFileName(shard)), shardText(events))
  }

  async removeShard(shard: ListedShard): Promise<void> {
    await fs.rm(path.join(this.root, shardSegment(shard.user), shardFileName(shard)), { force: true })
  }

  async putProfile(user: string, profile: UsageProfile): Promise<void> {
    this.profilesFromRead = undefined
    if (this.helper !== undefined) {
      await this.ask({ action: 'writeProfile', user: shardSegment(user), profile: cleanProfile(profile) })
      return
    }
    await this.writeAtomically(path.join(this.root, '_profiles', `${shardSegment(user)}.json`), JSON.stringify(cleanProfile(profile)))
  }

  async readProfiles(): Promise<Record<string, UsageProfile>> {
    if (this.profilesFromRead !== undefined) return this.profilesFromRead
    if (this.helper !== undefined) {
      // A range no shard can be in: the answer is the profiles alone.
      await this.read('9999-12-31', '9999-12-31')
      return this.profilesFromRead ?? {}
    }
    const folder = path.join(this.root, '_profiles')
    const profiles: Record<string, UsageProfile> = {}
    for (const name of await fs.readdir(folder).catch(() => [] as string[])) {
      if (!name.endsWith('.json')) continue
      try {
        profiles[name.slice(0, -5)] = cleanProfile(JSON.parse(await fs.readFile(path.join(folder, name), 'utf8')))
      } catch {
        // A half-written or hand-broken profile: the person shows by user name.
      }
    }
    return profiles
  }
}

/** `<connection prefix><prefix>usage/<user>/<day>__<instance>.jsonl` in a bucket the team shares. */
export class S3ShardStore implements UsageShardStore {
  readonly label: string
  private readonly base: string

  constructor(
    private readonly client: S3Client,
    bucket: string,
    prefix: string | undefined,
  ) {
    this.base = `${normalisePrefix(prefix)}usage/`
    this.label = `s3://${bucket}/${this.base}`
  }

  async put(shard: UsageShard, events: readonly UsageEvent[]): Promise<void> {
    const key = `${this.base}${shardSegment(shard.user)}/${shard.day}__${shard.instance}.jsonl`
    await this.client.put(key, Buffer.from(shardText(events), 'utf8'), 'application/x-ndjson')
  }

  /** Every shard object, as `{ user, name, key }`. */
  private async listFiles(): Promise<{ user: string; name: string; key: string }[]> {
    const objects = await this.client.list(this.base, 200_000)
    return objects
      .map((object) => {
        const rest = object.key.slice(this.base.length)
        const slash = rest.indexOf('/')
        return { user: rest.slice(0, slash), name: rest.slice(slash + 1), key: object.key }
      })
      .filter((file) => file.user.length > 0 && file.user !== '_profiles' && !file.name.includes('/'))
  }

  async read(fromDay: string, toDay: string): Promise<UsageEvent[]> {
    const wanted = selectShards(await this.listFiles(), fromDay, toDay)
    const texts = await pooled(wanted, 8, async (file) => (await this.client.get(file.key)).toString('utf8'))
    return texts.flatMap(parseUsageLines)
  }

  private keyOf(shard: ListedShard): string {
    return `${this.base}${shardSegment(shard.user)}/${shardFileName(shard)}`
  }

  async listOwn(instance: string): Promise<ListedShard[]> {
    return ownShards(await this.listFiles(), instance)
  }

  async readShard(shard: ListedShard): Promise<UsageEvent[] | undefined> {
    try {
      return parseUsageLines((await this.client.get(this.keyOf(shard))).toString('utf8'))
    } catch (error) {
      if (/\b404\b|NoSuchKey|not found/i.test(error instanceof Error ? error.message : String(error))) return undefined
      throw error
    }
  }

  async putMonth(shard: MonthShard, events: readonly UsageEvent[]): Promise<void> {
    await this.client.put(this.keyOf(shard), Buffer.from(shardText(events), 'utf8'), 'application/x-ndjson')
  }

  /**
   * The second caller of `S3Client.remove` (§13 kept it to `s3/remove.ts`): only this install's own usage
   * day shards, only after the month that replaces them was written and read back complete.
   */
  async removeShard(shard: ListedShard): Promise<void> {
    await this.client.remove(this.keyOf(shard))
  }

  async putProfile(user: string, profile: UsageProfile): Promise<void> {
    await this.client.put(`${this.base}_profiles/${shardSegment(user)}.json`, Buffer.from(JSON.stringify(cleanProfile(profile)), 'utf8'), 'application/json')
  }

  async readProfiles(): Promise<Record<string, UsageProfile>> {
    const objects = await this.client.list(`${this.base}_profiles/`, 10_000)
    const profiles: Record<string, UsageProfile> = {}
    await pooled(objects, 8, async (object) => {
      const name = object.key.slice(object.key.lastIndexOf('/') + 1)
      if (!name.endsWith('.json')) return
      try {
        profiles[name.slice(0, -5)] = cleanProfile(JSON.parse((await this.client.get(object.key)).toString('utf8')))
      } catch {
        // Shown by user name instead.
      }
    })
    return profiles
  }
}

/**
 * A collection in a configured OpenSearch, Qdrant or Chroma. A shard is one document whose text is
 * the day's events, with a token two-dimensional vector: every backend requires a vector, and none
 * is ever searched by one here.
 */
export class VectorShardStore implements UsageShardStore {
  readonly label: string
  private ensured = false

  constructor(
    private readonly writer: VectorIndexWriter,
    private readonly collection: string,
    storeLabel: string,
  ) {
    this.label = `${storeLabel} (collection ${collection})`
  }

  private async ensure(): Promise<void> {
    if (!this.ensured) {
      await this.writer.ensureCollection(this.collection, 2)
      this.ensured = true
    }
  }

  private async scanAll(visit: (document: { path: string; text: string }) => void): Promise<void> {
    let cursor: unknown
    // A safety cap, not pagination: a team-year is thousands of shards, not millions.
    for (let page = 0; page < 500; page++) {
      const result = await this.writer.scan(this.collection, { pageSize: 200, ...(cursor !== undefined ? { cursor } : {}) })
      for (const document of result.documents) visit(document)
      if (result.next === undefined) break
      cursor = result.next
    }
  }

  async put(shard: UsageShard, events: readonly UsageEvent[]): Promise<void> {
    await this.ensure()
    const user = shardSegment(shard.user)
    await this.writer.upsert(this.collection, [
      {
        id: `usage:${user}:${shard.day}:${shard.instance}`,
        text: shardText(events),
        path: `usage/${user}/${shard.day}__${shard.instance}.jsonl`,
        startLine: 0,
        endLine: 0,
        vector: [1, 0],
        owner: shard.user,
      },
    ])
  }

  /** Every shard document, as `{ user, name, text }` from its `usage/<user>/<name>` path. */
  private async listFiles(): Promise<{ user: string; name: string; text: string }[]> {
    const files: { user: string; name: string; text: string }[] = []
    await this.scanAll((document) => {
      const match = /^usage\/([^/]+)\/([^/]+)$/.exec(document.path)
      if (match === null || match[1] === '_profiles') return
      files.push({ user: match[1]!, name: match[2]!, text: document.text })
    })
    return files
  }

  async read(fromDay: string, toDay: string): Promise<UsageEvent[]> {
    return selectShards(await this.listFiles(), fromDay, toDay).flatMap((file) => parseUsageLines(file.text))
  }

  async listOwn(instance: string): Promise<ListedShard[]> {
    return ownShards(await this.listFiles(), instance)
  }

  async readShard(shard: ListedShard): Promise<UsageEvent[] | undefined> {
    const name = shardFileName(shard)
    const found = (await this.listFiles()).find((file) => file.user === shardSegment(shard.user) && file.name === name)
    return found === undefined ? undefined : parseUsageLines(found.text)
  }

  async putMonth(shard: MonthShard, events: readonly UsageEvent[]): Promise<void> {
    await this.ensure()
    const user = shardSegment(shard.user)
    await this.writer.upsert(this.collection, [
      { id: `usage-month:${user}:${shard.month}:${shard.instance}`, text: shardText(events), path: `usage/${user}/${shardFileName(shard)}`, startLine: 0, endLine: 0, vector: [1, 0], owner: shard.user },
    ])
  }

  async removeShard(shard: ListedShard): Promise<void> {
    await this.writer.deleteByPaths(this.collection, [`usage/${shardSegment(shard.user)}/${shardFileName(shard)}`])
  }

  async putProfile(user: string, profile: UsageProfile): Promise<void> {
    await this.ensure()
    const segment = shardSegment(user)
    await this.writer.upsert(this.collection, [
      { id: `usage-profile:${segment}`, text: JSON.stringify(cleanProfile(profile)), path: `usage/_profiles/${segment}.json`, startLine: 0, endLine: 0, vector: [1, 0], owner: user },
    ])
  }

  async readProfiles(): Promise<Record<string, UsageProfile>> {
    const profiles: Record<string, UsageProfile> = {}
    await this.scanAll((document) => {
      const match = /^usage\/_profiles\/(.+)\.json$/.exec(document.path)
      if (match === null) return
      try {
        profiles[match[1]!] = cleanProfile(JSON.parse(document.text))
      } catch {
        // Shown by user name instead.
      }
    })
    return profiles
  }
}
