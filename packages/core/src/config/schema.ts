import { z } from 'zod'
import { mcpServersSchema } from '../mcp/types.js'
import { schedulesSchema } from '../schedule/types.js'
import { providerProfileSchema, type TlsSettings, tlsSettingsSchema } from '../providers/types.js'

/**
 * The whole config file, one schema shared by the UI and the file loader (§15) so a
 * hand-edited file and a UI save fail identically.
 */

/**
 * Model-authored Python tools (§13).
 *
 * User-scope only (invariant 5): `uvPath`, `toolsDir` and `venvPath` all name places a
 * program is found or run from, so a workspace able to set them would execute code of its
 * choosing the moment the panel opened.
 */
export const pythonConfigSchema = z
  .object({
    /**
     * Off by default and explicitly three-state. This is the sharpest surface in the
     * product — it makes the *body* of a tool model-authored, not just the call — so the
     * feature does not exist until someone turns it on.
     */
    dynamicTools: z.enum(['off', 'on']),
    uvPath: z.string(),
    /**
     * Defaults to `.lightcode/tools/` **inside the workspace**, deliberately. Changes then
     * land in git and get code-reviewed, which is the main real mitigation available (§13).
     */
    toolsDir: z.string(),
    /**
     * Overrides environment selection. Left unset, the workspace's own `.venv` is preferred
     * — that is where a project's internal libraries already live — and a private one under
     * user storage is the fallback.
     */
    venvPath: z.string(),
    /**
     * Package index for tool dependencies. §3 treats `uv` resolving PyPI as *our* egress
     * rather than the user's, so pointing it at an internal mirror is the expected
     * corporate configuration, not an edge case.
     */
    indexUrl: z.string(),
    extraIndexUrls: z.array(z.string()),
    /** Refuses the network entirely; only already-cached packages resolve. */
    offline: z.boolean(),
    /** Per-call budget in seconds. A tool that hangs must not hang the turn. */
    timeoutSeconds: z.number().int().min(1).max(600),
  })
  .partial()

export const autoApproveSchema = z
  .object({
    read: z.boolean(),
    edit: z.boolean(),
    command: z.boolean(),
    mcp: z.boolean(),
  })
  .partial()

export const workspaceApprovalsSchema = z
  .object({
    autoApprove: autoApproveSchema,
    allowedTools: z.array(z.string()),
    /** Exact command strings — never patterns. See approval/commands.ts and §8. */
    allowedCommands: z.array(z.string()),
  })
  .partial()

/**
 * Inferred from the schema rather than hand-written, so the validator and the type can
 * never drift apart — the same single-schema principle as §15.
 */
export type AutoApproveSettings = z.infer<typeof autoApproveSchema>
export type WorkspaceApprovals = z.infer<typeof workspaceApprovalsSchema>

/**
 * The Claude CLI as a consulting expert (`ask_expert`).
 *
 * User-scope only along with everything else on invariant 5's list — `path` names an
 * executable, and a workspace able to set it would run a program of its choosing the
 * moment the panel opened. Same threat as `python.uvPath`.
 */
