import type { HttpClient, HttpRequestOptions, HttpResponse, TlsOptions } from '../platform/http.js'
import { readBody } from '../platform/readBody.js'

/**
 * A thin Confluence Data Center / Server client over the one `HttpClient` (invariant 2).
 *
 * ## Why hand-written
 *
 * The same reason as the OpenSearch, Qdrant and S3 clients: every vendor SDK carries its own HTTP
 * stack, and invariant 2 sends all egress through core's. What is needed is small — search, read,
 * create, update, attach — and the REST API for it is plain JSON.
 *
 * ## Data Center, with a personal access token
 *
 * A PAT is sent as `Authorization: Bearer`, which is how Data Center and Server accept one (7.9
 * and later). Confluence *Cloud* uses an email and API token over basic auth instead; that is not
 * what was asked for and is not attempted here, rather than half-supported.
 *
 * ## Errors are for humans (§17)
 *
 * Confluence answers failures with a JSON body whose `message` is usually the whole explanation
 * ("Error parsing xhtml", "A page with this title already exists"). That message is passed through,
 * prefixed with what was being attempted and — for the statuses people actually hit — what to do.
 */

export interface ConfluenceConnection {
  /** Including any context path, e.g. `https://wiki.example.com/confluence`. No trailing slash needed. */
  baseUrl: string
  /** The personal access token. Held only for the life of a request, never logged. */
  token: string
  tls?: TlsOptions | undefined
}

export interface ConfluencePageSummary {
  id: string
  title: string
  spaceKey: string | undefined
  url: string
}

export interface ConfluencePage extends ConfluencePageSummary {
  version: number
  /** Storage-format XHTML, exactly as Confluence holds it. */
  body: string
  /** Titles of the pages above this one, outermost first. */
  ancestors: string[]
}

export class ConfluenceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'ConfluenceError'
  }
}

/** Filenames an attachment may have: what a person would type, and nothing that reaches a header. */
export function isSafeAttachmentName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,199}$/.test(name) && !name.includes('..')
}

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  json: 'application/json',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  zip: 'application/zip',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

export function contentTypeFor(filename: string): string {
  const extension = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()
  return CONTENT_TYPES[extension] ?? 'application/octet-stream'
}

export class ConfluenceClient {
  private readonly base: string

  constructor(
    private readonly http: HttpClient,
    private readonly connection: ConfluenceConnection,
  ) {
    this.base = connection.baseUrl.replace(/\/+$/, '')
  }

  /** Who the token belongs to — what Test connection reports. */
  async currentUser(signal?: AbortSignal): Promise<string> {
    const user = await this.json<{ displayName?: string; username?: string }>(
      'reading the current user',
      '/rest/api/user/current',
      { method: 'GET' },
      signal,
    )
    return user.displayName ?? user.username ?? 'an unnamed user'
  }

  /** Pages matching a CQL query. */
  async search(cql: string, limit: number, signal?: AbortSignal): Promise<ConfluencePageSummary[]> {
    const query = new URLSearchParams({ cql, limit: String(limit), expand: 'space' })
    const result = await this.json<{ results?: RawContent[] }>(
      'searching',
      `/rest/api/content/search?${query.toString()}`,
      { method: 'GET' },
      signal,
    )
    return (result.results ?? []).map((raw) => this.summary(raw))
  }

  async getPage(id: string, signal?: AbortSignal): Promise<ConfluencePage> {
    if (!/^\d+$/.test(id)) throw new ConfluenceError(`"${id}" is not a Confluence page id — those are numbers.`)
    const raw = await this.json<RawContent>(
      `reading page ${id}`,
      `/rest/api/content/${id}?expand=body.storage,version,space,ancestors`,
      { method: 'GET' },
      signal,
    )
    return this.page(raw)
  }

  /** A page by its exact title in a space, or undefined when there is none. */
  async findPage(spaceKey: string, title: string, signal?: AbortSignal): Promise<ConfluencePage | undefined> {
    const query = new URLSearchParams({
      spaceKey,
      title,
      expand: 'body.storage,version,space,ancestors',
    })
    const result = await this.json<{ results?: RawContent[] }>(
      `looking for "${title}" in ${spaceKey}`,
      `/rest/api/content?${query.toString()}`,
      { method: 'GET' },
      signal,
    )
    const first = result.results?.[0]
    return first === undefined ? undefined : this.page(first)
  }

