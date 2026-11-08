import React from '@theia/core/shared/react';
import type { Run, Connection, EventRecord } from '../common/protocol.js';
import { Call, Perform, Empty, Json, Heading, RunSelect } from './shared.js';
import { MetricChart } from './metric-chart.js';
import { TrainingConnections } from './training-connections.js';
import { WandbPanel } from './wandb-panel.js';

export function TrainingPanel({
  runs,
  selected,
  select,
  call,
  perform,
  project,
  connections,
  refresh,
}: {
  runs: Run[];
  selected: string;
  select: (id: string) => void;
  call: Call;
  perform: Perform;
  project: any;
  connections: Connection[];
  refresh: () => Promise<void>;
}) {
  const [command, setCommand] = React.useState(
      Object.keys(project.config.commands).find((k) => k !== 'setup') || '',
    ),
    [target, setTarget] = React.useState('local'),
    [profile, setProfile] = React.useState(''),
    [profiles, setProfiles] = React.useState<any[]>([]);
  const [parameters, setParameters] = React.useState('{}'),
    [launching, setLaunching] = React.useState(false),
    [loadError, setLoadError] = React.useState(''),
    [modelPath, setModelPath] = React.useState(''),
    [datasetPath, setDatasetPath] = React.useState(''),
    [resumeFrom, setResumeFrom] = React.useState<{
      runId: string;
      path: string;
    }>();
  const [events, setEvents] = React.useState<EventRecord[]>([]),
    [metrics, setMetrics] = React.useState<EventRecord[]>([]),
    [comparison, setComparison] = React.useState(''),
    [compareMetrics, setCompareMetrics] = React.useState<EventRecord[]>([]),
    [artifact, setArtifact] = React.useState<any>(),
    [download, setDownload] = React.useState('');
  const reloadProfiles = React.useCallback(
    async () => setProfiles(await call('ssh.list')),
    [call],
  );
  React.useEffect(() => {
    void perform(reloadProfiles);
  }, [reloadProfiles]);
  React.useEffect(() => {
    let active = true,
      pending = false;
    setArtifact(undefined);
    setDownload('');
    setEvents([]);
    setMetrics([]);
    setCompareMetrics([]);
    setLoadError('');
    const load = async () => {
      if (pending || !selected) return;
      pending = true;
      try {
        const [e, m, c] = await Promise.all([
          call('events.list', { runId: selected }),
          call('training.metrics', { id: selected }),
          comparison
            ? call('training.metrics', { id: comparison })
            : Promise.resolve([]),
        ]);
        if (active) {
          setEvents(e);
          setMetrics(m);
          setCompareMetrics(c);
          setLoadError('');
        }
      } catch (error) {
        if (active) setLoadError(String(error));
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [selected, comparison, call]);
  const run = runs.find((r) => r.id === selected),
    names = [
      ...new Set([...metrics, ...compareMetrics].map((e) => e.name)),
    ].slice(0, 50);
  const checkpoints = events.filter((e) =>
    ['artifact', 'checkpoint'].includes(e.kind),
  );
  const hardware = events.find((e) => e.kind === 'hardware');
  return (
    <>
      <Heading
        title="Training workspace"
        text="Launch experiments, follow learning curves, compare configurations, and resume verified checkpoints."
      />
      <p className="aiide-note">
        For model and dataset selection without code, use Train → Experiment lab
        for tabular models, or Hugging Face & fine-tuning for language models.
        This page runs your existing training commands locally or over SSH.
      </p>
      <section className="aiide-card">
        <h3>
          Launch training · {project.config.training?.framework || 'custom'}
        </h3>
        <div className="aiide-form-grid">
          <label>
            Training command
            <select
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            >
              <option value="">Choose command</option>
              {Object.keys(project.config.commands)
                .filter((k) => k !== 'setup')
                .map((k) => (
                  <option key={k}>{k}</option>
                ))}
            </select>
          </label>
          <label>
            Execution target
            <select
              value={target}
              onChange={(e) => {
                setTarget(e.target.value);
                setResumeFrom(undefined);
              }}
            >
              <option value="local">Local environment</option>
              <option value="ssh">SSH machine</option>
            </select>
          </label>
          {target === 'ssh' && (
            <label>
              SSH profile
              <select
                value={profile}
                onChange={(e) => {
                  setProfile(e.target.value);
                  setResumeFrom(undefined);
                }}
              >
                <option value="">Choose profile</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id} · {p.host}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Training parameters (JSON)
            <textarea
              rows={3}
              value={parameters}
              onChange={(e) => setParameters(e.target.value)}
            />
          </label>
          <label>
            Local model path on execution machine (optional)
            <input
              value={modelPath}
              onChange={(e) => setModelPath(e.target.value)}
            />
          </label>
          <label>
            Dataset path on execution machine (optional)
            <input
              value={datasetPath}
              onChange={(e) => setDatasetPath(e.target.value)}
            />
          </label>
        </div>
        {resumeFrom && (
          <p role="status">
            Resume from {resumeFrom.path} ·{' '}
            <button onClick={() => setResumeFrom(undefined)}>
              Clear resume
            </button>
          </p>
        )}
        <button
          className="aiide-primary"
          disabled={launching || !command || (target === 'ssh' && !profile)}
          onClick={() => {
            setLaunching(true);
            void perform(async () => {
              let parsed;
              try {
                parsed = JSON.parse(parameters);
              } catch {
                throw new Error(
                  'Training parameters must be a JSON object, for example {"epochs": 3}',
                );
              }
              if (
                !parsed ||
                Array.isArray(parsed) ||
                typeof parsed !== 'object'
              )
                throw new Error('Training parameters must be a JSON object');
              const created = await call('training.start', {
                name: command,
                target,
                profile: profile || undefined,
                parameters: parsed,
                modelPath: modelPath || undefined,
                datasetPath: datasetPath || undefined,
                resumeFrom,
              });
              select(created.id);
              setResumeFrom(undefined);
              await refresh();
            }).finally(() => setLaunching(false));
          }}
        >
          {launching
            ? 'Launching training…'
            : resumeFrom
              ? 'Launch resumed training'
              : 'Start training'}
        </button>
        <p className="aiide-note">
          Remote jobs keep running when SSH or the IDE disconnects. Reconnect to
          retrieve journaled telemetry. Training commands run as your user on
          the selected machine.
        </p>
      </section>
      <TrainingConnections
        call={call}
        perform={perform}
        reload={reloadProfiles}
      />
      <div className="aiide-form-grid">
        <RunSelect runs={runs} selected={selected} select={select} />
        <label>
          Compare training run
          <select
            value={comparison}
            onChange={(e) => setComparison(e.target.value)}
          >
            <option value="">No comparison</option>
            {runs
              .filter((r) => r.id !== selected)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {new Date(r.started).toLocaleTimeString()}
                </option>
              ))}
          </select>
        </label>
      </div>
      {run && (
        <section className="aiide-card">
          <h3 role="status">Job status: {run.status}</h3>
          {run.training?.profile && (
            <p>
              SSH: {run.training.connection} · remote:{' '}
              {run.training.remoteStatus || 'launching'} · last sync:{' '}
              {run.training.lastSync
                ? new Date(run.training.lastSync).toLocaleTimeString()
                : 'not yet'}{' '}
              · dropped: {run.training.dropped || 0}
            </p>
          )}
          {run.training?.error && <p role="alert">{run.training.error}</p>}
          <div className="aiide-toolbar">
            {run.training?.profile && (
              <button
                onClick={() =>
                  void perform(async () => {
                    await call('training.sync', { id: run.id });
                    await refresh();
                  })
                }
              >
                Reconnect / sync job
              </button>
            )}
            {run.status === 'running' && run.training && (
              <button
                onClick={() =>
                  void perform(async () => {
                    await call('training.cancel', { id: run.id });
                    await refresh();
                  })
                }
              >
                Cancel training
              </button>
            )}
          </div>
          <details>
            <summary>Compare configurations</summary>
            <div className="aiide-columns">
              <Json
                value={{
                  configuration: run.configuration,
                  parameters: run.training?.parameters,
                }}
              />
              <Json value={runs.find((r) => r.id === comparison)} />
            </div>
          </details>
          <p>
            GPU measurements:{' '}
            {(hardware?.value as any)?.gpuStatus ||
              'unavailable — no supported measurements reported'}
          </p>
          {hardware && (
            <details>
              <summary>Hardware details</summary>
              <Json value={hardware.value} />
            </details>
          )}
        </section>
      )}
      {loadError && (
        <p role="alert">Unable to refresh training results: {loadError}</p>
      )}
      {!names.length ? (
        <Empty>
          {run?.status === 'failed'
            ? 'Training failed. Open this run in Runs to inspect its diagnostic events and logs before retrying.'
            : !selected
              ? 'Choose a run above to inspect its learning curves and checkpoints.'
              : 'No training metrics received yet. Instrumented training commands report learning curves here.'}
        </Empty>
      ) : (
        <>
          <p className="aiide-note">
            Latest 20,000 metric events; at most 500 points per curve. Green:
            selected run. Dashed grey: comparison. Horizontal axis: step when
            available.
          </p>
          <div className="aiide-metric-grid">
            {names.map((name) => (
              <section className="aiide-card" key={name}>
                <small>{name}</small>
                <h3>
                  {metrics.some((e) => e.name === name)
                    ? Number(
                        metrics.filter((e) => e.name === name).at(-1)?.value,
                      ).toLocaleString(undefined, { maximumFractionDigits: 6 })
                    : 'Comparison only'}
                </h3>
                <MetricChart
                  values={metrics.filter((e) => e.name === name)}
                  compare={compareMetrics.filter((e) => e.name === name)}
                />
              </section>
            ))}
          </div>
        </>
      )}
      <section className="aiide-card">
        <h3>Artifacts & checkpoints</h3>
        {checkpoints.length === 0 && <p>No artifact references recorded.</p>}
        {checkpoints.map((e) => (
          <div key={e.id}>
            <strong>{e.name}</strong> · {String((e.value as any)?.path)}{' '}
            <button
              aria-label={`Inspect ${e.name}`}
              onClick={() =>
                void perform(async () => {
                  setArtifact(
                    await call('training.artifact', {
                      id: selected,
                      path: (e.value as any).path,
                    }),
                  );
                  setDownload('');
                })
              }
            >
              Inspect checkpoint / artifact
            </button>
          </div>
        ))}
        {artifact && (
          <>
            <h4>{artifact.path}</h4>
            <p>{artifact.reason}</p>
            {artifact.resumable &&
              project.config.training?.resume &&
              run?.training && (
                <button
                  onClick={() => {
                    setResumeFrom({ runId: selected, path: artifact.path });
                    setCommand(run.name);
                    setModelPath(run.training!.modelPath || '');
                    setDatasetPath(run.training!.datasetPath || '');
                    setTarget(run.training!.target);
                    setProfile(run.training!.profile?.id || '');
                    setParameters(
                      JSON.stringify(run.training!.parameters, null, 2),
                    );
                  }}
                >
                  Use this checkpoint for resume
                </button>
              )}
            {artifact.files && (
              <table>
                <caption>Files in {artifact.path}</caption>
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Size</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {artifact.files.map((f: any) => (
                    <tr key={f.name}>
                      <td>{f.name}</td>
                      <td>{f.directory ? 'Directory' : `${f.size} bytes`}</td>
                      <td>
                        {f.directory ? (
                          <button
                            aria-label={`Browse ${f.name}`}
                            onClick={() =>
                              void perform(async () =>
                                setArtifact(
                                  await call('training.artifact', {
                                    id: selected,
                                    path: artifact.path + '/' + f.name,
                                  }),
                                ),
                              )
                            }
                          >
                            Browse
                          </button>
                        ) : (
                          <button
                            aria-label={`${run?.training?.profile ? 'Download' : 'Locate'} ${f.name}`}
                            onClick={() =>
                              void perform(async () =>
                                setDownload(
                                  (
                                    await call('training.download', {
                                      id: selected,
                                      path: artifact.path + '/' + f.name,
                                    })
                                  ).path,
                                ),
                              )
                            }
                          >
                            {run?.training?.profile
                              ? 'Download file'
                              : 'Locate file'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {!artifact.files && artifact.available && (
              <button
                onClick={() =>
                  void perform(async () =>
                    setDownload(
                      (
                        await call('training.download', {
                          id: selected,
                          path: artifact.path,
                        })
                      ).path,
                    ),
                  )
                }
              >
                Locate / download file
              </button>
            )}
          </>
        )}
        {download && <p role="status">File available at: {download}</p>}
      </section>
      <WandbPanel
        call={call}
        perform={perform}
        connections={connections}
        refresh={refresh}
      />
    </>
  );
}