export const expertConfigSchema = z
  .object({
    /** Off unless explicitly enabled. Nothing is spawned or spent without this. */
    enabled: z.boolean(),
    /** Defaults to `claude` on PATH. An absolute path works for a non-standard install. */
    path: z.string(),
    /** Overrides the model the CLI would otherwise choose. */
    model: z.string(),
    /**
     * Dollars the expert may cost within one task. 0 means no limit.
     *
     * Per task rather than per day: it matches the expert session's own scope, and a total
     * that never resets becomes a thing the user clears rather than a thing that protects them.
     */
    maxSpendUsd: z.number().min(0),
    /**
     * The expert's assessment of the junior model, and the answers it judged.
     *
     * Stored so it survives a restart and can be shown, and fed back to the expert on later
     * tasks so its plans are sized to what the junior can actually do. Keyed by nothing —
     * there is one, for the model that was assessed, and it records which that was so a stale
     * one is recognisable rather than silently applied to a different model.
     */
    assessment: z.object({
      model: z.string(),
      profileLabel: z.string(),
      assessedAt: z.number(),
      verdict: z.string(),
      costUsd: z.number().optional(),
      probes: z.array(
        z.object({
          id: z.string(),
          measures: z.string(),
          prompt: z.string(),
          answer: z.string(),
          error: z.string().optional(),
        }),
      ),
    }).optional(),
    /**
     * Consultations allowed within one task. 0 means no limit.
     *
     * The backstop for when the CLI reports no cost — a spend limit cannot count what it is
     * not told the price of, and an unpriced consultation still costs money.
     */
    maxConsultations: z.number().int().min(0),
    /**
     * Whether this plan reports a per-consultation cost.
     *
     * Learned rather than configured, and learned from real consultations rather than from a
     * probe — asking the CLI "do you report cost?" means making a call, and the first call in a
     * session is the expensive one. So it is recorded the first time a consultation comes back
     * with or without `total_cost_usd`.
     *
     * Absent means not yet known. It matters because a spend cap cannot bind on a plan that
     * reports no cost: `usd` stays zero, the limit is never reached, and the only control that
     * actually holds is the consultation count. A cap that silently never fires is worse than no
     * cap, because it is believed.
     */
    reportsCost: z.boolean(),
    /**
     * Refresh the expert's cache while a task is open, rather than paying a cold start later.
     *
     * The cache is one hour and that TTL is Anthropic's, not ours. A trivial resumed consultation
     * before it lapses costs about a fiftieth of the cold start it avoids.
     *
     * Off by default, and it must stay that way: it spends with nobody at the screen, which is
     * the one property this product is careful about everywhere else. Its cost is counted in the
     * meter like anything else.
     */
    keepAlive: z.boolean(),
    /**
     * What a consultation costs on this plan, measured rather than assumed.
     *
     * The published figures came from one plan on one day. An enterprise agreement, a
     * subscription or a gateway can each report something different — and those numbers are what
     * the budget is set from and what the expert is told when it plans to fit.
     */
    pricing: z.object({
      coldUsd: z.number().min(0).optional(),
      resumedUsd: z.number().min(0).optional(),
      measuredAt: z.number(),
      reportsCost: z.boolean(),
      /** Whether the second sample genuinely resumed the first session. */
      resumeWorked: z.boolean().optional(),
    }),
  })
  .partial()

/**
 * One OpenSearch cluster. A named list rather than a singleton because different
 * environments run different clusters — the same reasoning as provider profiles.
 */
/**
 * The backends a store may name.
 *
 * A single-member enum rather than a `z.literal`, because it is the one place a new backend
 * is declared: adding Qdrant means adding a string here and an adapter in
 * `rag/vectorStoreFactory.ts`, and the type error list is the to-do list. Kept to backends
 * that actually work — a config naming one that does not would fail at use, far from the
 * setting that caused it.
 */
export const vectorStoreKindSchema = z.enum(['opensearch', 'qdrant', 'chroma'])
export type VectorStoreKind = z.infer<typeof vectorStoreKindSchema>

export const vectorStoreSchema = z.object({
  /**
   * Which backend this connection speaks.
   *
   * OpenSearch is the corporate case — an existing cluster, mutual TLS, credentials. Qdrant and
   * Chroma are the local case: a container on `localhost` with no auth, for someone who wants
   * semantic search without sending their code anywhere. The interface is the same either way;
   * only the adapter differs.
   */
  kind: vectorStoreKindSchema,
  label: z.string().min(1),
  /** User-supplied. No default endpoint exists anywhere (invariant 3). */
  url: z.string().min(1).url('Must be a valid URL'),
  /** SecretStorage references, never literals (§15). */
  usernameRef: z.string().optional(),
  passwordRef: z.string().optional(),
  /** Used when the model names no index. */
  defaultIndex: z.string().optional(),
  /**
   * Per-cluster TLS, layered over the global block. Usually empty: a corporate cluster sits
   * behind the same intercepting proxy the gateway does, so the global CA already covers it.
   */
  tls: tlsSettingsSchema.optional(),
  /**
   * Superseded by `tls.caFile` / `tls.rejectUnauthorized`. Still read so configs written
   * before the global block keep working; the loader folds them into `tls`.
   */
  caFile: z.string().optional(),
  rejectUnauthorized: z.boolean().optional(),
  /**
   * Guard rails for queries the model writes.
   *
   * These exist because the cluster is production and the query author is a language
   * model. It cannot delete anything — the client has no write path — but a *read* can
   * still hurt: a wildcard across every index, an unbounded scan of years of logs, or a
   * hit count that forces a full traversal. Each default below is chosen to be safe on a
   * large cluster rather than maximally capable, and every one is raiseable by the user
   * who knows their own cluster.
   */
  limits: z
    .object({
      /** Documents returned. Hard-capped in the tool regardless of what the model asks. */
      maxHits: z.number().int().min(1).max(100),
      /** Per-shard time budget, sent as the query's own `timeout`. */
      timeoutSeconds: z.number().int().min(1).max(120),
      /** Stop examining documents per shard after this many. 0 disables. */
      terminateAfter: z.number().int().min(0),
      /** Refuse a wildcard pattern resolving to more indexes than this. 0 disables the check. */
      maxIndexes: z.number().int().min(0),
      /**
       * When the index has a date field and the model set no range, restrict to this many
       * hours. The single most effective protection for a log index, where the difference
       * between a day and three years is the difference between instant and an outage.
       * 0 disables, allowing unbounded scans.
       */
      defaultLookbackHours: z.number().int().min(0),
      /**
       * Longest single field value kept in a hit. Unlike the whole-result cap, this clip
       * cannot be undone with `read_tool_result` — the text never left the tool — so a log
       * index whose messages carry stack traces usually wants it raised.
       */
      maxFieldChars: z.number().int().min(50).max(20_000),
    })
    .partial()
    .optional(),
})
export type VectorStoreConfig = z.infer<typeof vectorStoreSchema>

