import { z } from 'zod'

/**
 * A codebase that is folders on a JupyterHub server: where the hub is, whose server, which folders,
 * and where the access token is kept.
 *
 * Written by Fire Code and handed to the host with `--jupyter-hub <file>`, never read from a
 * workspace config: it names a host and a credential, invariant 5's threat exactly. The token itself
 * is a secret-store slot (`tokenRef`), never a literal.
 */
export const jupyterHubSpecSchema = z.object({
  /** The hub's address, e.g. `https://<your hub>` (a path prefix such as `/jupyter` is kept). */
  url: z.string().url(),
  /** The hub user whose server holds the folders. */
  user: z.string().min(1),
  /** A named server (`/user/<name>/<server>/`); absent for the default one. */
  server: z.string().min(1).optional(),
  /** Folders on that server, relative to its root; `''` is the root itself. */
  folders: z.array(z.string()).min(1),
  /** Secret-store key holding the API token. */
  tokenRef: z.string().min(1),
  /** Kernel to run code in (a kernelspec name such as `python3`); absent means the server's default. */
  kernel: z.string().min(1).optional(),
  /** Minutes between automatic fetches of what changed on the hub. */
  syncMinutes: z.number().min(1).max(1440).optional(),
  /** Files larger than this are listed but not copied. */
  maxFileMB: z.number().min(1).max(500).optional(),
  caFile: z.string().optional(),
  rejectUnauthorized: z.boolean().optional(),
})

export type JupyterHubSpec = z.infer<typeof jupyterHubSpecSchema>

/** Reads a spec file's text, with an error that names what is wrong rather than a zod dump. */
export function parseJupyterHubSpec(text: string): JupyterHubSpec {
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    throw new Error('The JupyterHub settings file is not valid JSON.')
  }
  const parsed = jupyterHubSpecSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`The JupyterHub settings are incomplete: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim())
  }
  const folders = parsed.data.folders.map(cleanRemote)
  const overlap = overlappingFolders(folders)
  if (overlap !== undefined) throw new Error(overlap)
  return { ...parsed.data, folders }
}

/**
 * Folders that contain one another would be copied twice - two local files for one hub file, and
 * an edit to one is overwritten by the other's next save. Refused with the reason.
 */
export function overlappingFolders(folders: readonly string[]): string | undefined {
  for (const a of folders) {
    for (const b of folders) {
      if (a === b && folders.indexOf(a) !== folders.lastIndexOf(a)) return `"${a || '(top folder)'}" is listed twice.`
      if (a !== b && (a === '' || b.startsWith(`${a}/`))) {
        return `"${b}" is inside "${a || '(top folder)'}", so its files would be copied twice. List only one of them.`
      }
    }
  }
  return undefined
}

/** `/a/b/` and `a\\b` both mean `a/b`; `''` is the root. `..` is refused rather than resolved. */
export function cleanRemote(folder: string): string {
  const parts = folder.replace(/\\/g, '/').split('/').filter((p) => p.length > 0 && p !== '.')
  if (parts.includes('..')) throw new Error(`"${folder}" climbs out of the server's folders.`)
  return parts.join('/')
}

/** `https://hub/user/alice/` (or `.../alice/<server>/`), the base every server API call hangs off. */
export function serverBase(spec: JupyterHubSpec): string {
  const hub = spec.url.replace(/\/+$/, '')
  const server = spec.server !== undefined ? `${encodeURIComponent(spec.server)}/` : ''
  return `${hub}/user/${encodeURIComponent(spec.user)}/${server}`
}

/**
 * The local folder name each remote folder is copied into: its last part, made unique. The root is
 * `home`. Stable for a given list, so the mapping survives restarts.
 */
export function localFolderNames(folders: readonly string[]): string[] {
  const taken = new Set<string>()
  return folders.map((folder) => {
    const base = (folder.split('/').pop() ?? '').replace(/[<>:"|?*]/g, '-') || 'home'
    let name = base
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}-${String(n)}`
    taken.add(name.toLowerCase())
    return name
  })
}
