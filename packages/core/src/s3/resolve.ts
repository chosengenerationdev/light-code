import type { S3Config } from '../config/schema.js'
import type { HttpClient } from '../platform/http.js'
import type { SecretStore } from '../platform/secrets.js'
import { S3Client } from './client.js'
import type { S3Target } from './tools.js'

/**
 * Turns configured connections into usable ones.
 *
 * One owner, because three things need the same answer — the tools, the skills sync and the Python
 * tools sync — and each resolving its own credentials would be three places to get the endpoint,
 * the prefix or the TLS material subtly different. That is the shape this project has paid for
 * most often.
 *
 * A connection whose secret is missing is **left out rather than failing the lot**: someone with
 * two buckets and one stale key should keep the working one, and the reason is reported so the
 * missing one is not a mystery.
 */

export interface ResolvedS3 {
  targets: S3Target[]
  /** Connections that could not be used, and why. Shown in the panel, never thrown. */
  problems: { label: string; problem: string }[]
}

export interface ResolveS3Options {
  config?: S3Config | undefined
  http: HttpClient
  secrets: SecretStore
  /** From the one global resolver, so a corporate CA reaches S3 as it reaches everything else. */
  tls?: { ca?: Buffer[]; rejectUnauthorized?: boolean } | undefined
}

export async function resolveS3(options: ResolveS3Options): Promise<ResolvedS3> {
  const targets: S3Target[] = []
  const problems: { label: string; problem: string }[] = []

  for (const connection of options.config?.connections ?? []) {
    const secret = await options.secrets.get(connection.secretAccessKeyRef)
    if (secret === undefined || secret.trim().length === 0) {
      problems.push({
        label: connection.label,
        problem:
          'Its secret access key is not in storage. Open Settings → Skills and enter it again — ' +
          'a key is never written to the config file, so one can go missing while the ' +
          'connection stays.',
      })
      continue
    }

    const sessionToken =
      connection.sessionTokenRef === undefined
        ? undefined
        : await options.secrets.get(connection.sessionTokenRef)

    const client = new S3Client(
      options.http,
      {
        bucket: connection.bucket,
        region: connection.region,
        accessKeyId: connection.accessKeyId,
        secretAccessKey: secret,
        ...(sessionToken !== undefined ? { sessionToken } : {}),
        ...(connection.endpoint !== undefined ? { endpoint: connection.endpoint } : {}),
        ...(connection.pathStyle !== undefined ? { pathStyle: connection.pathStyle } : {}),
      },
      options.tls,
    )

    targets.push({
      id: connection.id,
      label: connection.label,
      bucket: connection.bucket,
      client,
      ...(connection.prefix !== undefined ? { prefix: connection.prefix } : {}),
      ...(connection.readOnly !== undefined ? { readOnly: connection.readOnly } : {}),
    })
  }

  return { targets, problems }
}

/** The connection a feature named, or undefined when it is gone or was never set up. */
export function targetById(resolved: ResolvedS3, id: string | undefined): S3Target | undefined {
  if (id === undefined) return undefined
  return resolved.targets.find((target) => target.id === id)
}
