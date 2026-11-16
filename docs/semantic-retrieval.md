# Semantic memory and hybrid RAG

The desktop keeps the existing source-backed Markdown and Qdrant lifecycle. These additions help find a saved decision expressed with different words, recover exact identifiers that embeddings miss, and review where answer context came from. Search scores describe ranking, not truth or confidence.

## Search memory by meaning

In **Knowledge & memory → Semantic memory index**, choose an existing embedding connection. **Index all saved memory** indexes accepted pages; **Index selected saved page** updates one page. Indexing sends saved page titles/bodies to that connection. Credentials remain in the existing vault. The index contains note IDs, revisions, model identity and vectors under `.aiide/memory-index.json`; embeddings can reveal information about their source and belong to the same privacy boundary as the project.

The index covers each full note by splitting its text into 2,500-character parts, embedding them, and averaging normalized vectors into one page vector. It does not silently truncate a long note. Unchanged revisions reuse their existing vectors. Changing the embedding connection URL/model resets compatibility and requires rebuilding. An API provider changing weights behind an unchanged identifier cannot be detected automatically.

Choose **Semantic meaning** or **Hybrid meaning and terms** in **Memory search method**, enter a question and search. The former ranks page vectors by cosine; the latter fuses semantic and BM25 ranks. Results open the current saved page and retain source freshness warnings. Existing **Exact terms** search remains local and makes no provider request.

An explicit rebuild replaces a corrupt derived vector cache without changing accepted notes. Edited/unindexed pages are excluded until reindexed; deleted pages cannot be returned from a stale cache. Every returned page's revision is rechecked after the query embedding request. The indexed model identity must still match its configured connection. The index is bounded to 200 pages, 6,000 text parts per indexing request, 4,096 embedding dimensions and 24 MB. There are at most two concurrent semantic searches; embedding batches have a 30-second timeout, and workspace shutdown aborts active requests. Indexing is explicit rather than an additional unbudgeted background model job. **Cancel current scan or rebuild** also cancels a pending memory index.

MCP's existing read-only `search_knowledge` remains lexical. Inspecting index status makes no model call. Semantic search requires workflow permission because it invokes the selected embedding provider; index mutation is desktop-only.

## Choose a RAG retrieval method

In **RAG → Test retrieval**:

- **Semantic vectors** keeps the existing vector search.
- **Lexical BM25** searches stored source names/text without an embedding request. It works while an embedding provider is unavailable.
- **Hybrid vectors + BM25** merges the two rankings using reciprocal rank fusion. Exact error codes, identifiers and filenames can contribute even when vector similarity ranks them poorly.

Both paths use the selected metadata filter and exclude incomplete ingestion generations. BM25 uses Unicode word tokens, up to 100 unique query terms, `k1=1.2` and `b=0.75`; no language-specific stemming is claimed. The application computes rank fusion as `sum(1/(60 + one-based rank))`. Raw cosine/BM25 values remain separate from the fusion score. This application-side implementation requires no collection migration or new sparse-vector model. The underlying approach follows [Qdrant's hybrid-query guidance](https://qdrant.tech/documentation/hybrid-queries/) and [BM25 similarity](https://www.elastic.co/docs/reference/elasticsearch/index-settings/similarity).

Lexical retrieval scrolls the filtered corpus with a strict 2,000-chunk/8 MB aggregate payload cap. It fails visibly rather than returning an incomplete scan when that cap is exceeded; narrow the metadata filter or use vector search. HTTP embedding/retrieval bodies are bounded before JSON parsing. Duplicate IDs, repeated cursors, malformed payloads and pending generations fail closed. These are desktop-corpus limits, not a large-scale search benchmark.

## Optional reranking and grounded answers

**Rerank with chat model** sends at most 20 already retrieved candidates, with up to 4,000 characters per passage, to the selected chat connection. Its response must be an exact permutation of supplied integer indices. Missing, repeated, out-of-range or invented indices are rejected. It only reorders existing passages; original vector/BM25/fusion scores remain visible, and `rerankRank` is a separate field. Reranking adds a provider request and may still rank poorly; prompt instructions are not an accuracy guarantee.

Managed local results display **source current**, **changed** or **unavailable**. Path-owned legacy passages are read-only and require a matching local file hash and exact chunk offsets/text; unverified legacy evidence is excluded. Current writes use protected random workspace UUIDs, with a reviewed offline reset for manually copied state; see [namespace ownership](rag-lifecycle.md#workspace-namespaces-and-safe-legacy-reads). Unmanaged/other-workspace points display **external**: the IDE cannot establish their local freshness. Changed/unavailable managed passages are excluded from answer context and produce a visible warning. If no current/external reference remains, the IDE returns a deterministic explanation without asking the answer model to fabricate an answer. External points remain queryable and are never deleted by this check. Answers still require review against the displayed passages.

## Original PDF and extraction freshness

A reviewed document export now carries a base64url-encoded source path/hash hint in a Markdown comment, alongside visible page citations. Exact legacy export headers are recognized too. The hint is ordinary untrusted metadata, not a signature, execution permission or proof that extracted claims are correct. Source paths stay inside the workspace, reject protected paths/symlinks/special files, and hash regular originals up to 25 MB without decoding or uploading the PDF. A list/inventory checks at most 256 MB of upstream bytes; a larger scan reports unavailable rather than claiming freshness.

If an original PDF/text file changes while its extracted Markdown remains unchanged, memory source freshness now shows **changed** and RAG refuses to reingest the outdated extraction. Existing notes gain this check without rewriting their accepted content. Query results also warn and omit that stale managed text from answer context. Automatic memory drafting refuses outdated extractions before calling a model, and sources are rechecked before publishing proposals. An original changed during answer generation causes the model answer to be withheld.

Refresh explicitly: preview the changed original in **Import documents**, inspect the pages/OCR, save a new Markdown filename, update the memory page's tracked source list and review its regenerated proposal, then reindex the accepted note. For RAG, ingest the reviewed new source and explicitly remove the obsolete indexed source. Existing exports, notes and original files are never overwritten automatically.

## Real validation

`packages/core/test/semantic-retrieval.test.cjs` exercises cache reuse/reopening, changed/deleted-note exclusion, atomic indexing, cancellation, malformed vectors, no-provider lexical search, hybrid exact-identifier recovery, rerank permutation validation and byte limits. Document tests perform actual PDF extraction, edit the original PDF while preserving the export, verify stale memory detection/ingestion rejection, and save a newly reviewed extraction. Provenance tests include real named pipes and protected/symlink/oversized inputs.

Full actual local model/Qdrant/browser acceptance:

```sh
AIIDE_EMBEDDING_TEST_PYTHON=/absolute/model2vec-environment/bin/python \
AIIDE_EMBEDDING_TEST_MODEL=/absolute/potion-base-8M \
node scripts/test-semantic-retrieval.mjs
```

The optional runtime uses `model2vec==0.10.0` and [minishlab/potion-base-8M](https://huggingface.co/minishlab/potion-base-8M) revision `bf8b056651a2c21b8d2565580b8569da283cab23`. The test verifies all six model/config/tokenizer SHA-256 values before loading; weight SHA-256 is `f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2`. These are distilled static CPU embeddings, not a chat model. The script downloads nothing and starts disposable local services only. Actual synonym retrieval, memory restart/stale exclusion, Qdrant semantic/BM25/hybrid ranking, and the real React/API controls passed. Reranker protocol tests use deterministic responses; no real chat-reranking quality or representative-corpus benchmark is claimed.

URL ingestion, remote/multi-repository connectors, transactional collection-wide reindexing, automatic fact verification and semantic quality across languages remain separate work.
