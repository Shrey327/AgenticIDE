import React from '@theia/core/shared/react';
import type { Run, Span, Connection, EventRecord } from '../common/protocol.js';
import {
  Call,
  Perform,
  format,
  time,
  Card,
  Empty,
  Json,
  Heading,
  RunSelect,
  ConnectionSelect,
} from './shared.js';
export function RagPanel({
  connections,
  call,
  perform,
  refresh,
  attach,
}: {
  connections: Connection[];
  call: Call;
  perform: Perform;
  refresh: () => Promise<void>;
  attach: (x: unknown) => void;
}) {
  const [vector, setVector] = React.useState(''),
    [embedding, setEmbedding] = React.useState(''),
    [model, setModel] = React.useState(''),
    [collection, setCollection] = React.useState('documents');
  const [file, setFile] = React.useState(''),
    [size, setSize] = React.useState(800),
    [overlap, setOverlap] = React.useState(120),
    [query, setQuery] = React.useState(''),
    [filter, setFilter] = React.useState('');
  const [result, setResult] = React.useState<any>(),
    [preview, setPreview] = React.useState<any[]>();
  const [dataset, setDataset] = React.useState('evaluation.jsonl'),
    [judge, setJudge] = React.useState('');
  const [sources, setSources] = React.useState<any[]>([]);
  const [confirmSource, setConfirmSource] = React.useState('');
  const [ingesting, setIngesting] = React.useState(false);
  const [managing, setManaging] = React.useState(false);
  const [mode, setMode] = React.useState('semantic');
  const [reranker, setReranker] = React.useState('');
  const [searching, setSearching] = React.useState(false);
  const [identity, setIdentity] = React.useState<any>();
  const [identityReview, setIdentityReview] = React.useState<any>();
  React.useEffect(() => {
    setSources([]);
    setConfirmSource('');
  }, [vector, collection]);
  return (
    <>
      <Heading
        title="Understand your retrieval"
        text="Inspect documents, embeddings, and the context your model actually receives."
      />
      <section className="aiide-card">
        <div className="aiide-form-grid">
          <ConnectionSelect
            label="Vector database"
            connections={connections}
            value={vector}
            set={setVector}
            kind="qdrant"
          />
          <ConnectionSelect
            label="Embedding model"
            connections={connections}
            value={embedding}
            set={setEmbedding}
            kind="model"
          />
          <ConnectionSelect
            label="Answer model (optional)"
            connections={connections}
            value={model}
            set={setModel}
            kind="model"
          />
          <label>
            Collection
            <input
              value={collection}
              onChange={(e) => setCollection(e.target.value)}
            />
          </label>
        </div>
        <div className="aiide-toolbar">
          <button
            onClick={() =>
              void perform(async () => {
                const c = await call('qdrant.start');
                setVector(c.id);
                await refresh();
              })
            }
          >
            Start local Qdrant
          </button>
          <button
            onClick={() =>
              void perform(async () => {
                await call('qdrant.stop');
              })
            }
          >
            Stop local Qdrant
          </button>
          <button
            disabled={!vector}
            onClick={() =>
              void perform(async () =>
                setResult(await call('rag.collections', { id: vector })),
              )
            }
          >
            List collections
          </button>
          <button
            disabled={!vector}
            onClick={() =>
              void perform(async () =>
                setResult(
                  await call('rag.documents', { id: vector, collection }),
                ),
              )
            }
          >
            Browse documents
          </button>
        </div>
        <p className="aiide-note">
          Local Qdrant requires Docker; its image downloads on first use.
          Connect an existing server in Settings.
        </p>
      </section>
      <div className="aiide-columns">
        <section className="aiide-card">
          <h3>1. Ingest a document</h3>
          <label>
            Workspace file (.txt or .md)
            <input
              placeholder="docs/knowledge.md"
              value={file}
              onChange={(e) => setFile(e.target.value)}
            />
          </label>
          <div className="aiide-form-grid">
            <label>
              Chunk size (characters)
              <input
                type="number"
                min="50"
                max="10000"
                value={size}
                onChange={(e) => setSize(Number(e.target.value))}
              />
            </label>
            <label>
              Overlap
              <input
                type="number"
                min="0"
                value={overlap}
                onChange={(e) => setOverlap(Number(e.target.value))}
              />
            </label>
          </div>
          <div className="aiide-toolbar">
            <button
              disabled={!file}
              onClick={() =>
                void perform(async () =>
                  setPreview(
                    await call('rag.preview', { file, size, overlap }),
                  ),
                )
              }
            >
              Preview chunks
            </button>
            <button
              className="aiide-primary"
              disabled={ingesting || !vector || !embedding || !file}
              onClick={() =>
                void perform(async () => {
                  setIngesting(true);
                  try {
                    setResult(
                      await call('rag.ingest', {
                        vector,
                        embedding,
                        collection,
                        file,
                        size,
                        overlap,
                      }),
                    );
                    setSources(
                      await call('rag.sources', { id: vector, collection }),
                    );
                  } finally {
                    setIngesting(false);
                  }
                })
              }
            >
              {ingesting ? 'Embedding and syncing…' : 'Embed & ingest'}
            </button>
          </div>
          <p className="aiide-note">
            Ingestion sends document chunks to the selected embedding model and
            stores them in the selected vector database. Repeating an unchanged
            managed source is idempotent; changed sources replace their older
            managed generations after the new chunks are stored.
          </p>
          {preview && (
            <details open>
              <summary>{preview.length} chunks · first 10 shown</summary>
              {preview.slice(0, 10).map((p, i) => (
                <pre className="aiide-chunk" key={i}>
                  {p.text}
                </pre>
              ))}
            </details>
          )}
        </section>
        <section className="aiide-card">
          <h3>Test retrieval</h3>
          <label>
            Retrieval method
            <select
              value={mode}
              disabled={searching}
              onChange={(event) => setMode(event.target.value)}
            >
              <option value="semantic">Semantic vectors</option>
              <option value="lexical">Lexical BM25 (no embedding call)</option>
              <option value="hybrid">Hybrid vectors + BM25</option>
            </select>
          </label>
          <ConnectionSelect
            label="Rerank with chat model (optional)"
            connections={connections}
            value={reranker}
            set={setReranker}
            kind="model"
          />
          <p className="aiide-note">
            Lexical and hybrid retrieval scan at most 2,000 filtered chunks or 8
            MB. Reranking sends up to 20 candidate passages to the selected
            model and only reorders validated existing passages; it does not
            create evidence.
          </p>
          <label>
            Question
            <textarea
              rows={4}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="What should the model know?"
            />
          </label>
          <label>
            Metadata filter (optional Qdrant JSON)
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder='{"must": [...]}'
            />
          </label>
          <button
            className="aiide-primary"
            disabled={
              searching ||
              !vector ||
              (mode !== 'lexical' && !embedding) ||
              !query
            }
            onClick={() =>
              void perform(async () => {
                setSearching(true);
                try {
                  setResult(
                    await call('rag.query', {
                      vector,
                      embedding: embedding || undefined,
                      model: model || undefined,
                      collection,
                      query,
                      filter: filter ? JSON.parse(filter) : undefined,
                      mode,
                      reranker: reranker || undefined,
                    }),
                  );
                } finally {
                  setSearching(false);
                }
              })
            }
          >
            Retrieve {model ? '& answer' : ''} →
          </button>
        </section>
      </div>
      <section className="aiide-card">
        <h3>Manage indexed sources</h3>
        <details>
          <summary>Workspace identity and manually copied projects</summary>
          <p>
            Official project ZIPs and Git clones create fresh private RAG
            identities. Copying the entire .aiide directory also copies the
            identity. Before a manually copied project writes to a shared
            collection, preview a new identity. Existing vectors remain
            read-only and are never deleted by a reset.
          </p>
          <button
            disabled={managing || ingesting}
            onClick={() =>
              void perform(async () => setIdentity(await call('rag.identity')))
            }
          >
            Check RAG identity
          </button>
          <button
            disabled={managing || ingesting}
            onClick={() =>
              void perform(async () =>
                setIdentityReview(await call('rag.previewIdentityReset')),
              )
            }
          >
            Preview new RAG identity
          </button>
          {identity && (
            <p role="status">
              Current RAG identity: {identity.id} · {identity.readOnly.length}{' '}
              retained previous identities
            </p>
          )}
          {identityReview && (
            <div role="status">
              <p>
                Change {identityReview.current} to {identityReview.next}. Retain{' '}
                {identityReview.retainedNamespaces.length} old namespaces as
                read-only. No database points will be deleted.
              </p>
              <button
                disabled={managing || ingesting}
                onClick={() =>
                  void perform(async () => {
                    setManaging(true);
                    try {
                      setIdentity(
                        await call('rag.resetIdentity', {
                          reviewHash: identityReview.reviewHash,
                          confirmed: true,
                        }),
                      );
                      setIdentityReview(undefined);
                      setSources([]);
                      setConfirmSource('');
                      setResult(undefined);
                    } finally {
                      setManaging(false);
                    }
                  })
                }
              >
                Apply reviewed RAG identity
              </button>
              <button onClick={() => setIdentityReview(undefined)}>
                Keep current RAG identity
              </button>
            </div>
          )}
        </details>
        <p>
          Current-identity sources can be managed here. Legacy namespace rows
          are read-only; explicitly reindex their local files to create
          current-identity sources. Other-workspace and third-party points are
          retained. Removing an indexed source never deletes its workspace file.
        </p>
        <button
          disabled={managing || ingesting || !vector}
          onClick={() =>
            void perform(async () => {
              setManaging(true);
              try {
                setSources(
                  await call('rag.sources', { id: vector, collection }),
                );
                setConfirmSource('');
              } finally {
                setManaging(false);
              }
            })
          }
        >
          Refresh indexed sources
        </button>
        {!sources.length && (
          <p>
            No managed sources listed. Ingest a document or refresh the selected
            collection.
          </p>
        )}
        {!!sources.length && (
          <div className="aiide-table-wrap">
            <table className="aiide-table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Freshness</th>
                  <th>Chunks</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((source) => (
                  <tr key={`${source.namespace}:${source.sourceId}`}>
                    <td>
                      {source.source}
                      <br />
                      <small>{source.embeddingModel}</small>
                      {source.ownership === 'legacy-readonly' && (
                        <p>
                          Legacy namespace · read-only; reindex the local file
                          under this project's identity.
                        </p>
                      )}
                    </td>
                    <td>
                      {source.freshness}
                      {source.pending
                        ? ` · ${source.pending} pending chunk(s); retry ingestion`
                        : ''}
                    </td>
                    <td>{source.chunks}</td>
                    <td>
                      <button
                        disabled={managing || ingesting}
                        onClick={() => {
                          setFile(source.source);
                          if (Number.isInteger(source.chunkSize))
                            setSize(source.chunkSize);
                          if (Number.isInteger(source.overlap))
                            setOverlap(source.overlap);
                          if (
                            connections.some(
                              (connection) =>
                                connection.id === source.embeddingConnection &&
                                connection.kind === 'model',
                            )
                          )
                            setEmbedding(source.embeddingConnection);
                          setConfirmSource('');
                        }}
                      >
                        Select for reingestion
                      </button>
                      <button
                        disabled={
                          managing ||
                          ingesting ||
                          source.ownership === 'legacy-readonly'
                        }
                        onClick={() => setConfirmSource(source.sourceId)}
                      >
                        Remove indexed source
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {confirmSource && (
          <div role="alert">
            <p>
              Remove all managed chunks for{' '}
              {
                sources.find((source) => source.sourceId === confirmSource)
                  ?.source
              }
              ? This leaves the original file and all other sources intact.
            </p>
            <button
              disabled={managing || ingesting}
              onClick={() =>
                void perform(async () => {
                  setManaging(true);
                  try {
                    const source = sources.find(
                      (source) => source.sourceId === confirmSource,
                    );
                    setResult(
                      await call('rag.removeSource', {
                        id: vector,
                        collection,
                        sourceId: source.sourceId,
                        revision: source.revision,
                        confirmed: true,
                      }),
                    );
                    setConfirmSource('');
                    setSources(
                      await call('rag.sources', { id: vector, collection }),
                    );
                  } finally {
                    setManaging(false);
                  }
                })
              }
            >
              Confirm indexed source removal
            </button>
            <button disabled={managing} onClick={() => setConfirmSource('')}>
              Keep indexed source
            </button>
          </div>
        )}
      </section>
      <section className="aiide-card">
        <h3>3. Evaluate your RAG pipeline</h3>
        <div className="aiide-form-grid">
          <label>
            Dataset file (JSONL)
            <input
              value={dataset}
              onChange={(e) => setDataset(e.target.value)}
            />
          </label>
          <ConnectionSelect
            label="Judge model (optional)"
            connections={connections}
            value={judge}
            set={setJudge}
            kind="model"
          />
        </div>
        <button
          disabled={!vector || (mode !== 'lexical' && !embedding) || !dataset}
          onClick={() =>
            void perform(async () =>
              setResult(
                await call('evaluations.rag', {
                  vector,
                  embedding: embedding || undefined,
                  model: model || undefined,
                  collection,
                  dataset,
                  judge: judge || undefined,
                  mode,
                  reranker: reranker || undefined,
                  filter: filter ? JSON.parse(filter) : undefined,
                }),
              ),
            )
          }
        >
          Run evaluation
        </button>
        <p className="aiide-note">
          Each case has input and expected strings. Default check: answer
          contains expected text; use match: exact for equality. Optional model
          scoring sends cases to the selected judge.
        </p>
      </section>
      {result && (
        <section className="aiide-card">
          <div className="aiide-row">
            <h3 role="status">Results ready</h3>
            <button onClick={() => attach(result)}>Attach to assistant</button>
          </div>
          {result.answer && <p className="aiide-answer">{result.answer}</p>}
          {result.warnings?.map((warning: string) => (
            <p role="status" key={warning}>
              {warning}
            </p>
          ))}
          {result.retrieval && (
            <p role="status">
              {result.retrieval.mode} retrieval · {result.retrieval.candidates}{' '}
              candidates
              {result.retrieval.reranker
                ? ` · reranked by ${result.retrieval.reranker}`
                : ''}
            </p>
          )}
          {result.points ? (
            result.points.map((p: any) => (
              <div className="aiide-chunk" key={p.id}>
                <small>
                  {p.payload?.source} · score {p.score?.toFixed(4)}
                  {p.sourceStatus ? ` · source ${p.sourceStatus}` : ''}
                  {p.sourceOwnership === 'legacy-readonly'
                    ? ' · verified legacy/read-only'
                    : ''}
                  {p.rerankRank ? ` · rerank position ${p.rerankRank}` : ''}
                  {p.vectorScore !== undefined
                    ? ` · cosine ${p.vectorScore.toFixed(4)}`
                    : ''}
                  {p.lexicalScore !== undefined
                    ? ` · BM25 ${p.lexicalScore.toFixed(4)}`
                    : ''}
                </small>
                <p>{p.payload?.text}</p>
              </div>
            ))
          ) : (
            <Json value={result} />
          )}
        </section>
      )}
    </>
  );
}
