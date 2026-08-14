import type { VectorStoreConfig } from '../config/schema.js'
import type { HttpClient } from '../platform/http.js'
import { OpenSearchClient } from './opensearch/client.js'
import { OpenSearchIndexWriter } from './opensearch/writer.js'
import {
  VectorStoreError,
  type VectorIndexWriter,
  type VectorSearcher,
  type VectorStoreConnection,
} from './vectorStore.js'

/**
 * Builds the two halves of a vector store from config.
 *
 * **This is the only place a backend is chosen**, so adding Qdrant is a new adapter plus a
 * case here plus a string in `vectorStoreKindSchema` — and the compiler names the third one
 * if you forget it. Nothing upstream switches on `kind`: the indexer takes a
 * `VectorIndexWriter`, `search_codebase` takes a `VectorSearcher`, and neither knows or
 * cares which cluster is behind it.
 *
 * The searcher and the writer are built by **separate functions** on purpose. A single
 * `createVectorStore()` returning both would put a write method within reach of every caller
 * that only wanted to read, which is exactly the property `rag/vectorStore.ts` exists to
 * preserve. The bridge calls `createVectorSearcher` for tools and `createVectorIndexWriter`
 * only inside the indexing command.
 */

function unsupported(kind: string): never {
  /*
   * Unreachable while `vectorStoreKindSchema` lists only backends that exist — a config
   * naming anything else fails validation long before here. It stays because the schema and
   * this switch are two files, and the day they disagree the failure should name the reason
   * rather than being a silent `undefined`.
   */
  throw new VectorStoreError(`"${kind}" is not a vector store backend Light Code can use.`)
}

export function createVectorSearcher(
  http: HttpClient,
  store: Pick<VectorStoreConfig, 'kind'>,
  connection: VectorStoreConnection,
): VectorSearcher {
  switch (store.kind) {
    case 'opensearch':
      return new OpenSearchClient(http, connection)
    default:
      return unsupported(String(store.kind))
  }
}

export function createVectorIndexWriter(
  http: HttpClient,
  store: Pick<VectorStoreConfig, 'kind'>,
  connection: VectorStoreConnection,
): VectorIndexWriter {
  switch (store.kind) {
    case 'opensearch':
      return new OpenSearchIndexWriter(http, connection)
    default:
      return unsupported(String(store.kind))
  }
}
