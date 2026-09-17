/**
 * Keeping a key inside the prefix it is allowed to touch.
 *
 * This is `confine()`'s argument applied to a bucket instead of a disk. A connection names a
 * prefix because a bucket usually holds far more than one project, and without enforcement the
 * boundary would be a comment — the model would be free to read `finance/` from a connection set
 * up for `reports/`, and the tool would happily succeed.
 *
 * Kept as its own module so the rule is written once and every tool goes through it. A second
 * copy of a containment check is the shape §16 warns about, where one call site quietly disagrees
 * with the others.
 */

export interface ConfinedKey {
  ok: true
  /** The full key to send to S3, prefix included. */
  key: string
}

export interface RefusedKey {
  ok: false
  message: string
}

/** Normalises a prefix to `folder/` form, or empty for "the whole bucket". */
export function normalisePrefix(prefix: string | undefined): string {
  const trimmed = (prefix ?? '').trim().replace(/^\/+/, '')
  if (trimmed === '') return ''
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

/**
 * Resolves a key the model asked for against the connection's prefix.
 *
 * `..` is refused rather than resolved. S3 has no directories and no parent — `a/../b` is a
 * literal key — so a path that *looks* like an escape is either a mistake or an attempt, and
 * neither is worth guessing at. Refusing says which.
 */
export function confineKey(requested: string, prefix: string | undefined): ConfinedKey | RefusedKey {
  const clean = requested.trim().replace(/^\/+/, '')
  if (clean === '') return { ok: false, message: 'No key was given.' }

  if (clean.split('/').includes('..')) {
    return {
      ok: false,
      message:
        `"${requested}" contains "..", which S3 does not interpret as a parent folder — it would ` +
        'be part of the key. Give the key as it appears in the bucket.',
    }
  }

  const base = normalisePrefix(prefix)
  if (base === '') return { ok: true, key: clean }

  // Accepted written either way: with the prefix, as a listing shows it, or relative to it.
  const key = clean.startsWith(base) ? clean : `${base}${clean}`
  if (!key.startsWith(base)) {
    return { ok: false, message: `"${requested}" is outside "${base}", which this connection is limited to.` }
  }
  return { ok: true, key }
}

/** What to show a person: the key without the prefix they already know about. */
export function displayKey(key: string, prefix: string | undefined): string {
  const base = normalisePrefix(prefix)
  return base !== '' && key.startsWith(base) ? key.slice(base.length) : key
}
