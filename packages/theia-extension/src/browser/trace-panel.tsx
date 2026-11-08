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
  React.useEffect(() => {
    setPage(0);
    setData({ total: 0, items: [] });
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
