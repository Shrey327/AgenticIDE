import React from '@theia/core/shared/react';
import type { Run, Span } from '../common/protocol.js';
import { Call, Perform, Empty, Heading, RunSelect } from './shared.js';
import { TraceView, spansToNodes } from './trace-view.js';
export function TracePanel({
  run,
  runs,
  select,
  call,
  perform,
  source,
  attach,
}: {
  run?: Run;
  runs: Run[];
  select: (id: string) => void;
  call: Call;
  perform: Perform;
  source: (file: string, line: number) => Promise<void>;
  attach: (x: unknown) => void;
}) {
  const [page, setPage] = React.useState(0),
    [data, setData] = React.useState<{ total: number; items: Span[] }>({
      total: 0,
      items: [],
    });
  const [exportSpan, setExportSpan] = React.useState<Span>();
  const [exportFile, setExportFile] = React.useState(
    'data/trace-regression.jsonl',
  );
  const [reference, setReference] = React.useState('');
  const [reviewed, setReviewed] = React.useState(false);
  const [exported, setExported] = React.useState('');
  const [exporting, setExporting] = React.useState(false);
  React.useEffect(() => {
    setPage(0);
    setData({ total: 0, items: [] });
    setExportSpan(undefined);
    setExported('');
    setReviewed(false);
  }, [run?.id]);
  React.useEffect(() => {
    if (!run) return;
    let active = true;
    const refresh = () =>
      void perform(async () => {
        const next = await call('spans.list', {
          runId: run.id,
          offset: page * 200,
        });
        if (active) setData(next);
      });
    refresh();
    const timer = setInterval(() => {
      if (!run.ended || Date.now() - run.ended < 30000) refresh();
    }, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [run?.id, run?.status, page, call]);
  const nodes = React.useMemo(() => spansToNodes(data.items), [data.items]);
  return (
    <>
      <Heading
        title="See every step"
        text="Model calls, tool calls, retrieval, and evaluator scores as a run tree."
      />
      <RunSelect runs={runs} selected={run?.id || ''} select={select} />
      {exportSpan && run && (
        <section className="aiide-card">
          <h3>Create a regression case from this trace</h3>
          <p>
            Inspect the captured input and supply a reference you have verified.
            The trace's generated output is not automatically treated as
            correct.
          </p>
          <pre tabIndex={0} aria-label="Regression trace input">
            {JSON.stringify(
              exportSpan.attributes.input ??
                exportSpan.attributes['gen_ai.prompt'],
              null,
              2,
            )}
          </pre>
          <label>
            New trace regression dataset
            <input
              value={exportFile}
              disabled={exporting}
              onChange={(event) => setExportFile(event.target.value)}
            />
          </label>
          <label>
            Verified trace reference
            <textarea
              value={reference}
              rows={4}
              maxLength={100000}
              disabled={exporting}
              onChange={(event) => {
                setReference(event.target.value);
                setReviewed(false);
              }}
            />
          </label>
          <label className="aiide-checkbox">
            <input
              type="checkbox"
              checked={reviewed}
              disabled={exporting}
              onChange={(event) => setReviewed(event.target.checked)}
            />
            I verified this reference against the source.
          </label>
          <button
            disabled={exporting || !reviewed || !exportFile.trim()}
            onClick={() =>
              void perform(async () => {
                setExporting(true);
                try {
                  const result = await call('evals.exportTrace', {
                    runId: run.id,
                    spanId: exportSpan.spanId,
                    offset: page * 200,
                    file: exportFile,
                    expected: reference,
                    reviewed: true,
                  });
                  setExported(result.file);
                } finally {
                  setExporting(false);
                }
              })
            }
          >
            Export trace regression case
          </button>
          <button disabled={exporting} onClick={() => setExportSpan(undefined)}>
            Close export
          </button>
          {exported && (
            <p role="status">
              Saved {exported}. Select it in Serve & evaluate to test a model
              change.
            </p>
          )}
        </section>
      )}
      {!run ? (
        <Empty>Choose a run to inspect its trace.</Empty>
      ) : !data.total ? (
        <Empty>
          No spans received. This run may be uninstrumented, still running, or
          its telemetry has expired.
        </Empty>
      ) : (
        <>
          <div className="aiide-toolbar">
            <span>
              {data.total.toLocaleString()} spans · page {page + 1} · timeline
              scaled to this page
            </span>
            <button disabled={!page} onClick={() => setPage(page - 1)}>
              ← Previous
            </button>
            <button
              disabled={(page + 1) * 200 >= data.total}
              onClick={() => setPage(page + 1)}
            >
              Next →
            </button>
          </div>
          <TraceView
            nodes={nodes}
            actions={(node) => {
              const span = data.items.find((s) => s.spanId === node.id);
              if (!span) return null;
              return (
                <div className="aiide-actions">
                  {node.input !== undefined && (
                    <button
                      onClick={() => {
                        setExportSpan(span);
                        setReviewed(false);
                        setReference('');
                        setExported('');
                      }}
                    >
                      Create regression case
                    </button>
                  )}
                  {Boolean(span.attributes['code.filepath']) && (
                    <button
                      onClick={() =>
                        void perform(async () =>
                          source(
                            await call('source.resolve', {
                              file: span.attributes['code.filepath'],
                            }),
                            Number(span.attributes['code.lineno']) || 1,
                          ),
                        )
                      }
                    >
                      Open source ↗
                    </button>
                  )}
                  <button onClick={() => attach(span)}>
                    Attach to assistant
                  </button>
                </div>
              );
            }}
          />
          {data.items.some((s) => s.attributes['langgraph.node']) && (
            <section className="aiide-card">
              <h3>Observed graph execution</h3>
              <div className="aiide-graph">
                {data.items
                  .filter((s) => s.attributes['langgraph.node'])
                  .map((s) => (
                    <span key={s.spanId}>
                      {String(s.attributes['langgraph.node'])} <small>→</small>
                    </span>
                  ))}
              </div>
              <p className="aiide-note">
                Ordered observations from this page; parallel spans may overlap.
              </p>
            </section>
          )}
        </>
      )}
    </>
  );
}