  async createPage(
    page: { spaceKey: string; title: string; body: string; parentId?: string | undefined },
    signal?: AbortSignal,
  ): Promise<ConfluencePageSummary> {
    const raw = await this.json<RawContent>(
      `creating "${page.title}"`,
      '/rest/api/content',
      {
        method: 'POST',
        body: JSON.stringify({
          type: 'page',
          title: page.title,
          space: { key: page.spaceKey },
          ...(page.parentId !== undefined ? { ancestors: [{ id: page.parentId }] } : {}),
          body: { storage: { value: page.body, representation: 'storage' } },
        }),
      },
      signal,
    )
    return this.summary(raw)
  }

  /**
   * Replaces a page's body. `version` is the one that was *read*, so a page somebody edited in
   * between is refused by Confluence (409) rather than silently overwritten.
   */
  async updatePage(
    page: { id: string; title: string; body: string; version: number },
    signal?: AbortSignal,
  ): Promise<ConfluencePageSummary> {
    const raw = await this.json<RawContent>(
      `updating "${page.title}"`,
      `/rest/api/content/${page.id}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          id: page.id,
          type: 'page',
          title: page.title,
          version: { number: page.version + 1 },
          body: { storage: { value: page.body, representation: 'storage' } },
        }),
      },
      signal,
    )
    return this.summary(raw)
  }

  /**
   * Adds a file to a page, replacing one of the same name.
   *
   * `PUT` on the attachment collection creates or updates, so re-running a write that attaches
   * `architecture.svg` refreshes the picture instead of failing on a name that already exists.
   * Multipart is assembled here as bytes: a PNG round-tripped through a string is corrupted
   * without anything reporting it (see `HttpRequestOptions.bodyBytes`).
   */
  async attach(
    pageId: string,
    file: { name: string; bytes: Uint8Array; contentType?: string | undefined },
    signal?: AbortSignal,
  ): Promise<void> {
    if (!isSafeAttachmentName(file.name)) {
      throw new ConfluenceError(
        `"${file.name}" cannot be used as an attachment name: letters, digits, spaces, ".", "_", ` +
          '"-" and brackets only.',
      )
    }
    const boundary = `lightcode${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
    const head =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
      `Content-Type: ${file.contentType ?? contentTypeFor(file.name)}\r\n\r\n`
    const tail =
      `\r\n--${boundary}\r\n` +
      'Content-Disposition: form-data; name="minorEdit"\r\n\r\ntrue\r\n' +
      `--${boundary}--\r\n`
    const encoder = new TextEncoder()
    const headBytes = encoder.encode(head)
    const tailBytes = encoder.encode(tail)
    const bytes = new Uint8Array(headBytes.length + file.bytes.length + tailBytes.length)
    bytes.set(headBytes, 0)
    bytes.set(file.bytes, headBytes.length)
    bytes.set(tailBytes, headBytes.length + file.bytes.length)

    await this.send(
      `attaching ${file.name}`,
      `/rest/api/content/${pageId}/child/attachment`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          // Required by Confluence for any multipart write, or it refuses it as a possible CSRF.
          'X-Atlassian-Token': 'no-check',
        },
        bodyBytes: bytes,
      },
      signal,
    )
  }

  /** A page's attachments — what an image on it is called, which is what replacing one needs. */
  async listAttachments(pageId: string, signal?: AbortSignal): Promise<ConfluenceAttachment[]> {
    const result = await this.json<{ results?: RawAttachment[] }>(
      `listing the attachments of page ${pageId}`,
      `/rest/api/content/${pageId}/child/attachment?limit=100&expand=version`,
      { method: 'GET' },
      signal,
    )
    return (result.results ?? []).map((raw) => ({
      name: raw.title ?? '',
      mediaType: raw.metadata?.mediaType ?? contentTypeFor(raw.title ?? ''),
      size: raw.extensions?.fileSize ?? 0,
      download: raw._links?.download ?? '',
    }))
  }

