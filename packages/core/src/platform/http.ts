export interface HttpRequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}

export interface HttpResponse {
  status: number
  headers: Record<string, string>
  text(): Promise<string>
  json<T = unknown>(): Promise<T>
  body: ReadableStream<Uint8Array> | null
}

/**
 * The sole outbound network egress point (invariant 2). `fetch` and friends are
 * ESLint-banned everywhere else in the repo — this file is the one exemption.
 */
export interface HttpClient {
  request(url: string, options?: HttpRequestOptions): Promise<HttpResponse>
}

export class FetchHttpClient implements HttpClient {
  async request(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    const init: RequestInit = {}
    if (options.method !== undefined) init.method = options.method
    if (options.headers !== undefined) init.headers = options.headers
    if (options.body !== undefined) init.body = options.body
    if (options.signal !== undefined) init.signal = options.signal

    const response = await fetch(url, init)
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      text: () => response.text(),
      json: <T>() => response.json() as Promise<T>,
      body: response.body,
    }
  }
}
