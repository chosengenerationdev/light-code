import path from 'node:path'

/**
 * Pictures inside a skill.
 *
 * ## Why a description rather than an image embedding
 *
 * Asked directly: *"when it comes to embedding images for indexing? may be LLM can describe the
 * image and that description can be embedded accordingly?"* — and that is the right instinct, with
 * one simplification.
 *
 * A multimodal embedding would need a second embedder and a **second vector space**. §19 records
 * what happens when vectors from different models mix: confident, plausible, wrong neighbours,
 * with no error anywhere. It would need its own index, its own search path and its own way of
 * merging scores that are not comparable — a great deal of machinery for pictures in a page of
 * prose.
 *
 * Describing the image and embedding the description avoids all of it. But the cleanest version
 * does not build an embedding pipeline either: **the description belongs in the skill's own text.**
 * Written into the markdown beside the image, it is indexed by the machinery that already exists,
 * found by `search_docs` for free, and — the part that matters more — *read by whoever opens the
 * skill*, including a colleague whose copy has no image rendering at all.
 *
 * So there is no image index. There is a skill that says what its pictures show.
 *
 * ## What that costs, stated plainly
 *
 * A description is written once and the image can change under it. That is why the alt text is
 * required rather than generated: something must be true even when nobody refreshed it, and a
 * human-supplied caption is the part least likely to go stale. It is also why the description is
 * ordinary markdown rather than a hidden field — it is visible, so it can be corrected.
 */

/** Image types a skill may carry. Deliberately short: these render everywhere and are not fonts. */
export const SKILL_IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

/** The folder images live in, inside the skill's own folder. */
export const SKILL_IMAGE_DIR = 'images'

/** Bytes. A skill is a page of prose; a picture in one is an illustration, not an asset library. */
export const MAX_SKILL_IMAGE_BYTES = 2 * 1024 * 1024

export interface SkillImageInput {
  /** Where the picture is now, relative to the workspace. */
  source: string
  /** What it is called inside the skill. Defaults to the source's own file name. */
  name?: string | undefined
  /** Required. See the note above about what stays true when a description goes stale. */
  alt: string
  /** What the picture shows, in enough words to find it by. Indexed with the rest of the body. */
  description?: string | undefined
}

export interface StoredSkillImage {
  /** File name inside the skill's `images/` folder. */
  name: string
  alt: string
  description?: string
}

/** The media type for a file name, or undefined when it is not an image a skill may carry. */
export function skillImageType(fileName: string): string | undefined {
  return SKILL_IMAGE_TYPES[path.extname(fileName).toLowerCase()]
}

/**
 * The name a picture gets inside the skill.
 *
 * Reduced to one safe segment: the source is a path the model chose, and a name carrying a
 * separator would write outside the skill's own folder. Same rule as everywhere else here — a
 * containment check that is a comment is not a containment check.
 */
export function skillImageName(input: SkillImageInput): string {
  const proposed = path.basename(input.name ?? input.source)
  /*
   * The source decides the type when the proposed name has none.
   *
   * `path.extname('.png')` is empty — a leading dot is a dotfile, not an extension — so a name
   * like `.png` produced a file called `png` with no type at all, which the copy then refused as
   * "not an image". A source with no extension either is still refused, which is right.
   */
  const extension = (
    path.extname(proposed) === '' ? path.extname(input.source) : path.extname(proposed)
  ).toLowerCase()

  // Stripped by the *resolved* extension, not the proposed one, or `.png` leaves `png` behind
  // and the name comes out as `png.png`.
  const withoutExtension = proposed.toLowerCase().endsWith(extension) && extension !== ''
    ? proposed.slice(0, proposed.length - extension.length)
    : proposed

  const stem = withoutExtension
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return `${stem === '' ? 'image' : stem}${extension}`
}

/**
 * The markdown for one picture: the image, then what it shows.
 *
 * The description is a plain paragraph rather than a comment or an attribute, because that is what
 * makes it do three jobs at once — it is indexed, it is read by a person, and it is what a model
 * sees when the skill is loaded as text. A hidden field would only do the first.
 */
export function renderSkillImage(image: StoredSkillImage): string {
  const reference = `![${image.alt}](${SKILL_IMAGE_DIR}/${image.name})`
  return image.description === undefined || image.description.trim().length === 0
    ? reference
    : `${reference}\n\n${image.description.trim()}`
}

/**
 * Where the picture references go when the model did not place them itself.
 *
 * Appended under a heading rather than dropped at the top: a skill is prose, and a wall of images
 * before the first sentence buries what the skill is for. A model that wants them somewhere
 * specific writes the markdown itself, and then nothing is appended.
 */
export function appendSkillImages(body: string, images: readonly StoredSkillImage[]): string {
  const missing = images.filter((image) => !body.includes(`${SKILL_IMAGE_DIR}/${image.name}`))
  if (missing.length === 0) return body

  const trimmed = body.replace(/\s+$/, '')
  return [trimmed, '', '## Images', '', ...missing.map(renderSkillImage)].join('\n')
}

/**
 * The pictures a skill on disk actually has.
 *
 * Listed from the folder rather than parsed out of the markdown, because those two can disagree:
 * a reference can be edited to point at a file nobody added, and a file can be dropped in without
 * a reference. What is on disk is the fact; the markdown is a description of it.
 *
 * Returns names only. Reading every picture to list them would mean megabytes crossing the bridge
 * for a panel that is showing a row of file names, and most of them will never be opened.
 */
export async function listSkillImages(
  skillFilePath: string,
  fs: { readdir: (dir: string) => Promise<{ name: string; isDirectory: boolean }[]> },
): Promise<string[]> {
  // Only the folder layout has anywhere to keep them; a flat `name.md` has no images by definition.
  const asPosix = skillFilePath.split(String.fromCharCode(92)).join('/')
  if (!asPosix.toLowerCase().endsWith('/skill.md')) return []
  const dir = `${skillFilePath.slice(0, skillFilePath.length - 'SKILL.md'.length)}${SKILL_IMAGE_DIR}`

  try {
    const entries = await fs.readdir(dir)
    return entries
      .filter((entry) => !entry.isDirectory && skillImageType(entry.name) !== undefined)
      .map((entry) => entry.name)
      .sort()
  } catch {
    // No folder is the ordinary case for a skill with no pictures, not a failure worth reporting.
    return []
  }
}

/**
 * One picture, as something an `<img>` can show.
 *
 * A `data:` URI rather than a path or a served URL, because the webview's policy allows `data:`
 * and nothing else — the same route the diagrams take. It means the bytes cross the bridge, which
 * is why this is one picture on demand rather than all of them with the skill list.
 */
export function skillImageDataUri(name: string, bytes: Uint8Array): string | undefined {
  const type = skillImageType(name)
  if (type === undefined) return undefined
  return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`
}