  /**
   * An attachment's bytes, from the `download` link `listAttachments` returned.
   *
   * The link is joined to *this* site's base and nothing else: it came from the server, and a
   * download link that was a full URL somewhere else would otherwise send the token there.
   */
  async download(link: string, signal?: AbortSignal): Promise<Buffer> {
    if (!link.startsWith('/')) {
      throw new ConfluenceError(`Refused to download "${link}": it is not a link on ${this.base}.`)
    }
    const response = await this.send(`downloading ${link}`, link, { method: 'GET' }, signal)
    return readBody(response)
  }

  /** Where a relative `webui` link actually is. */
  url(webui: string | undefined): string {
    return webui === undefined ? this.base : `${this.base}${webui}`
  }

  private summary(raw: RawContent): ConfluencePageSummary {
    return {
      id: String(raw.id ?? ''),
      title: raw.title ?? '',
      spaceKey: raw.space?.key,
      url: this.url(raw._links?.webui),
    }
  }

  private page(raw: RawContent): ConfluencePage {
    return {
      ...this.summary(raw),
      version: raw.version?.number ?? 1,
      body: raw.body?.storage?.value ?? '',
      ancestors: (raw.ancestors ?? []).map((ancestor) => ancestor.title ?? ''),
    }
  }

  private async json<T>(
    doing: string,
    pathAndQuery: string,
    options: HttpRequestOptions,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.send(
      doing,
      pathAndQuery,
      { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) } },
      signal,
    )
    return (await response.json()) as T
  }

  private async send(
    doing: string,
    pathAndQuery: string,
    options: HttpRequestOptions,
    signal?: AbortSignal,
  ): Promise<HttpResponse> {
    let response: HttpResponse
    try {
      response = await this.http.request(`${this.base}${pathAndQuery}`, {
        ...options,
        headers: {
          Accept: 'application/json',
          ...(options.headers ?? {}),
          Authorization: `Bearer ${this.connection.token}`,
        },
        ...(signal !== undefined ? { signal } : {}),
        ...(this.connection.tls !== undefined ? { tls: this.connection.tls } : {}),
      })
    } catch (error) {
      throw new ConfluenceError(
        `Could not reach Confluence at ${this.base} while ${doing}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (response.status >= 200 && response.status < 300) return response
    const detail = await response.text().catch(() => '')
    throw new ConfluenceError(describeFailure(doing, response.status, detail), response.status)
  }
}

/**
 * One sentence per status people actually hit, with what to do about it.
 *
 * Exported so the tools and tests share one wording — the message is what the model relays to
 * the user, and two phrasings of one failure is how a wrong diagnosis gets repeated.
 */
export function describeFailure(doing: string, status: number, body: string): string {
  let message = ''
  try {
    const parsed = JSON.parse(body) as { message?: unknown }
    if (typeof parsed.message === 'string') message = parsed.message
  } catch {
    message = body.slice(0, 300)
  }
  const said = message.length > 0 ? ` Confluence said: ${message}` : ''
  switch (status) {
    case 400:
      return (
        `Confluence refused ${doing}.${said} If it mentions xhtml, the page body is not valid ` +
        'storage format — every tag must be closed and every macro well formed.'
      )
    case 401:
      return (
        `Confluence did not accept the personal access token while ${doing}. It may have expired ` +
        'or been revoked: create a new one and save it in Settings → Tools → Confluence.'
      )
    case 403:
      return `The token's owner is not allowed to do this (${doing}).${said} Ask a space admin for permission.`
    case 404:
      return `Confluence found nothing while ${doing}.${said} Check the page id or space key.`
    case 409:
      return (
        `Someone changed the page while ${doing}, so it was not overwritten.${said} Read it again ` +
        'and redo the edit against the current version.'
      )
    default:
      return `Confluence answered HTTP ${String(status)} while ${doing}.${said}`
  }
}

export interface ConfluenceAttachment {
  name: string
  mediaType: string
  size: number
  /** Relative to the site base. */
  download: string
}

interface RawAttachment {
  title?: string
  metadata?: { mediaType?: string }
  extensions?: { fileSize?: number }
  _links?: { download?: string }
}

interface RawContent {
  id?: string | number
  title?: string
  space?: { key?: string }
  version?: { number?: number }
  body?: { storage?: { value?: string } }
  ancestors?: { title?: string }[]
  _links?: { webui?: string }
}
