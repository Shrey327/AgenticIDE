import React from '@theia/core/shared/react';
import type { Connection, EventRecord } from '../common/protocol.js';
import { Call, Perform, ConnectionSelect, Json } from './shared.js';
import { MetricChart } from './metric-chart.js';

export function WandbPanel({
  call,
  perform,
  connections,
  refresh,
}: {
  call: Call;
  perform: Perform;
  connections: Connection[];
  refresh: () => Promise<void>;
}) {
  const [connection, setConnection] = React.useState(''),
    [project, setProject] = React.useState(''),
    [selected, setSelected] = React.useState('');
  const [status, setStatus] = React.useState<any>(),
    [runs, setRuns] = React.useState<any>(),
    [history, setHistory] = React.useState<any>(),
    [artifacts, setArtifacts] = React.useState<any>(),
    [files, setFiles] = React.useState<any>(),
    [artifact, setArtifact] = React.useState('');
  const [url, setUrl] = React.useState('https://api.wandb.ai'),
    [key, setKey] = React.useState(''),
    [id, setId] = React.useState('wandb');
  React.useEffect(() => {
    let active = true;
    void perform(async () => {
      const result = await call('wandb.status');
      if (active) setStatus(result);
    });
    return () => {
      active = false;
    };
  }, [call]);
  const query = (operation: string, extra = {}) =>
    call('wandb.query', {
      connection,
      project,
      run: selected || undefined,
      operation,
      ...extra,
    });
  const metrics: EventRecord[] = (history?.items || []).flatMap((row: any) =>
    Object.entries(row)
      .filter(
        ([name, value]) =>
          !name.startsWith('_') &&
          typeof value === 'number' &&
          Number.isFinite(value),
      )
      .map(([name, value]) => ({
        runId: selected,
        kind: 'metric',
        timestamp: Number(row._timestamp || 0) * 1000,
        name,
        value,
        step: row._step,
      })),
  );
  const names = [...new Set(metrics.map((m) => m.name))].slice(0, 30);
  return (
    <details className="aiide-card" data-testid="wandb-panel">
      <summary>Weights & Biases · read-only</summary>
      <p>
        Browse existing runs, metrics, and logged artifacts. Data is shown on
        request; local tracking continues without this connection.
      </p>
      <details>
        <summary>Configure W&B access</summary>
        <div className="aiide-form-grid">
          <label>
            W&B connection name
            <input value={id} onChange={(e) => setId(e.target.value)} />
          </label>
          <label>
            W&B API URL
            <input value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
          <label>
            W&B API key
            <input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
        </div>
        <button
          disabled={!key}
          onClick={() =>
            void perform(async () => {
              await call('connections.save', {
                connection: { id, kind: 'wandb', url },
                secret: key,
              });
              setKey('');
              setConnection(id);
              await refresh();
            })
          }
        >
          Save W&B connection
        </button>
      </details>
      <button
        disabled={status?.installed}
        onClick={() =>
          void perform(async () => {
            await call('wandb.install');
            setStatus(await call('wandb.status'));
          })
        }
      >
        {status?.installed ? 'W&B reader installed' : 'Install W&B reader'}
      </button>
      <div className="aiide-form-grid">
        <ConnectionSelect
          label="W&B connection"
          kind="wandb"
          connections={connections}
          value={connection}
          set={(value) => {
            setConnection(value);
            setRuns(undefined);
            setHistory(undefined);
            setArtifacts(undefined);
            setFiles(undefined);
            setSelected('');
          }}
        />
        <label>
          W&B entity/project
          <input
            value={project}
            placeholder="team/project"
            onChange={(e) => {
              setProject(e.target.value);
              setRuns(undefined);
              setHistory(undefined);
              setArtifacts(undefined);
              setFiles(undefined);
              setSelected('');
            }}
          />
        </label>
      </div>
      <button
        disabled={!connection || !project || !status?.installed}
        onClick={() => void perform(async () => setRuns(await query('runs')))}
      >
        Load W&B runs
      </button>
      {runs && (
        <>
          <div className="aiide-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>State</th>
                  <th>Inspect</th>
                </tr>
              </thead>
              <tbody>
                {runs.items.map((r: any) => (
                  <tr
                    key={r.id}
                    className={selected === r.id ? 'selected' : ''}
                  >
                    <td>{r.name || r.id}</td>
                    <td>{r.state}</td>
                    <td>
                      <button
                        onClick={() =>
                          void perform(async () => {
                            setSelected(r.id);
                            setFiles(undefined);
                            const args = { connection, project, run: r.id };
                            const [h, a] = await Promise.all([
                              call('wandb.query', {
                                ...args,
                                operation: 'history',
                              }),
                              call('wandb.query', {
                                ...args,
                                operation: 'artifacts',
                              }),
                            ]);
                            setHistory(h);
                            setArtifacts(a);
                          })
                        }
                      >
                        Inspect W&B run
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {runs.nextOffset !== null && (
            <button
              onClick={() =>
                void perform(async () =>
                  setRuns(await query('runs', { offset: runs.nextOffset })),
                )
              }
            >
              Next W&B runs
            </button>
          )}
        </>
      )}
      {history && (
        <>
          <h4>History · {history.items.length} rows in this 500-step window</h4>
          <div className="aiide-metric-grid">
            {names.map((name) => (
              <section className="aiide-card" key={name}>
                <h4>{name}</h4>
                <MetricChart values={metrics.filter((m) => m.name === name)} />
              </section>
            ))}
          </div>
          {history.nextStep !== null && (
            <button
              onClick={() =>
                void perform(async () =>
                  setHistory(
                    await query('history', { step: history.nextStep }),
                  ),
                )
              }
            >
              Next history window
            </button>
          )}
          <details>
            <summary>W&B configuration and summary</summary>
            <Json
              value={{
                configuration: history.config,
                summary: history.summary,
              }}
            />
          </details>
        </>
      )}
      {artifacts && (
        <>
          <h4>Logged artifacts</h4>
          {artifacts.items.length === 0 && <p>No logged artifacts.</p>}
          {artifacts.items.map((a: any) => (
            <section key={a.name}>
              <strong>{a.name}</strong> · {a.type} · {a.size ?? 'Unknown'} bytes
              <button
                onClick={() =>
                  void perform(async () => {
                    setArtifact(a.name);
                    setFiles(
                      await query('artifact.files', { artifact: a.name }),
                    );
                  })
                }
              >
                Browse W&B artifact
              </button>
              <details>
                <summary>Artifact metadata</summary>
                <Json value={a} />
              </details>
            </section>
          ))}
          {artifacts.nextOffset !== null && (
            <button
              onClick={() =>
                void perform(async () =>
                  setArtifacts(
                    await query('artifacts', { offset: artifacts.nextOffset }),
                  ),
                )
              }
            >
              Next artifacts
            </button>
          )}
        </>
      )}
      {files && (
        <>
          <h4>{artifact}</h4>
          <Json value={files.items} />
          {files.nextOffset !== null && (
            <button
              onClick={() =>
                void perform(async () =>
                  setFiles(
                    await query('artifact.files', {
                      artifact,
                      offset: files.nextOffset,
                    }),
                  ),
                )
              }
            >
              Next artifact files
            </button>
          )}
        </>
      )}
    </details>
  );
}
