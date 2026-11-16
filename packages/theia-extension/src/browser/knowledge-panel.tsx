import React from '@theia/core/shared/react';
import type { Connection } from '../common/protocol.js';
import { VoiceInput } from './voice-input.js';
import { Call, Perform, Heading, Empty, ConnectionSelect } from './shared.js';
import { KnowledgeMaintenancePanel } from './knowledge-maintenance-panel.js';
import { NoteLinkMap } from './note-link-map.js';

interface Page {
  id: string;
  title: string;
  file: string;
  body: string;
  revision: string;
  excerpt: string;
  sources: { file: string; hash: string; status?: string }[];
  backlinks: { id: string; title: string }[];
  missingLinks: string[];
  error?: string;
  semanticScore?: number;
  lexicalScore?: number;
}

export function KnowledgePanel({
  call,
  perform,
  connections,
  attach,
  onDirtyChange,
  initialId,
}: {
  call: Call;
  perform: Perform;
  connections: Connection[];
  attach: (context: unknown) => void;
  onDirtyChange?: (dirty: boolean) => void;
  initialId?: string;
}) {
  const [pages, setPages] = React.useState<Page[]>([]);
  const [query, setQuery] = React.useState('');
  const [searchMode, setSearchMode] = React.useState('lexical');
  const [embedding, setEmbedding] = React.useState('');
  const [semanticStatus, setSemanticStatus] = React.useState<any>();
  const [excluded, setExcluded] = React.useState(0);
  const [filter, setFilter] = React.useState('all');
  const [page, setPage] = React.useState<Page>();
  const [title, setTitle] = React.useState('');
  const [body, setBody] = React.useState('');
  const [sources, setSources] = React.useState<Page['sources']>([]);
  const [dirty, setDirty] = React.useState(false);
  const dirtyNow = React.useRef(dirty);
  dirtyNow.current = dirty;
  const navigation = React.useRef(0);
  const [busy, setBusy] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [draftTitle, setDraftTitle] = React.useState('');
  const [files, setFiles] = React.useState('');
  const [model, setModel] = React.useState('');
  const [revisionHistory, setRevisionHistory] = React.useState<any[]>([]);
  const [restoreId, setRestoreId] = React.useState('');
  const [version, setVersion] = React.useState('');
  const [sourceFiles, setSourceFiles] = React.useState('');
  const [archives, setArchives] = React.useState<
    { id: string; deleted: boolean }[]
  >([]);
  const [maintenanceVersion, setMaintenanceVersion] = React.useState(0);
  React.useEffect(() => {
    if (!initialId) return;
    let active = true;
    const ticket = ++navigation.current;
    void perform(async () => {
      const note = await call('knowledge.get', { id: initialId });
      if (active && ticket === navigation.current && !dirtyNow.current)
        choose(note);
    });
    return () => {
      active = false;
    };
  }, [initialId, call]);
  React.useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  React.useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  React.useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const load = async () => {
    const [found, status] = await Promise.all([
      searchMode === 'lexical'
        ? call('knowledge.list', { query })
        : call('knowledge.searchSemantic', { query, mode: searchMode }),
      call('knowledge.maintenance'),
    ]);
    setPages(searchMode === 'lexical' ? found : found.pages);
    setExcluded(searchMode === 'lexical' ? 0 : found.excluded);
    setArchives(status.archived || []);
  };
  const choose = (note?: Page) => {
    navigation.current++;
    setPage(note);
    setTitle(note?.title || '');
    setBody(note?.body || '');
    setSources(note?.sources || []);
    setDirty(false);
    setConfirmDelete(false);
    setSourceFiles(
      (note?.sources || []).map((source) => source.file).join('\n'),
    );
    setRevisionHistory([]);
    setVersion('');
  };
  const openPage = async (id: string) => {
    if (dirtyNow.current) return;
    const ticket = ++navigation.current;
    const note = await call('knowledge.get', { id });
    if (ticket === navigation.current && !dirtyNow.current) choose(note);
  };
  const run = (action: () => Promise<unknown>) =>
    void perform(async () => {
      setBusy(true);
      try {
        await action();
      } finally {
        setBusy(false);
      }
    });
  React.useEffect(() => {
    let active = true;
    void perform(async () => {
      const found = await call('knowledge.list');
      if (active) setPages(found);
      const maintenance = await call('knowledge.maintenance');
      if (active) setArchives(maintenance.archived || []);
    });
    return () => {
      active = false;
    };
  }, []);
  return (
    <>
      <Heading
        title="Project memory"
        text="Keep decisions, findings, and source-backed knowledge as portable Markdown pages."
      />
      <div className="aiide-columns">
        <section className="aiide-card">
          <h3>Find knowledge</h3>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              run(load);
            }}
          >
            <label>
              Search memory
              <input
                value={query}
                maxLength={500}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <label>
              Memory search method
              <select
                value={searchMode}
                disabled={busy}
                onChange={(event) => setSearchMode(event.target.value)}
              >
                <option value="lexical">Exact terms (no model)</option>
                <option value="semantic">Semantic meaning</option>
                <option value="hybrid">Hybrid meaning and terms</option>
              </select>
            </label>
            <div className="aiide-toolbar">
              <button disabled={busy}>Search</button>
              <button
                type="button"
                disabled={dirty || busy}
                onClick={() => choose()}
              >
                New page
              </button>
            </div>
            <label>
              Source freshness
              <select
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              >
                <option value="all">All pages</option>
                <option value="stale">Changed or unavailable sources</option>
                <option value="current">Current sources</option>
              </select>
            </label>
          </form>
          <details>
            <summary>Semantic memory index</summary>
            <ConnectionSelect
              label="Memory embedding model"
              connections={connections}
              value={embedding}
              set={setEmbedding}
              kind="model"
            />
            <p>
              Indexing sends saved note text to this embedding connection and
              stores vectors locally. Searches send the question to the indexed
              connection. Changed or deleted pages are excluded until rebuilt.
              Source freshness warnings still require review.
            </p>
            <div className="aiide-toolbar">
              <button
                disabled={busy || dirty || !embedding}
                onClick={() =>
                  run(async () =>
                    setSemanticStatus(
                      await call('knowledge.indexSemantic', { embedding }),
                    ),
                  )
                }
              >
                Index all saved memory
              </button>
              <button
                disabled={busy || dirty || !embedding || !page}
                onClick={() =>
                  run(async () =>
                    setSemanticStatus(
                      await call('knowledge.indexSemantic', {
                        embedding,
                        ids: [page!.id],
                      }),
                    ),
                  )
                }
              >
                Index selected saved page
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  run(async () =>
                    setSemanticStatus(await call('knowledge.semanticStatus')),
                  )
                }
              >
                Check memory index
              </button>
            </div>
            {semanticStatus && (
              <p role="status">
                {semanticStatus.indexed} of {semanticStatus.pages} pages indexed
                · {semanticStatus.stale} need indexing
                {semanticStatus.modelChanged
                  ? ' · model connection changed; rebuild'
                  : ''}
              </p>
            )}
          </details>
          {!!excluded && (
            <p role="status">
              {excluded} changed or unindexed pages were excluded. Rebuild the
              semantic index to search their current contents.
            </p>
          )}
          {!pages.length && (
            <Empty>
              No pages found. Write a decision or compile selected sources into
              a draft.
            </Empty>
          )}
          {pages
            .filter(
              (note) =>
                filter === 'all' ||
                (filter === 'stale'
                  ? note.sources.some((source) => source.status !== 'current')
                  : note.sources.length > 0 &&
                    note.sources.every(
                      (source) => source.status === 'current',
                    )),
            )
            .map((note) => (
              <div key={note.id}>
                <button
                  disabled={dirty || busy || Boolean(note.error)}
                  onClick={() => run(() => openPage(note.id))}
                >
                  {note.title}
                </button>
                <p className="aiide-note">{note.excerpt}</p>
                {note.semanticScore !== undefined && (
                  <small>
                    Cosine {note.semanticScore.toFixed(3)} · BM25{' '}
                    {note.lexicalScore?.toFixed(3)}
                  </small>
                )}
                {note.error && (
                  <p role="alert">
                    {note.file}: {note.error}. Repair this file in the editor.
                  </p>
                )}
                {note.sources.some((source) => source.status !== 'current') && (
                  <p role="status">
                    Source changed or unavailable · review this page
                  </p>
                )}
              </div>
            ))}
          <h3>Compile a source-backed draft</h3>
          <label>
            Draft title
            <input
              value={draftTitle}
              maxLength={160}
              onChange={(event) => setDraftTitle(event.target.value)}
            />
          </label>
          <label>
            Workspace text files, one per line
            <textarea
              rows={3}
              placeholder={'docs/design.md\nmain.py'}
              value={files}
              onChange={(event) => setFiles(event.target.value)}
            />
          </label>
          <ConnectionSelect
            label="Compile with model"
            connections={connections}
            value={model}
            set={setModel}
            kind="model"
          />
          <p className="aiide-note">
            Only these files are sent to your selected model. Up to 10 files and
            48,000 characters. Review the draft and citations before saving.
          </p>
          <button
            disabled={
              busy || dirty || !model || !files.trim() || !draftTitle.trim()
            }
            onClick={() =>
              run(async () => {
                const draft = await call('knowledge.compile', {
                  title: draftTitle,
                  files: files
                    .split('\n')
                    .map((file) => file.trim())
                    .filter(Boolean),
                  model,
                });
                choose();
                setTitle(draft.title);
                setBody(draft.body);
                setSources(draft.sources);
                setDirty(true);
              })
            }
          >
            Compile draft
          </button>
          <button
            disabled={busy || dirty || !files.trim() || !draftTitle.trim()}
            onClick={() =>
              run(async () => {
                choose(
                  await call('knowledge.import', {
                    title: draftTitle,
                    files: files
                      .split('\n')
                      .map((file) => file.trim())
                      .filter(Boolean),
                  }),
                );
                await load();
              })
            }
          >
            Import sources without a model
          </button>
        </section>
        <section className="aiide-card">
          <h3>{page ? 'Edit page' : 'New page'}</h3>
          <label>
            Page title
            <input
              value={title}
              maxLength={160}
              disabled={busy}
              onChange={(event) => {
                setTitle(event.target.value);
                setDirty(true);
              }}
            />
          </label>
          <label>
            Markdown
            <textarea
              rows={16}
              value={body}
              maxLength={64000}
              disabled={busy}
              onChange={(event) => {
                setBody(event.target.value);
                setDirty(true);
              }}
            />
          </label>
          <VoiceInput
            disabled={busy}
            append={(text) => {
              setBody(
                (previous) => `${previous}${previous ? '\n' : ''}${text}`,
              );
              setDirty(true);
            }}
          />
          <p className="aiide-note">
            Link pages with [[page-id]]. Saved pages live in .aiide-memory/ and
            can be versioned with your project. Memory is stored independently
            of telemetry capture.
          </p>
          {page && (
            <p className="aiide-note">
              {page.file} · ID: {page.id}
            </p>
          )}
          {page && (
            <NoteLinkMap
              call={call}
              id={page.id}
              revision={page.revision}
              disabled={busy || dirty}
              open={(id) => {
                if (dirty || busy) return;
                run(() => openPage(id));
              }}
            />
          )}
          {!!sources.length && (
            <div>
              <h4>Source provenance</h4>
              {sources.map((source) => (
                <p key={source.file}>
                  {source.file} · {source.status || 'draft source'}
                  <br />
                  <small>{source.hash.slice(0, 12)}</small>
                </p>
              ))}
            </div>
          )}
          {page && (
            <details>
              <summary>Maintain this page's sources</summary>
              <label>
                Tracked files, one per line
                <textarea
                  rows={3}
                  value={sourceFiles}
                  disabled={busy || dirty}
                  onChange={(event) => setSourceFiles(event.target.value)}
                />
              </label>
              <p className="aiide-note">
                Rebuilding creates a proposal and includes the saved page plus
                these sources. Select a model in Compile with model. Changing
                this list only changes provenance when you explicitly apply a
                reviewed proposal or save the source list.
              </p>
              <button
                disabled={busy || dirty || !model || !sourceFiles.trim()}
                onClick={() =>
                  run(async () => {
                    await call('knowledge.refresh', {
                      id: page.id,
                      revision: page.revision,
                      model,
                      files: sourceFiles
                        .split('\n')
                        .map((file) => file.trim())
                        .filter(Boolean),
                    });
                  })
                }
              >
                Rebuild as a review proposal
              </button>
              <button
                disabled={busy || dirty}
                onClick={() =>
                  run(async () => {
                    const wanted = sourceFiles
                      .split('\n')
                      .map((file) => file.trim())
                      .filter(Boolean);
                    if (
                      wanted.some(
                        (file) =>
                          !sources.some((source) => source.file === file),
                      )
                    )
                      throw new Error(
                        'Use Rebuild to attach a new source with its actual hash',
                      );
                    const saved = await call('knowledge.save', {
                      id: page.id,
                      revision: page.revision,
                      title: page.title,
                      body: page.body,
                      sources: sources
                        .filter((source) => wanted.includes(source.file))
                        .map(({ file, hash }) => ({ file, hash })),
                    });
                    choose(saved);
                    await load();
                  })
                }
              >
                Save source removals
              </button>
            </details>
          )}
          {!!page?.backlinks.length && (
            <div>
              <h4>Linked from</h4>
              {page.backlinks.map((note) => (
                <button
                  key={note.id}
                  disabled={busy || dirty}
                  onClick={() =>
                    run(async () =>
                      choose(await call('knowledge.get', { id: note.id })),
                    )
                  }
                >
                  {note.title}
                </button>
              ))}
            </div>
          )}
          {!!page?.missingLinks.length && (
            <p role="status">
              Missing linked pages: {page.missingLinks.join(', ')}
            </p>
          )}
          {dirty && (
            <p role="status">
              Unsaved edits. Save or discard before opening another page.
            </p>
          )}
          <div className="aiide-toolbar">
            <button
              className="aiide-primary"
              disabled={busy || !dirty || !title.trim()}
              onClick={() =>
                run(async () => {
                  const saved = await call('knowledge.save', {
                    id: page?.id,
                    revision: page?.revision,
                    title,
                    body,
                    sources: sources.map(({ file, hash }) => ({ file, hash })),
                  });
                  setMaintenanceVersion((value) => value + 1);
                  choose(saved);
                  await load();
                })
              }
            >
              Save page
            </button>
            <button disabled={busy || !dirty} onClick={() => choose(page)}>
              Discard edits
            </button>
            <button
              disabled={busy || !page || dirty}
              onClick={() =>
                attach({
                  type: 'project-memory',
                  title: page!.title,
                  file: page!.file,
                  body: page!.body,
                  sources: page!.sources,
                })
              }
            >
              Attach to assistant
            </button>
            <button
              disabled={busy || !page || dirty}
              onClick={() => setConfirmDelete(!confirmDelete)}
            >
              Delete page
            </button>
          </div>
          {confirmDelete && page && (
            <div role="alert">
              <p>
                Delete “{page.title}”? {page.backlinks.length} page(s) link
                here. This removes its Markdown file.
              </p>
              <button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await call('knowledge.delete', {
                      id: page.id,
                      revision: page.revision,
                    });
                    choose();
                    await load();
                  })
                }
              >
                Confirm deletion
              </button>
              <button disabled={busy} onClick={() => setConfirmDelete(false)}>
                Keep page
              </button>
            </div>
          )}
          <details>
            <summary>Recover a previous or deleted page</summary>
            <label>
              Archived page
              <select
                value={restoreId}
                onChange={(event) => {
                  setRestoreId(event.target.value);
                  setRevisionHistory([]);
                  setVersion('');
                }}
              >
                <option value="">
                  Choose an archived page or enter its ID
                </option>
                {archives.map((note) => (
                  <option key={note.id} value={note.id}>
                    {note.id}
                    {note.deleted ? ' (deleted)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Page ID to recover
              <input
                value={restoreId || page?.id || ''}
                onChange={(event) => setRestoreId(event.target.value)}
                disabled={busy || dirty}
              />
            </label>
            <button
              disabled={busy || dirty || !(restoreId || page?.id)}
              onClick={() =>
                run(async () => {
                  setRevisionHistory(
                    await call('knowledge.history', {
                      id: restoreId || page?.id,
                    }),
                  );
                  setVersion('');
                })
              }
            >
              Load revision history
            </button>
            {revisionHistory.length > 0 && (
              <>
                <label>
                  Saved version
                  <select
                    value={version}
                    onChange={(event) => setVersion(event.target.value)}
                  >
                    <option value="">Choose a version</option>
                    {revisionHistory.map((note) => (
                      <option key={note.version} value={note.version}>
                        {note.updated} · {note.title}
                      </option>
                    ))}
                  </select>
                </label>
                {version && (
                  <pre tabIndex={0} aria-label="Previous memory version">
                    {
                      revisionHistory.find((note) => note.version === version)
                        ?.body
                    }
                  </pre>
                )}
                <button
                  disabled={busy || dirty || !version}
                  onClick={() =>
                    run(async () => {
                      const id = restoreId || page?.id;
                      const current = pages.find((note) => note.id === id);
                      choose(
                        await call('knowledge.restore', {
                          id,
                          version,
                          revision: current?.revision,
                        }),
                      );
                      await load();
                    })
                  }
                >
                  Restore selected version
                </button>
              </>
            )}
          </details>
        </section>
      </div>
      <KnowledgeMaintenancePanel
        call={call}
        perform={perform}
        connections={connections}
        disabled={busy || dirty}
        version={maintenanceVersion}
        working={busy}
        changed={async () => {
          await load();
          const status = await call('knowledge.maintenance');
          setArchives(status.archived || []);
          if (page && !dirty)
            choose(await call('knowledge.get', { id: page.id }));
        }}
      />
    </>
  );
}
