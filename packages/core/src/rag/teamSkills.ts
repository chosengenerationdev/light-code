import type { Skill } from '../skills/index.js'
import type { Embedder } from './embedder.js'
import type { VectorDocument, VectorIndexWriter, VectorMatch, VectorSearcher } from './vectorStore.js'

/**
 * A shared corpus of skills, so a team can pool what each of them has taught the assistant.
 *
 * User-requested, and flagged as important: *"eventually i want to collect skills from all the
 * team members and maintain common skills storage, if user wants to create a new skill but it is
 * already exist in team skills, then user should be told about it, if user wants to modify it,
 * then he should be able to do it too."*
 *
 * ## Why skills get their own collection rather than sharing the documentation one
 *
 * Tool documentation and skills already live together in the `-docs` index, and for a single
 * user that is right — both are things `search_docs` looks through. Sharing changes the sums.
 * Tool documentation is a description of *this install's* registry: it is regenerated wholesale
 * on every change, it is meaningless on someone else's machine, and a stale sweep deletes
 * whatever the fresh corpus lacks. Pointing an alias at that and fanning it across a team would
 * mean one person's reindex racing another's deletions.
 *
 * Skills are the opposite: authored deliberately, changed rarely, and valuable precisely
 * because they came from somebody else. So they get a collection of their own, which is also
 * what makes it safe to point a team alias at it.
 *
 * ## The body is stored, unlike a codebase chunk
 *
 * A code hit is a pointer: the model reads the file afterwards. A teammate's skill has no file
 * on this machine to read, so the index has to be the whole answer or the feature does not work
 * at all. Skills are small — a page of prose — which is what makes that affordable.
 */

/** How a skill is identified in the corpus. Stable across machines, which is the point. */
export function teamSkillId(skill: { name: string }, owner: string | undefined): string {
  return `skill:${owner ?? 'unknown'}:${skill.name}`
}

/**
 * The searchable text for a skill.
 *
 * Name and description first because they carry the intent, then the body. A query like "how do
 * we call the pricing service" has to match the description of a skill called `pricing-api`
 * whose body never repeats the phrase.
 */
export function teamSkillText(skill: Skill, body: string): string {
  return [skill.name, skill.description, '', body].join('\n')
}

export function teamSkillDocument(
  skill: Skill,
  body: string,
  vector: number[],
  attribution: { owner?: string; project?: string },
): VectorDocument {
  const text = teamSkillText(skill, body)
  return {
    id: teamSkillId(skill, attribution.owner),
    text,
    // `path` is the corpus's identifier, not a file path — matching how tool documentation
    // already stores `tool:`/`skill:` ids there.
    path: `skill:${skill.name}`,
    startLine: 1,
    endLine: text.split('\n').length,
    ...(attribution.owner !== undefined ? { owner: attribution.owner } : {}),
    ...(attribution.project !== undefined ? { project: attribution.project } : {}),
    vector,
  }
}

export interface TeamSkillHit {
  name: string
  owner?: string
  project?: string
  text: string
  score: number
  /** True when this is the current machine's own copy. */
  isMine: boolean
}

function nameFromPath(path: string): string {
  return path.startsWith('skill:') ? path.slice('skill:'.length) : path
}

function toHit(match: VectorMatch, self: string | undefined): TeamSkillHit {
  return {
    name: nameFromPath(match.path),
    ...(match.owner !== undefined ? { owner: match.owner } : {}),
    ...(match.project !== undefined ? { project: match.project } : {}),
    text: match.text,
    score: match.score,
    isMine: match.owner !== undefined && self !== undefined && match.owner === self,
  }
}

export interface TeamSkillsOptions {
  searcher: VectorSearcher
  embedder: Embedder
  /** The alias across the team, or one person's collection when no alias is configured. */
  collection: string
  /** This machine's identity, so a hit can be told apart from one of somebody else's. */
  owner?: string
}

/**
 * Finds skills across the team by meaning.
 *
 * Deliberately **not** a `VectorIndexWriter` consumer: a searcher has no write method, which is
 * the same read/write split `VectorSearcher` exists to preserve.
 */
export async function searchTeamSkills(
  options: TeamSkillsOptions,
  query: string,
  size = 5,
  signal?: AbortSignal,
): Promise<TeamSkillHit[]> {
  const vector = await options.embedder.embed(query)
  const matches = await options.searcher.searchByVector(options.collection, vector, {
    size,
    ...(signal !== undefined ? { signal } : {}),
  })
  return matches.map((match) => toHit(match, options.owner))
}

