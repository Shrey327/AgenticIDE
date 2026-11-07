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
    }),
    [span, setSpan] = React.useState<Span>();
  React.useEffect(() => {
    setPage(0);
    setSpan(undefined);
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
  const start = Math.min(...data.items.map((s) => s.start)),
    end = Math.max(...data.items.map((s) => s.end));
  const depth = (span: Span) => {
    let n = 0,
      current = span;
    const seen = new Set<string>();
    while (current.parentSpanId && n < 8 && !seen.has(current.spanId)) {
      seen.add(current.spanId);
      const parent = data.items.find((s) => s.spanId === current.parentSpanId);
      if (!parent) break;
      current = parent;
      n++;
    }
    return n;
  };
  return (
    <>
      <Heading
        title="See every step"
        text="Model calls, tools, and retrieval in one execution timeline."
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
          <div className="aiide-columns wide-left">
            <div className="aiide-trace-list">
              {data.items.map((s) => (
                <button
                  key={s.traceId + s.spanId}
                  className={`aiide-span ${span?.spanId === s.spanId ? 'selected' : ''}`}
                  onClick={() => setSpan(s)}
                >
                  <span style={{ paddingLeft: depth(s) * 14 }}>
                    <i
                      className={`codicon ${s.status === 'error' ? 'codicon-error' : 'codicon-symbol-method'}`}
                    />{' '}
                    {s.name}
                  </span>
                  <span className="aiide-waterfall">
                    <span
                      style={{
                        marginLeft: `${((s.start - start) / Math.max(1, end - start)) * 85}%`,
                        width: `${Math.max(1, ((s.end - s.start) / Math.max(1, end - start)) * 85)}%`,
                      }}
                    />
                  </span>
                  <small>{Math.max(0, s.end - s.start)} ms</small>
                </button>
              ))}
            </div>
            <section className="aiide-card">
              {span ? (
                <>
                  <h3>{span.name}</h3>
                  <span
                    className={`aiide-badge ${span.status === 'error' ? 'failed' : 'completed'}`}
                  >
                    {span.status}
                  </span>
                  <p>Duration: {span.end - span.start} ms</p>
                  {span.parentSpanId &&
                    !data.items.some((s) => s.spanId === span.parentSpanId) && (
                      <p className="aiide-note">
                        Parent is outside this page or has not been received.
                      </p>
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
                  <h4>Attributes</h4>
                  <Json value={span.attributes} />
                  <h4>Events</h4>
                  <Json value={span.events} />
                </>
              ) : (
                <p>Select a step to inspect its attributes.</p>
              )}
            </section>
          </div>
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
