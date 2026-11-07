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
          <h3>Ingest a document</h3>
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
              disabled={!vector || !embedding || !file}
              onClick={() =>
                void perform(async () =>
                  setResult(
                    await call('rag.ingest', {
                      vector,
                      embedding,
                      collection,
                      file,
                      size,
                      overlap,
                    }),
                  ),
                )
              }
            >
              Embed & ingest
            </button>
          </div>
          <p className="aiide-note">
            Ingestion sends document chunks to the selected embedding model and
            stores them in the selected vector database.
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
            disabled={!vector || !embedding || !query}
            onClick={() =>
              void perform(async () =>
                setResult(
                  await call('rag.query', {
                    vector,
                    embedding,
                    model: model || undefined,
                    collection,
                    query,
                    filter: filter ? JSON.parse(filter) : undefined,
                  }),
                ),
              )
            }
          >
            Retrieve {model ? '& answer' : ''} →
          </button>
        </section>
      </div>
      <section className="aiide-card">
        <h3>Evaluate your RAG pipeline</h3>
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
          disabled={!vector || !embedding || !dataset}
          onClick={() =>
            void perform(async () =>
              setResult(
                await call('evaluations.rag', {
                  vector,
                  embedding,
                  model: model || undefined,
                  collection,
                  dataset,
                  judge: judge || undefined,
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
            <h3>Results</h3>
            <button onClick={() => attach(result)}>Attach to assistant</button>
          </div>
          {result.answer && <p className="aiide-answer">{result.answer}</p>}
          {result.points ? (
            result.points.map((p: any) => (
              <div className="aiide-chunk" key={p.id}>
                <small>
                  {p.payload?.source} · score {p.score?.toFixed(4)}
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