/**
 * Whether anyone on the team already has a skill of this name.
 *
 * Matched on the **name**, not by similarity. "Does this already exist" is an exact question and
 * a semantic near-miss answering it would be worse than no answer at all: the user would be told
 * a colleague owns something they do not, and would either duplicate anyway or abandon a skill
 * that was never there.
 *
 * The embedding is still how the corpus is reached — there is no keyword path through the seam —
 * so this over-fetches on the name text and then filters exactly. Cheap, because the corpus is
 * skills rather than code.
 */
export async function findTeamSkillsNamed(
  options: TeamSkillsOptions,
  name: string,
  signal?: AbortSignal,
): Promise<TeamSkillHit[]> {
  const candidates = await searchTeamSkills(options, name, 25, signal)
  const wanted = name.trim().toLowerCase()
  return candidates.filter((hit) => hit.name.trim().toLowerCase() === wanted)
}

/**
 * What to tell someone about to write a skill that already exists elsewhere.
 *
 * Three cases, and they are genuinely different acts:
 *
 * - **Nobody has it.** Say nothing. A warning on every write teaches people to skip warnings.
 * - **Only you have it.** That is an ordinary edit of your own file, not a collision.
 * - **A colleague has it.** Say who, and give the choice explicitly rather than deciding: write
 *   your own version anyway, or read theirs first. The tool does not block — the user asked to
 *   be *told*, and a team where nobody may name a skill someone else already named would be
 *   worse than one with two `deployment` skills.
 */
export function describeTeamSkillCollision(
  name: string,
  hits: readonly TeamSkillHit[],
): string | undefined {
  const others = hits.filter((hit) => !hit.isMine)
  if (others.length === 0) return undefined

  const owners = [...new Set(others.map((hit) => hit.owner ?? 'someone unidentified'))]
  const who = owners.length === 1 ? owners[0] : `${owners.slice(0, -1).join(', ')} and ${owners.at(-1) ?? ''}`

  return [
    `A skill called "${name}" already exists in the team's shared skills, written by ${who ?? 'a colleague'}.`,
    'Tell the user before writing, and offer the choice rather than making it:',
    `- read the existing one first (search_team_skills with "${name}") and adapt it, or`,
    '- write your own version anyway, which is fine — yours is stored separately under your own',
    '  name and does not overwrite theirs.',
  ].join('\n')
}

/**
 * Renders hits for the model, marked as not being files on this machine.
 *
 * Same problem as a team code search and the same answer: a teammate's skill has no path here.
 * The difference is that the whole body *is* present, so instead of "do not open it" the
 * instruction is "this is all of it, and there is nothing to open".
 */
export function renderTeamSkillHits(hits: readonly TeamSkillHit[], query: string): string {
  if (hits.length === 0) {
    return (
      `No team skills match: ${query}\n` +
      'Either nobody has written one, or the shared skills index has not been built yet ' +
      '(Settings → Skills). This does not mean the subject is undocumented.'
    )
  }

  const rendered = hits
    .map((hit, position) => {
      const who = hit.isMine ? 'yours' : (hit.owner ?? 'unknown owner')
      const where = hit.project === undefined ? who : `${who} / ${hit.project}`
      return `[${position + 1}] ${hit.name}  (${where})\n${hit.text}`
    })
    .join('\n\n---\n\n')

  return [
    `${hits.length} team skill(s) matching: ${query}`,
    'Anything not marked "yours" is a colleague’s and has no file on this machine — the text',
    'above is the whole of it, so do not try to read_file it. To keep one, write your own copy',
    'with write_skill; that stores it under your name and leaves theirs alone.',
    '',
    rendered,
  ].join('\n')
}

/** Writes the team-visible copy of a skill. Only ever called from an indexing run. */
export async function indexTeamSkills(options: {
  writer: VectorIndexWriter
  embedder: Embedder
  collection: string
  alias?: string
  skills: readonly { skill: Skill; body: string }[]
  attribution: { owner?: string; project?: string }
  signal?: AbortSignal
}): Promise<number> {
  await options.writer.ensureCollection(options.collection, options.embedder.dimensions, options.signal)
  if (options.alias !== undefined && options.writer.ensureAlias !== undefined) {
    await options.writer.ensureAlias(options.collection, options.alias, options.signal)
  }
  if (options.skills.length === 0) return 0

  const documents: VectorDocument[] = []
  for (const entry of options.skills) {
    const vector = await options.embedder.embed(teamSkillText(entry.skill, entry.body))
    documents.push(teamSkillDocument(entry.skill, entry.body, vector, options.attribution))
  }
  await options.writer.upsert(options.collection, documents, options.signal)
  return documents.length
}
