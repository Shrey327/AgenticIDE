# Keep indexed sources current

The RAG panel now manages the lifecycle of documents ingested by this workspace. Choose a vector database, embedding model and collection, then ingest a UTF-8 `.txt` or `.md` file. Each managed chunk records the canonical workspace source path, source-content hash, embedding connection/model identity, chunking parameters, owner and workspace identity.

## Reingestion and replacement

Chunk point IDs are deterministic UUIDs derived from the source, generation and chunk index. Repeating a fully indexed, unchanged source with the same embedding identity and chunking parameters is a no-op and sends no new embedding request. Alternate relative paths to the same file resolve to the same source identity. Changing the file, chunk size, overlap, model name or endpoint produces a new generation.

The IDE finishes all embedding batches and checks dimensions before mutating vectors. It rejects a source changed while those requests were running. New chunks are initially marked pending, and the IDE's retrieval API excludes pending points. Once every upsert succeeds, the new generation is activated and older generations for this exact managed source are removed. A failed embedding or partial upload leaves the old generation intact. Retry ingestion to complete the new generation and clear stale managed chunks.

Activation and pruning are separate Qdrant operations, not a distributed transaction. If pruning fails after activation, old and new accepted generations can briefly coexist; retry the same source to reconcile them. Direct database clients must honor the pending marker themselves. The IDE serializes ingestion/removal of the same source within one backend; it does not coordinate arbitrary external Qdrant writers.

Remote providers can change weights behind the same model name and URL. The IDE cannot detect that change from connection metadata; explicitly remove the indexed source and ingest it again when the embedding implementation changes without a new identifier.

## Inspect or remove a source

**Manage indexed sources → Refresh indexed sources** shows managed source paths, chunk counts, pending uploads and local freshness. A changed hash means the source differs from the indexed evidence; an unavailable source remains listed. **Select for reingestion** restores the file path for an explicit sync.

**Remove indexed source** asks for confirmation and rechecks the inventory revision. The delete request includes this application owner, workspace identity, exact source identity and the observed point IDs. A changed inventory must be refreshed before removal. Other documents, other workspaces' points, and legacy or third-party points are retained, even when their `source` string matches. The original workspace file is never deleted.

Earlier preview builds appended random-ID points without ownership metadata. Those legacy points cannot safely be attributed to this managed lifecycle and remain untouched. Use their original management tool or a separately reviewed database cleanup to remove them. Browsing documents still exposes the selected collection's ordinary paginated points.

Source management is bounded to 10,000 current/read-only chunks and 400 source rows per inventory scan; larger collections require a narrower collection or a future paginated source-summary API. Document, UTF-8, chunk and dimension limits still apply. Saved provenance tracks file bytes and configuration, not an immutable remote-model weight version.

## Verification

`node scripts/test-rag-lifecycle.mjs` starts a temporary real Qdrant 1.16.2 container and a deterministic HTTP embedding endpoint. It checks canonical/idempotent ingestion, a deliberately interrupted second upload batch, pending exclusion from retrieval, retry/replacement, stale-removal rejection, and preservation of legacy/other-workspace vectors. Chrome then exercises the real RAG component through Workspace operations against that Qdrant server: list → select → no-op reingest → confirmed removal → reingest. The test removes its temporary project and container.

The ordinary core tests cover unsafe document inputs, ownership-filter violations, canonical-source locking, no mutation before embeddings succeed, source freshness and stale deletion. The vector and lifecycle semantics are real; deterministic embedding vectors do not establish retrieval quality for a real corpus/model.

The implementation uses Qdrant's documented [filtered deletion](https://api.qdrant.tech/api-reference/points/delete-points) and [paginated scrolling](https://api.qdrant.tech/api-reference/points/scroll-points). PDF/OCR uses the reviewed document importer. URL ingestion, automatic remote-source crawling and transactional collection-wide reindexing remain separate capabilities.

## Semantic, lexical and hybrid retrieval

The RAG panel now offers BM25 keyword retrieval without an embedding request, vector/BM25 rank fusion, optional validated chat reranking, and current-source warnings/answer-context exclusion. Upstream original PDF/text changes invalidate a generated Markdown extraction for ingestion even if that export has not changed. See [semantic retrieval](semantic-retrieval.md) for workflow, bounds and actual local-model/Qdrant/browser evidence.

## Workspace namespaces and safe legacy reads

New writes use a random per-workspace UUID stored under `.aiide/rag-state/instance.json`, rather than a hash of the workspace path. Source and point IDs include that UUID. Independent machines using the same canonical path cannot replace or prune one another's new managed vectors. The private state folder has its own validated Git ignore policy; ordinary Git clones and reviewed project bundles receive fresh UUIDs. Moving a full workspace with its state preserves its identity.

Existing path-owned points are retained read-only. They are not automatically adopted, rewritten or pruned. Inventory rows label them **Legacy namespace · read-only** and disable removal. Select their local source and explicitly ingest it to create a new UUID-owned generation. Queries only reuse a managed legacy passage when its full local file hash, exact chunk offsets/text and upstream extraction provenance still match. Missing, changed or unverified managed legacy passages are excluded with a warning. Matching verified legacy/current chunks collapse to the current-identity result; this changes the result list, never the database. Unmanaged/external vectors remain unchanged.

**Copying the entire `.aiide` folder copies the UUID too.** There is no reliable automatic detection when another machine uses the same path. For a deliberately copied full-state project, open **Workspace identity and manually copied projects → Preview new RAG identity**, review the exact old/new UUIDs, and apply before writing to a shared collection. This offline operation changes local metadata only. All previous namespaces remain read-only; no database points are deleted. Active ingestion/removal blocks reset, a stale review fails, and atomic metadata replacement preserves the old identity on failure. Eight previous identities can be retained; use a fresh artifact import for further copies. Explicitly forcing private state into Git or copying it manually bypasses the fresh-clone behavior.

This is mutation ownership within a configured database connection, not server-side RBAC or tenant confidentiality. A database connection may still read third-party points from its selected collection. Use separate credentials/collections when users require isolation enforced by the database.
