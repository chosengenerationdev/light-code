import type { LightCodeConfig, UsageStoreConfig } from '../config/schema.js'

/**
 * Which store usage goes to when nobody chose one - so collection starts by itself wherever the team
 * already shares something (asked for: "automatic if required config is available", OpenSearch first,
 * then any vector store).
 *
 * The order, and why:
 * 1. **OpenSearch** - the store a team shares by design (aliases, team skills); a cluster, not a laptop.
 *    The active store if it is OpenSearch, else the first OpenSearch configured.
 * 2. **Any other vector store** - the active one first.
 * 3. **An S3 bucket the team already writes to** - a connection a skills or tools folder publishes to,
 *    then one any shared folder syncs from, never a read-only one.
 *
 * A plain folder is never guessed: a skills folder somebody reads from is not a place to write
 * everybody's usage, and there is no other folder that means "the team's". `usage.store` always wins,
 * and `usage.enabled: false` stops collection whatever is available.
 */
export interface UsageStoreChoice {
  store: UsageStoreConfig
  automatic: boolean
  /** In words, for the panel: why this store. */
  reason: string
}

export function chooseUsageStore(
  config: LightCodeConfig,
  s3: readonly { id: string; label: string; readOnly?: boolean | undefined }[],
): UsageStoreChoice | undefined {
  if (config.usage?.store !== undefined) return { store: config.usage.store, automatic: false, reason: 'chosen in Settings → Usage' }

  const stores = Object.entries(config.vectorStores ?? {})
  const active = config.activeVectorStoreId
  const activeEntry = stores.find(([id]) => id === active)
  const opensearch =
    activeEntry !== undefined && activeEntry[1].kind === 'opensearch' ? activeEntry : stores.find(([, store]) => store.kind === 'opensearch')
  if (opensearch !== undefined) {
    return { store: { kind: 'vector', storeId: opensearch[0] }, automatic: true, reason: `the OpenSearch connection "${opensearch[1].label}" is configured` }
  }
  const anyVector = activeEntry ?? stores[0]
  if (anyVector !== undefined) {
    return { store: { kind: 'vector', storeId: anyVector[0] }, automatic: true, reason: `the ${anyVector[1].kind} connection "${anyVector[1].label}" is configured` }
  }

  const writable = new Map(s3.filter((target) => target.readOnly !== true).map((target) => [target.id, target]))
  const mirrors = [...(config.s3?.skills ?? []), ...(config.s3?.tools ?? [])].filter((mirror) => mirror.enabled === true)
  const bucket =
    mirrors.find((mirror) => mirror.publish === true && writable.has(mirror.connectionId)) ??
    mirrors.find((mirror) => writable.has(mirror.connectionId))
  if (bucket !== undefined) {
    const target = writable.get(bucket.connectionId)!
    return { store: { kind: 's3', connectionId: target.id }, automatic: true, reason: `the team bucket "${target.label}" is configured` }
  }
  return undefined
}

/** Whether usage is collected: a store is available and nobody switched collection off. */
export function usageCollectionOn(config: LightCodeConfig, choice: UsageStoreChoice | undefined): boolean {
  return choice !== undefined && config.usage?.enabled !== false
}
