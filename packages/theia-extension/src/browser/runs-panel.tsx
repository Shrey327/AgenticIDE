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
  duration,
  ago,
} from './shared.js';
export function RunsPanel({
  runs,
  project,
  call,
  perform,
  selected,
  select,
  inspect,
  refresh,
  attach,
}: {
  runs: Run[];
  project: any;
  call: Call;
  perform: Perform;
  selected: string;
  select: (id: string) => void;
  inspect: (id: string) => void;
  refresh: () => Promise<void>;
  attach: (x: unknown) => void;
}) {
  const [command, setCommand] = React.useState(
      Object.keys(project.config.commands)[0] || '',
    ),
    [events, setEvents] = React.useState<EventRecord[]>([]),
    [compare, setCompare] = React.useState(''),
    [comparison, setComparison] = React.useState<any>();
  const [summary, setSummary] = React.useState<any>(),
    [filter, setFilter] = React.useState(''),
    [search, setSearch] = React.useState(''),
    [show, setShow] = React.useState('all');
  const visible = runs.filter(
    (r) =>
      (show === 'all' || r.status === show) &&
      (!search || r.name.toLowerCase().includes(search.toLowerCase())),
  );
  React.useEffect(() => {
    let active = true;
    if (selected)
      void perform(async () => {
        const [events, summary] = await Promise.all([
          call('events.list', { runId: selected }),
          call('runs.summary', { runId: selected }),
        ]);
        if (active) {
          setEvents(events);
          setSummary(summary);
        }
      });
    return () => {
      active = false;
    };
  }, [selected, call, runs]);
  const active = runs.find((r) => r.id === selected);
  return (
    <>
      <Heading
        title="Runs & experiments"
        text="Every command, training job, and RAG operation is recorded with its configuration, logs, and trace."
      />
      <div className="aiide-toolbar aiide-card aiide-launch">
        <label>
          Configured command
          <select value={command} onChange={(e) => setCommand(e.target.value)}>
            <option value="">Choose a command</option>
            {Object.keys(project.config.commands).map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <button
          className="aiide-primary"
          disabled={!command}
          onClick={() =>
            void perform(async () => {
              const run = await call('runs.start', { name: command });
              select(run.id);
              await refresh();
            })
          }
        >
          <i className="codicon codicon-play" /> Run locally
        </button>
      </div>
      {runs.length > 0 && (
        <div className="aiide-filterbar">
          <div
            className="aiide-chips"
            role="group"
            aria-label="Filter by status"
          >
            {['all', 'running', 'completed', 'failed'].map((k) => (
              <button
                key={k}
                aria-pressed={show === k}
                onClick={() => setShow(k)}
              >
                {k}{' '}
                <small>
                  {k === 'all'
                    ? runs.length
                    : runs.filter((r) => r.status === k).length}
                </small>
              </button>
            ))}
          </div>
          <input
            className="aiide-search"
            placeholder="Search runs by name…"
            aria-label="Search runs"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      )}
      {!runs.length ? (
        <Empty>
          No runs yet. Run a configured command to see traces, metrics, and
          evaluations here.
        </Empty>
      ) : (
        <div className="aiide-columns wide-left">
          <div className="aiide-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Status</th>
                  <th>Started</th>
                  <th>Duration</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((run) => (
                  <tr
                    key={run.id}
                    className={selected === run.id ? 'selected' : ''}
                  >
                    <td>
                      <button
                        className="aiide-link"
                        onClick={() => select(run.id)}
                      >
                        {run.name}
                      </button>
                    </td>
                    <td>
                      <span className={`aiide-badge ${run.status}`}>
                        {run.status}
                      </span>
                    </td>
                    <td title={new Date(run.started).toLocaleString()}>
                      {ago(run.started)}
                    </td>
                    <td>{duration((run.ended || Date.now()) - run.started)}</td>
                    <td>
                      <button
                        className="aiide-subtle"
                        onClick={() => inspect(run.id)}
                      >
                        Trace ↗
                      </button>
                      {run.status === 'running' && (
                        <button
                          onClick={() =>
                            void perform(async () => {
                              await call('runs.cancel', { id: run.id });
                              await refresh();
                            })
                          }
                        >
                          Stop
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <section className="aiide-card">
            {active ? (
              <>
                <h3>{active.name}</h3>
                {summary && (
                  <dl>
                    <dt>Traced latency</dt>
                    <dd>{summary.latencyMs ?? '—'} ms</dd>
                    <dt>Spans / errors</dt>
                    <dd>
                      {summary.spans} / {summary.errors || 0}
                    </dd>
                    {summary.metrics
                      .filter((m: any) => /token|cost|throughput/.test(m.name))
                      .map((m: any) => (
                        <React.Fragment key={m.name}>
                          <dt>{m.name}</dt>
                          <dd>{m.value}</dd>
                        </React.Fragment>
                      ))}
                  </dl>
                )}
                <p className="aiide-mono">
                  {active.command.join(' ') || 'IDE workflow'}
                </p>
                <details>
                  <summary>Environment & configuration</summary>
                  <Json value={active} />
                </details>
                <button onClick={() => attach({ run: active, events })}>
                  Attach to assistant
                </button>
                <h4>Logs & events</h4>
                <label>
                  Filter by kind, name, severity, or content
                  <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                </label>
                {events.length ? (
                  events
                    .filter(
                      (e) =>
                        !filter ||
                        format(e).toLowerCase().includes(filter.toLowerCase()),
                    )
                    .map((e) => (
                      <div className="aiide-event" key={e.id}>
                        <small>
                          {e.kind} · {e.name}
                        </small>
                        <pre>
                          {typeof e.value === 'string'
                            ? e.value
                            : format(e.value)}
                        </pre>
                      </div>
                    ))
                ) : (
                  <p>No events recorded. Content capture is off by default.</p>
                )}
              </>
            ) : (
              <p>
                Select a run to see its latency, logs, events, and
                configuration.
              </p>
            )}
          </section>
        </div>
      )}
      {selected && (
        <section className="aiide-card">
          <h3>Compare experiments</h3>
          <div className="aiide-toolbar">
            <RunSelect
              runs={runs.filter((r) => r.id !== selected)}
              selected={compare}
              select={setCompare}
            />
            <button
              disabled={!compare}
              onClick={() =>
                void perform(async () =>
                  setComparison(
                    await Promise.all(
                      [selected, compare].map(async (id) => ({
                        run: runs.find((r) => r.id === id),
                        metrics: await call('events.list', {
                          runId: id,
                          kind: 'metric',
                        }),
                        evaluations: await call('events.list', {
                          runId: id,
                          kind: 'evaluation',
                        }),
                      })),
                    ),
                  ),
                )
              }
            >
              Compare
            </button>
          </div>
          {comparison && (
            <div className="aiide-columns">
              {comparison.map((c: any) => (
                <div key={c.run.id}>
                  <h4>
                    {c.run.name} · {time(c.run.started)}
                  </h4>
                  <Json
                    value={{
                      configuration: c.run.configuration,
                      metrics: c.metrics,
                      evaluations: c.evaluations,
                    }}
                  />
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </>
  );
}