/**
 * The cluster's TLS block, with the pre-global `caFile`/`rejectUnauthorized` fields folded
 * in. Existing configs keep working without a migration step, and callers only ever see one
 * shape — the alternative is every call site remembering to check both.
 */
export function vectorStoreTls(store: VectorStoreConfig): TlsSettings | undefined {
  const merged: TlsSettings = {
    ...(store.caFile !== undefined ? { caFile: store.caFile } : {}),
    ...(store.rejectUnauthorized !== undefined ? { rejectUnauthorized: store.rejectUnauthorized } : {}),
    ...(store.tls ?? {}),
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

/**
 * Where skills are kept (§13).
 *
 * **User-scope only** (invariant 5), and the reason is the absolute paths. A workspace able to
 * set these would choose folders anywhere on the machine to read prose from *and* to write
 * model-authored prose into — and a skill is a persistent prompt-injection vector whose main
 * defence is that it lives in the repository and lands in code review. Pointing that
 * elsewhere is precisely what must stay the user's decision.
 *
 * Note this takes nothing away from a repository: `.lightcode/skills/` inside the workspace is
 * always read, so a project can still ship its own skills without configuring anything.
 */
export const skillsConfigSchema = z
  .object({
    /**
     * Where `write_skill` puts new skills, and the only folder skills can be deleted from.
     * Relative paths resolve against the workspace. Defaults to `.lightcode/skills`.
     */
    dir: z.string(),
    /**
     * Extra folders to read skills from — a shared team folder, a personal collection.
     * **Read-only:** nothing is ever written to these, so a folder shared between people
     * cannot be edited by one person's assistant on everyone else's behalf.
     */
    paths: z.array(z.string()),
  })
  .partial()
export type SkillsConfig = z.infer<typeof skillsConfigSchema>

/**
 * Keeping tool schemas out of the prompt, and finding them again on demand (§12).
 *
 * User-scope only (invariant 5) for the same reason as `embedder`: `docsIndex` names a
 * collection that the contents of your tool and skill documentation get written to, and a
 * workspace able to redirect it would choose where that goes.
 */
export const retrievalConfigSchema = z
  .object({
    /**
     * **On by default since 0.33.0**, at the user's request: looking a tool up first is the
     * behaviour they want, and a corporate install with several MCP servers is the case this
     * product is actually deployed into.
     *
     * The cost it trades against is real and unchanged — models are measurably better at
     * native tool-calling than at naming a tool inside `call_tool`. Two things keep that from
     * biting a small install: nothing is hidden unless there is something to hide (a workspace
     * with no MCP or Python tools registers no dispatcher tools at all, so it pays nothing),
     * and the switch is one click away in Settings → Search, which reports exactly how many
     * tools it is hiding.
     */
    dispatcher: z.boolean(),
    /**
     * The same treatment for skills: their names and descriptions leave the prompt and are
     * found with `search_docs` instead.
     *
     * On by default, and paired with `dispatcher` rather than independent of it in practice —
     * but a separate key because the trade is different. A tool's schema is large and its name
     * is guessable from the task; a skill's summary is one line and is the *only* thing that
     * makes the model aware the skill exists at all. So hiding skills saves less and risks
     * more, which is why a count and a standing instruction to search stay in the prompt even
     * when the list does not — see `renderSkillsHintForPrompt`.
     */
    skills: z.boolean(),
    /**
     * Where the documentation corpus is indexed. Absent means `search_docs` still works,
     * matching names and descriptions from the live registry instead of by meaning — see
     * `tools/searchDocs.ts` for why that fallback is load-bearing rather than a nicety.
     */
    docsIndex: z.string(),
  })
  .partial()
export type RetrievalConfig = z.infer<typeof retrievalConfigSchema>

/**
 * Whether tool schemas are kept out of the prompt.
 *
 * A function rather than a `.default()` on the schema because the stored config is
 * deliberately sparse: writing `dispatcher: true` into every config file on load would make
 * a later change of default invisible to everyone who had ever opened Settings.
 */
export function dispatcherEnabled(retrieval: RetrievalConfig | undefined): boolean {
  return retrieval?.dispatcher !== false
}

/** Whether skill summaries are kept out of the prompt and found with `search_docs` instead. */
export function skillRetrievalEnabled(retrieval: RetrievalConfig | undefined): boolean {
  // Tied to the dispatcher: `search_docs` is what finds a hidden skill, and it is only
  // registered when the dispatcher is on. Hiding skills without it would make every skill
  // permanently invisible — the same trap the lexical fallback exists to avoid for tools.
  return dispatcherEnabled(retrieval) && retrieval?.skills !== false
}

/**
 * Embeddings, borrowed from an existing provider profile.
 *
 * `profileId` rather than its own URL and credentials: the profile already carries a
 * working base URL, auth strategy, client certificate and CA. A gateway proven for chat is
 * proven for embeddings, and duplicating that configuration would mean two places to get
 * mutual TLS right instead of one.
 */
export const embedderConfigSchema = z
  .object({
    profileId: z.string().min(1),
    model: z.string().min(1),
    /** Required to create the `knn_vector` mapping — OpenSearch needs a fixed dimension. */
    dimensions: z.number().int().positive(),
    /**
     * The index this workspace is written to. Unset derives one from the workspace path,
     * which is collision-free but unreadable — and on a shared cluster the person looking at
     * the index list has no way to tell whose `light-code-a3f2…` it is.
     *
     * Also the escape hatch for a width change: a vector field's dimension is fixed at
     * creation, so switching embedding model means a new index, and naming it is how.
     */
    indexName: z.string().min(1),
    /**
     * Replaces `light-code` at the front of every derived index name, so a shared cluster can
     * tell one team's collections from another's at a glance.
     *
     * Applies to both corpora — the codebase index and the `-docs` one — because a prefix
     * that only covered half of them would be worse than none.
     *
     * Constrained more tightly than OpenSearch requires: no `*` or `+`, which are wildcard
     * characters. They are legal in a name and catastrophic in a *write target*, where a
     * pattern matching several indexes is not something to discover by accident.
     */
    indexPrefix: z
      .string()
      .regex(
        /^[a-z0-9][a-z0-9._-]{0,48}$/,
        'Start with a letter or digit, then lowercase letters, digits, dot, dash or underscore',
      ),
  })
  .partial()

/**
 * TLS material applied to **every** outbound connection: the gateway, OpenSearch, the
 * embedder, the Apigee token endpoint.
 *
 * An organisation typically has one intercepting root and one machine certificate, so
 * configuring them once is the point. A connection may still add its own CA (they
 * accumulate), supply a different client identity, or opt out of the global one — see
 * `platform/connectionTls.ts`, which owns the merge rules.
 */
export const globalTlsSchema = tlsSettingsSchema

export const configSchema = z
  .object({
    profiles: z.array(providerProfileSchema),
    /** User-scope only: a workspace able to add a trusted root could enable interception. */
    tls: globalTlsSchema,
    expert: expertConfigSchema,
    /**
     * User-scope only (invariant 5). A workspace able to name a cluster or repoint the
     * embedder would exfiltrate whatever gets indexed — sharper than the existing entries,
     * because the payload is source code.
     */
    vectorStores: z.record(z.string(), vectorStoreSchema),
    activeVectorStoreId: z.string(),
    embedder: embedderConfigSchema,
    retrieval: retrievalConfigSchema,
    skills: skillsConfigSchema,
    /**
     * Where tools may read outside the workspace.
     *
     * **User-scope only** (invariant 5). A repository able to add a root would grant itself
     * read access to anything on the machine the moment you opened it — which is the whole
     * point of confinement, so it must remain the user's decision.
     *
     * Reading only. Writing stays confined to the workspace whatever is listed here, because
     * checkpoints snapshot the workspace and an edit elsewhere would have no rollback.
     */
    filesystem: z
      .object({
        readRoots: z.array(z.string()),
      })
      .partial(),
    /**
     * Prompts that run unattended (§9b).
     *
     * **User-scope only** (invariant 5), and this is the sharpest entry on that list after
     * `python`. A schedule names tools that run with nobody watching, so a workspace able to
     * add one would execute tools of its choosing the moment the panel opened — the same
     * threat as `expert.path`, with a wider blast radius.
     */
    schedules: schedulesSchema,
    activeProfileId: z.string(),
    /**
     * The profile that writes Python tool source, when it should not be the chat model.
     *
     * A cheap model is fine at deciding a tool is needed and describing it, and much worse at
     * writing the file. Naming a profile here splits the two: the chat model sends a
     * specification and this one produces the source, which goes through the ordinary approval
     * prompt showing the real bytes.
     *
     * Absent means the chat model writes it, which is the behaviour every release so far has
     * had. User-scope only for the same reason as `profiles`: it names where inference goes.
     */
    programmingProfileId: z.string(),
    certDir: z.string(),
    python: pythonConfigSchema,
    /**
     * Keyed by workspace path. Per-workspace in *behaviour* (§8) but stored user-side and
     * user-scope-only (invariant 5) — a repo must not be able to ship its own
     * pre-approvals in `.lightcode/config.json`.
     */
    approvals: z.record(z.string(), workspaceApprovalsSchema),
    /** Active mode id; falls back to Code when absent or unrecognised. */
    modeId: z.string(),
    /**
     * Tool calls allowed in one turn before the loop stops (§5). The cap exists so a model
     * looping on a failing edit stops costing money, not to limit legitimate work — nothing
     * is lost when it trips, since sending another message resumes with the full transcript.
     */
    maxIterations: z.number().int().min(1).max(500),
    /**
     * Appearance. Cosmetic only, and deliberately **not** on invariant 5's user-scope-only
     * list: the worst a hostile workspace achieves by setting it is an ugly panel, which is
     * not a threat, and a project wanting its own accent is a reasonable thing to commit.
     *
     * Validated as a hex colour rather than accepted as any string. It is written into a CSS
     * custom property, and while `setProperty` will simply reject a malformed value, letting
     * arbitrary text reach a stylesheet is not a habit worth forming.
     */
    ui: z
      .object({
        accentColor: z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Must be a hex colour like #22C55E'),
        /**
         * Marks text that came from the Claude CLI expert (§12b) rather than from the
         * primary model. Separate from the accent because one colour cannot mean both
         * "this is Light Code" and "this is not"; configurable because the default sits
         * close to an amber or rose accent, and only the user can see whether their
         * particular pair reads as two colours or one.
         */
        expertColor: z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Must be a hex colour like #D97757'),
      })
      .partial(),
    /**
     * Standard `mcpServers` shape so configs paste in from other clients unmodified (§11).
     * Global and workspace scopes both allowed — workspace wins — because an MCP server
     * is often project-specific. Note this is *deliberately not* on invariant 5's list:
     * unlike approvals, adding a server does not bypass approval, since every MCP tool
     * call is gated exactly like any other tool.
     */
    mcpServers: mcpServersSchema,
  })
  .partial()

export type LightCodeConfig = z.infer<typeof configSchema>

export class ConfigValidationError extends Error {
  constructor(
    message: string,
    readonly issues: z.core.$ZodIssue[],
  ) {
    super(message)
    this.name = 'ConfigValidationError'
  }
}

/** Parses and validates raw JSON text. `undefined` input (no file yet) yields `{}`. */
export function parseConfig(raw: string | undefined): LightCodeConfig {
  if (raw === undefined) return {}

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    throw new ConfigValidationError(
      `Config file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      [],
    )
  }

  const result = configSchema.safeParse(json)
  if (!result.success) {
    throw new ConfigValidationError(
      `Config file failed validation: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
      result.error.issues,
    )
  }
  return result.data
}
