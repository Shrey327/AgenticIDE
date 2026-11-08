import React from '@theia/core/shared/react';
import type { Run, EventRecord } from '../common/protocol.js';
import { Call, Perform, Empty, Heading, ago, duration } from './shared.js';
import { MetricChart } from './metric-chart.js';

type Task = 'regression' | 'classification';
type Grid = Record<string, string>;
type Config = {
  file: string;
  target: string;
  task: Task;
  features?: string[];
  seed?: number;
  metrics: string[];
  primary: string;
  validation: { type: 'kfold' | 'holdout'; folds: number; test_size: number };
  search: 'grid' | 'random';
  trials: number;
  models: { id: string; grid: Grid }[];
};
const defaults: Record<
  Task,
  { metrics: string[]; primary: string; models: string[] }
> = {
  regression: {
    metrics: ['rmse', 'mae', 'r2'],
    primary: 'rmse',
    models: ['ridge', 'random_forest', 'hist_gradient_boosting'],
  },
  classification: {
    metrics: ['accuracy', 'f1', 'roc_auc'],
    primary: 'f1',
    models: ['logistic', 'svm', 'random_forest'],
  },
};
const values = (text: string) => [
  ...new Set(
    text
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  ),
];
const fmt = (n: number) =>
  Math.abs(n) >= 1000
    ? Math.round(n).toLocaleString()
    : Number(n.toPrecision(4)).toString();

export function LabPanel({
  runs,
  call,
  perform,
  refresh,
  openTrace,
}: {
  runs: Run[];
  call: Call;
  perform: Perform;
  refresh: () => Promise<void>;
  openTrace: (id: string) => void;
}) {
  const [catalog, setCatalog] = React.useState<any>(),
    [files, setFiles] = React.useState<{ file: string; bytes: number }[]>([]),
    [file, setFile] = React.useState(''),
    [profile, setProfile] = React.useState<any>(),
    [target, setTarget] = React.useState(''),
    [task, setTask] = React.useState<Task>('regression'),
    [excluded, setExcluded] = React.useState<string[]>([]),
    [validation, setValidation] = React.useState<Config['validation']>({
      type: 'kfold',
      folds: 5,
      test_size: 0.2,
    }),
    [metrics, setMetrics] = React.useState<string[]>([]),
    [primary, setPrimary] = React.useState(''),
    [chosen, setChosen] = React.useState<Record<string, Grid>>({}),
    [search, setSearch] = React.useState<'grid' | 'random'>('grid'),
    [randomTrials, setRandomTrials] = React.useState(20),
    [sweepId, setSweepId] = React.useState(''),
    [models, setModels] = React.useState<any[]>([]);
  const selection = React.useRef(0);

  const reloadModels = React.useCallback(
    async () => setModels(await call('lab.models')),
    [call],
  );
  React.useEffect(() => {
    void perform(async () => {
      setFiles(await call('lab.files'));
      await reloadModels();
      try {
        setCatalog(await call('lab.catalog'));
      } catch (e) {
        setCatalog({
          error: `Could not run this project's Python environment: ${String(e).replace(/^Error: /, '')}. Check the Python executable in Settings.`,
        });
      }
    });
  }, [call]);
  const finals = runs.filter(
    (r) => r.lab?.kind === 'final' && r.status === 'completed',
  ).length;
  React.useEffect(() => {
    if (finals) void perform(reloadModels);
  }, [finals]);

  const spec = catalog?.tasks?.[task];
  const resetForTask = (next: Task) => {
    setTask(next);
    setMetrics(defaults[next].metrics);
    setPrimary(defaults[next].primary);
    setChosen(Object.fromEntries(defaults[next].models.map((m) => [m, {}])));
  };
  const choose = (next: string) =>
    perform(async () => {
      setFile(next);
      setProfile(undefined);
      const request = ++selection.current;
      if (!next) return;
      const p = await call('lab.inspect', { file: next });
      if (request !== selection.current) return;
      setProfile(p);
      setTarget(p.target);
      setExcluded([]);
      resetForTask(p.tasks[p.target]);
    });
  const pickTarget = (name: string) => {
    setTarget(name);
    setExcluded((e) => e.filter((x) => x !== name));
    resetForTask(profile.tasks[name]);
  };

  const grid = (id: string, param: string) =>
    chosen[id]?.[param] ?? spec?.models[id]?.params[param]?.default ?? '';
  const combos = (id: string) =>
    Object.keys(spec?.models[id]?.params || {}).reduce(
      (n, p) => n * Math.max(1, values(grid(id, p)).length),
      1,
    );
  const total = Object.keys(chosen).reduce((n, id) => n + combos(id), 0);
  const planned = search === 'random' ? Math.min(randomTrials, total) : total;
  const features = (profile?.columns || [])
    .map((c: any) => c.name)
    .filter((n: string) => n !== target && !excluded.includes(n));
  const problem = !features.length
    ? 'Select at least one feature.'
    : !metrics.length
      ? 'Select at least one metric.'
      : !planned || planned > 200 || !Number.isInteger(planned)
        ? 'Choose between 1 and 200 trials. Use random search to limit a large grid.'
        : validation.type === 'kfold' &&
            (!Number.isInteger(validation.folds) ||
              validation.folds < 2 ||
              validation.folds > 10)
          ? 'Choose between 2 and 10 folds.'
          : validation.type === 'holdout' &&
              (validation.test_size < 0.05 || validation.test_size > 0.5)
            ? 'Choose a holdout size between 5% and 50%.'
            : Object.keys(chosen).some((id) =>
                  Object.keys(spec?.models[id]?.params || {}).some(
                    (p) => !values(grid(id, p)).length,
                  ),
                )
              ? 'Enter at least one value for every selected hyperparameter.'
              : '';

  const config = (): Config => ({
    file,
    target,
    task,
    features,
    seed: 42,
    metrics,
    primary,
    validation,
    search,
    trials: randomTrials,
    models: Object.keys(chosen).map((id) => ({
      id,
      grid: Object.fromEntries(
        Object.keys(spec.models[id].params).map((p) => [p, grid(id, p)]),
      ),
    })),
  });
  const apply = (c: Config) =>
    perform(async () => {
      const p = await call('lab.inspect', { file: c.file });
      setFile(c.file);
      setProfile(p);
      setTarget(c.target);
      setTask(c.task);
      setExcluded(
        p.columns
          .map((col: any) => col.name)
          .filter(
            (n: string) =>
              n !== c.target && c.features && !c.features.includes(n),
          ),
      );
      setValidation(c.validation);
      setMetrics(c.metrics);
      setPrimary(c.primary);
      setSearch(c.search);
      setRandomTrials(c.trials);
      setChosen(Object.fromEntries(c.models.map((m) => [m.id, m.grid])));
      document
        .querySelector('.aiide-lab-setup')
        ?.scrollIntoView({ behavior: 'smooth' });
    });

  const sweeps = runs.filter((r) => r.lab?.kind === 'sweep');
  const sweep = sweeps.find((r) => r.id === sweepId) || sweeps[0];

  return (
    <>
      <Heading
        title="Experiment lab"
        text="Compare models and hyperparameters on a CSV without writing code. Every sweep is a recorded run; train the winner and try it right here."
      />
      {!catalog ? (
        <section className="aiide-card">
          <p role="status">
            <i className="codicon codicon-loading codicon-modifier-spin" />{' '}
            Checking this project's Python environment… The first check can take
            a little while after a fresh install.
          </p>
        </section>
      ) : catalog.error ? (
        <section className="aiide-card">
          <h3>
            <i className="codicon codicon-warning" /> The lab can't start yet
          </h3>
          <p>{catalog.error}</p>
          <div className="aiide-toolbar">
            <button
              onClick={() =>
                void perform(async () => {
                  const run = await call('environment.setup');
                  await refresh();
                  openTrace(run.id);
                })
              }
            >
              Set up locked environment
            </button>
            <button
              onClick={() =>
                void perform(async () => setCatalog(await call('lab.catalog')))
              }
            >
              Check environment again
            </button>
          </div>
          <p className="aiide-note">
            Setup installs this project's locked dependencies. For a new
            project, choose the scikit-learn template on Home first.
          </p>
        </section>
      ) : (
        <div className="aiide-lab-setup">
          <section className="aiide-card">
            <Step
              n={1}
              title="Data"
              text="Pick a dataset and what to predict."
            />
            <div className="aiide-toolbar">
              <button
                onClick={() =>
                  void perform(async () => {
                    const sample = await call('lab.sample');
                    setFiles(await call('lab.files'));
                    await choose(sample.file);
                  })
                }
              >
                Try Iris classification sample
              </button>
              <button
                onClick={() =>
                  void perform(async () => setFiles(await call('lab.files')))
                }
              >
                Refresh datasets
              </button>
              <small>
                Creates a local sample with 150 flowers and three species. No
                download needed.
              </small>
            </div>
            {!files.length ? (
              <p>
                No CSV files found in this workspace. Add one (for example{' '}
                <code>data/train.csv</code>), then{' '}
                <button
                  className="aiide-link"
                  onClick={() =>
                    void perform(async () => setFiles(await call('lab.files')))
                  }
                >
                  rescan
                </button>
                .
              </p>
            ) : (
              <div className="aiide-form-grid">
                <label>
                  Dataset
                  <select
                    value={file}
                    onChange={(e) => void choose(e.target.value)}
                  >
                    <option value="">Choose a CSV or TSV file</option>
                    {files.map((f) => (
                      <option key={f.file} value={f.file}>
                        {f.file} · {(f.bytes / 1024).toFixed(0)} KB
                      </option>
                    ))}
                  </select>
                </label>
                {profile && (
                  <label>
                    Target (what to predict)
                    <select
                      value={target}
                      onChange={(e) => pickTarget(e.target.value)}
                    >
                      {profile.columns.map((c: any) => (
                        <option key={c.name}>{c.name}</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            )}
            {profile && (
              <>
                <div className="aiide-toolbar">
                  <span>
                    {profile.rows.toLocaleString()} rows ·{' '}
                    {profile.columns.length} columns · predicting{' '}
                    <strong>{target}</strong> as
                  </span>
                  <div className="aiide-chips" role="group" aria-label="Task">
                    {(['regression', 'classification'] as Task[]).map((t) => (
                      <button
                        key={t}
                        aria-pressed={task === t}
                        onClick={() => resetForTask(t)}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
                <small className="aiide-muted">
                  Features · click to exclude ({features.length} used)
                </small>
                <div
                  className="aiide-chips aiide-columns-list"
                  role="group"
                  aria-label="Included features"
                >
                  {profile.columns
                    .filter((c: any) => c.name !== target)
                    .map((c: any) => (
                      <button
                        key={c.name}
                        aria-pressed={!excluded.includes(c.name)}
                        title={`${c.type} · ${c.unique} unique · ${c.missing} missing`}
                        onClick={() =>
                          setExcluded((e) =>
                            e.includes(c.name)
                              ? e.filter((x) => x !== c.name)
                              : [...e, c.name],
                          )
                        }
                      >
                        <i
                          className={`codicon codicon-${c.type === 'numeric' ? 'symbol-numeric' : 'symbol-string'}`}
                        />
                        {c.name}
                        {c.missing > 0 && <small>{c.missing} missing</small>}
                      </button>
                    ))}
                </div>
                <p className="aiide-note">
                  Missing numeric values are filled, categories encoded, and SVM
                  / linear inputs scaled automatically within each training
                  fold. Remove identifiers and columns that would not be
                  available when predicting.
                  {profile.columns.find((c: any) => c.name === target)
                    ?.missing > 0 &&
                    ` ${profile.columns.find((c: any) => c.name === target).missing} rows without a target will be excluded.`}
                </p>
                <details>
                  <summary>Preview first rows</summary>
                  <div className="aiide-table-wrap">
                    <table aria-label="Dataset preview">
                      <thead>
                        <tr>
                          {profile.columns.map((c: any) => (
                            <th key={c.name} scope="col">
                              {c.name}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {profile.sample.map((row: string[], i: number) => (
                          <tr key={i}>
                            {row.map((v, j) => (
                              <td key={j}>{v}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </>
            )}
          </section>

          {profile && spec && (
            <>
              <section className="aiide-card">
                <Step
                  n={2}
                  title="Evaluation"
                  text="How each candidate is scored. The primary metric ranks the leaderboard."
                />
                <div className="aiide-form-grid">
                  <label>
                    Validation
                    <select
                      value={validation.type}
                      onChange={(e) =>
                        setValidation({
                          ...validation,
                          type: e.target.value as any,
                        })
                      }
                    >
                      <option value="kfold">K-fold cross-validation</option>
                      <option value="holdout">Single holdout split</option>
                    </select>
                  </label>
                  {validation.type === 'kfold' ? (
                    <label>
                      Folds
                      <input
                        type="number"
                        min={2}
                        max={10}
                        value={validation.folds}
                        onChange={(e) =>
                          setValidation({
                            ...validation,
                            folds: Number(e.target.value),
                          })
                        }
                      />
                    </label>
                  ) : (
                    <label>
                      Holdout size (%)
                      <input
                        type="number"
                        min={5}
                        max={50}
                        value={Math.round(validation.test_size * 100)}
                        onChange={(e) =>
                          setValidation({
                            ...validation,
                            test_size: Number(e.target.value) / 100,
                          })
                        }
                      />
                    </label>
                  )}
                </div>
                <small className="aiide-muted">Metrics</small>
                <div
                  className="aiide-chips"
                  role="group"
                  aria-label="Evaluation metrics"
                >
                  {Object.entries(spec.metrics).map(([id, m]: any) => (
                    <button
                      key={id}
                      aria-pressed={metrics.includes(id)}
                      onClick={() => {
                        const next = metrics.includes(id)
                          ? metrics.filter((x) => x !== id)
                          : [...metrics, id];
                        setMetrics(next);
                        if (!next.includes(primary)) setPrimary(next[0] || '');
                      }}
                    >
                      {m.label} <small>{m.higher ? '↑' : '↓'}</small>
                    </button>
                  ))}
                </div>
                <label className="aiide-inline">
                  Rank by
                  <select
                    value={primary}
                    onChange={(e) => setPrimary(e.target.value)}
                  >
                    {metrics.map((m) => (
                      <option key={m} value={m}>
                        {spec.metrics[m].label} (
                        {spec.metrics[m].higher ? 'higher' : 'lower'} is better)
                      </option>
                    ))}
                  </select>
                </label>
                <p className="aiide-note">
                  {task === 'classification'
                    ? 'Classification splits preserve class proportions. F1 macro gives each class equal weight. '
                    : ''}
                  These splits assume independent rows. Time series and repeated
                  measurements need a time-aware or grouped evaluation outside
                  this lab.
                </p>
              </section>

              <section className="aiide-card">
                <Step
                  n={3}
                  title="Models & hyperparameters"
                  text="Tick the candidates. Each field takes comma-separated values; every combination becomes a trial."
                />
                <div className="aiide-model-grid">
                  {Object.entries(spec.models).map(([id, m]: any) => {
                    const on = id in chosen;
                    return (
                      <div
                        key={id}
                        className={`aiide-model-card ${on ? 'on' : ''} ${m.available ? '' : 'off'}`}
                      >
                        <label className="aiide-checkbox">
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={!m.available}
                            onChange={() =>
                              setChosen((c) => {
                                const next = { ...c };
                                if (on) delete next[id];
                                else next[id] = {};
                                return next;
                              })
                            }
                          />
                          <strong>{m.label}</strong>
                          {on && (
                            <span className="aiide-count">{combos(id)}</span>
                          )}
                        </label>
                        <small>
                          {m.available
                            ? m.note
                            : 'Not installed in this environment'}
                        </small>
                        {on &&
                          Object.entries(m.params).map(([p, info]: any) => (
                            <label
                              key={p}
                              className="aiide-param"
                              title={info.help}
                            >
                              <span>
                                {p} <small>{info.help}</small>
                              </span>
                              <input
                                value={grid(id, p)}
                                onChange={(e) =>
                                  setChosen((c) => ({
                                    ...c,
                                    [id]: { ...c[id], [p]: e.target.value },
                                  }))
                                }
                              />
                            </label>
                          ))}
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="aiide-card aiide-launchbar">
                <div
                  className="aiide-chips"
                  role="group"
                  aria-label="Search strategy"
                >
                  <button
                    aria-pressed={search === 'grid'}
                    onClick={() => setSearch('grid')}
                  >
                    Grid search
                  </button>
                  <button
                    aria-pressed={search === 'random'}
                    onClick={() => setSearch('random')}
                  >
                    Random search
                  </button>
                </div>
                {search === 'random' && (
                  <label className="aiide-inline">
                    Trials
                    <input
                      type="number"
                      min={1}
                      max={200}
                      value={randomTrials}
                      onChange={(e) => setRandomTrials(Number(e.target.value))}
                    />
                  </label>
                )}
                <span className="aiide-plan">
                  <strong>{planned}</strong> trial{planned === 1 ? '' : 's'} ·{' '}
                  {Object.keys(chosen).length} model
                  {Object.keys(chosen).length === 1 ? '' : 's'} ·{' '}
                  {validation.type === 'kfold'
                    ? `${validation.folds}-fold CV`
                    : `${Math.round(validation.test_size * 100)}% holdout`}
                  {planned > 200 && (
                    <em> · over 200, use random search or trim the grid</em>
                  )}
                </span>
                <button
                  className="aiide-primary"
                  disabled={Boolean(problem)}
                  aria-describedby={problem ? 'lab-validation' : undefined}
                  onClick={() =>
                    void perform(async () => {
                      const run = await call('lab.sweep', { config: config() });
                      setSweepId(run.id);
                      await refresh();
                      document
                        .querySelector('.aiide-leaderboard')
                        ?.scrollIntoView({ behavior: 'smooth' });
                    })
                  }
                >
                  <i className="codicon codicon-run-all" /> Run sweep
                </button>
                {problem && (
                  <p id="lab-validation" role="status">
                    {problem}
                  </p>
                )}
              </section>
            </>
          )}
        </div>
      )}

      <Leaderboard
        sweeps={sweeps}
        sweep={sweep}
        select={setSweepId}
        call={call}
        perform={perform}
        catalog={catalog}
        refresh={refresh}
        apply={apply}
        openTrace={openTrace}
      />
      <Inference models={models} files={files} call={call} perform={perform} />
    </>
  );
}

function Step({ n, title, text }: { n: number; title: string; text: string }) {
  return (
    <div className="aiide-step-head">
      <span className="aiide-step-n">{n}</span>
      <div>
        <h3>{title}</h3>
        <p>{text}</p>
      </div>
    </div>
  );
}

function Leaderboard({
  sweeps,
  sweep,
  select,
  call,
  perform,
  catalog,
  refresh,
  apply,
  openTrace,
}: {
  sweeps: Run[];
  sweep?: Run;
  select: (id: string) => void;
  call: Call;
  perform: Perform;
  catalog: any;
  refresh: () => Promise<void>;
  apply: (c: Config) => Promise<void>;
  openTrace: (id: string) => void;
}) {
  const [trials, setTrials] = React.useState<any[]>([]),
    [series, setSeries] = React.useState<EventRecord[]>([]),
    [trained, setTrained] = React.useState<Record<number, string>>({});
  React.useEffect(() => {
    if (!sweep) return;
    let active = true;
    const load = async () => {
      const [events, metrics] = await Promise.all([
        call('events.list', { runId: sweep.id, kind: 'trial' }),
        call('training.metrics', { id: sweep.id }),
      ]);
      if (active) {
        setTrials(events.map((e: EventRecord) => e.value));
        setSeries(metrics);
      }
    };
    setTrials([]);
    setTrained({});
    void perform(load);
    const timer = setInterval(() => {
      if (sweep.status === 'running') void load().catch(() => undefined);
    }, 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [sweep?.id, sweep?.status, call]);
  if (!sweeps.length) return null;
  const config = sweep?.lab?.config as Config | undefined;
  const metricSpec = config && catalog?.tasks?.[config.task]?.metrics;
  const higher =
    metricSpec?.[config!.primary]?.higher ??
    ['r2', 'accuracy', 'f1', 'precision', 'recall', 'roc_auc'].includes(
      config?.primary || '',
    );
  const done = trials.filter((t) => t.status === 'completed');
  const ranked = [...done].sort((a, b) =>
    higher
      ? b.scores[config!.primary] - a.scores[config!.primary]
      : a.scores[config!.primary] - b.scores[config!.primary],
  );
  const failed = trials.filter((t) => t.status === 'failed');
  const total = series.find((s) => s.name === 'lab.trials_total')
    ?.value as number;
  const gap = (t: any) => {
    const m = config!.primary,
      val = t.scores[m],
      train = t.train[m];
    const diff = higher ? train - val : val - train;
    return diff / Math.max(Math.abs(val), 1e-9);
  };
  const train = (t: any) =>
    perform(async () => {
      const run = await call('lab.final', {
        config: {
          file: config!.file,
          target: config!.target,
          task: config!.task,
          features: config!.features,
          seed: config!.seed,
          model: t.model,
          params: t.params,
          name: `${t.label} · ${config!.target}`,
          scores: t.scores,
          sweep: sweep!.id,
        },
      });
      setTrained((s) => ({ ...s, [t.trial]: run.id }));
      await refresh();
    });
  return (
    <section className="aiide-card aiide-leaderboard">
      <div className="aiide-row">
        <Step
          n={4}
          title="Leaderboard"
          text="Trials appear as they finish. Train the one you trust on all the data."
        />
        <div className="aiide-toolbar">
          <label className="aiide-inline">
            Sweep
            <select value={sweep?.id} onChange={(e) => select(e.target.value)}>
              {sweeps.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {ago(s.started)} · {s.status}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      {sweep && config && (
        <>
          <div className="aiide-toolbar">
            <span role="status">
              <span className={`aiide-badge ${sweep.status}`}>
                {sweep.status}
              </span>{' '}
              {done.length}
              {total ? ` / ${total}` : ''} trials · {config.file} →{' '}
              {config.target} ({config.task}) · ranked by{' '}
              {metricSpec?.[config.primary]?.label} ·{' '}
              {duration((sweep.ended || Date.now()) - sweep.started)}
            </span>
            {sweep.status === 'running' && (
              <button
                onClick={() =>
                  void perform(async () => {
                    await call('runs.cancel', { id: sweep.id });
                    await refresh();
                  })
                }
              >
                Stop
              </button>
            )}
            <button onClick={() => void apply(config)}>
              <i className="codicon codicon-edit" /> Tweak & re-run
            </button>
            <button
              className="aiide-subtle"
              onClick={() => openTrace(sweep.id)}
            >
              Trace ↗
            </button>
          </div>
          {sweep.status === 'running' && total > 0 && (
            <div
              className="aiide-progress"
              role="progressbar"
              aria-label="Sweep trials completed"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={trials.length}
            >
              <span style={{ width: `${(trials.length / total) * 100}%` }} />
            </div>
          )}
          {sweep.status === 'failed' && !trials.length && (
            <p role="alert">
              The sweep stopped before any trial finished. Open Runs → this
              sweep → Logs for the error.
            </p>
          )}
          {ranked.length > 0 && (
            <div className="aiide-table-wrap">
              <table
                className="aiide-leader"
                aria-label="Model comparison leaderboard"
              >
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Model</th>
                    <th>Hyperparameters</th>
                    {config.metrics.map((m) => (
                      <th key={m}>
                        {metricSpec?.[m]?.label}
                        {m === config.primary && ' ★'}
                      </th>
                    ))}
                    <th>Train vs val</th>
                    <th>Fit</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {ranked.map((t, i) => {
                    const g = gap(t);
                    return (
                      <tr key={t.trial} className={i === 0 ? 'best' : ''}>
                        <td>
                          {i === 0 ? (
                            <i className="codicon codicon-star-full" />
                          ) : (
                            i + 1
                          )}
                        </td>
                        <td>{t.label}</td>
                        <td>
                          <div className="aiide-params">
                            {Object.entries(t.params).map(([k, v]: any) => (
                              <code key={k}>
                                {k}={v}
                              </code>
                            ))}
                          </div>
                        </td>
                        {config.metrics.map((m) => (
                          <td
                            key={m}
                            className={m === config.primary ? 'primary' : ''}
                          >
                            {fmt(t.scores[m])}
                            {config.validation.type === 'kfold' && (
                              <small> ±{fmt(t.std[m])}</small>
                            )}
                          </td>
                        ))}
                        <td>
                          <span
                            className={`aiide-gap ${g > 0.5 ? 'bad' : g > 0.2 ? 'warn' : ''}`}
                            title={`Training ${fmt(t.train[config.primary])} vs validation ${fmt(t.scores[config.primary])}`}
                          >
                            {g > 0.5 ? 'overfit' : g > 0.2 ? 'watch' : 'ok'}{' '}
                            {(g * 100).toFixed(0)}%
                          </span>
                        </td>
                        <td>{duration(t.fit_seconds * 1000)}</td>
                        <td>
                          {trained[t.trial] ? (
                            <button onClick={() => openTrace(trained[t.trial])}>
                              View final run
                            </button>
                          ) : (
                            <button
                              className={i === 0 ? 'aiide-primary' : ''}
                              aria-label={`Train final ${t.label}, trial ${t.trial}`}
                              onClick={() => void train(t)}
                            >
                              Train final
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {failed.map((t) => (
            <p key={t.trial} className="aiide-note" role="alert">
              Trial {t.trial} · {t.label} {JSON.stringify(t.params)} failed:{' '}
              {t.error}
            </p>
          ))}
          {series.some((s) => s.name === `trial.${config.primary}`) && (
            <div className="aiide-sweep-chart">
              <small>
                {metricSpec?.[config.primary]?.label} by trial · dashed: best so
                far
              </small>
              <MetricChart
                values={series.filter(
                  (s) => s.name === `trial.${config.primary}`,
                )}
                compare={series.filter(
                  (s) => s.name === `best.${config.primary}`,
                )}
              />
            </div>
          )}
          <p className="aiide-note">
            Train vs val is a relative score gap, a clue to investigate
            overfitting. Its size depends on the metric and dataset; the labels
            are heuristics. Sweep scores select candidates. Check the final
            choice on untouched test data before deployment.
          </p>
        </>
      )}
    </section>
  );
}

function Inference({
  models,
  files,
  call,
  perform,
}: {
  models: any[];
  files: { file: string }[];
  call: Call;
  perform: Perform;
}) {
  const [path, setPath] = React.useState(''),
    [inputs, setInputs] = React.useState<Record<string, string>>({}),
    [result, setResult] = React.useState<any>(),
    [batchFile, setBatchFile] = React.useState(''),
    [batch, setBatch] = React.useState<any>();
  const model = models.find((m) => m.path === path) || models[0];
  React.useEffect(() => {
    if (!model) return;
    setInputs(
      Object.fromEntries(
        model.features.map((f: any) => [
          f.name,
          String(model.example?.[f.name] ?? ''),
        ]),
      ),
    );
    setResult(undefined);
    setBatch(undefined);
  }, [model?.path]);
  if (!models.length) return null;
  return (
    <section className="aiide-card aiide-inference">
      <Step
        n={5}
        title="Try a trained model"
        text="Fill in the features and predict. Blank fields are treated as missing, just like in training."
      />
      <div className="aiide-form-grid">
        <label>
          Model
          <select value={model.path} onChange={(e) => setPath(e.target.value)}>
            {models.map((m) => (
              <option key={m.path} value={m.path}>
                {m.name} · {ago(m.created * 1000)}
              </option>
            ))}
          </select>
        </label>
        <div className="aiide-model-meta">
          <span className="aiide-badge">{model.task}</span>
          <span>
            {model.label} · predicts <strong>{model.target}</strong> ·{' '}
            {model.rows.toLocaleString()} rows
          </span>
          {Object.entries(model.scores || {}).map(([k, v]: any) => (
            <code key={k}>
              Validation {k} {fmt(v)}
            </code>
          ))}
        </div>
      </div>
      <div className="aiide-feature-form">
        {model.features.map((f: any) => (
          <label key={f.name}>
            <span>
              {f.name}{' '}
              <small>
                {f.type === 'numeric' && f.min !== undefined
                  ? `${fmt(f.min)} – ${fmt(f.max)}`
                  : f.type}
              </small>
            </span>
            {f.type === 'categorical' && f.values?.length ? (
              <select
                value={inputs[f.name] ?? ''}
                onChange={(e) =>
                  setInputs({ ...inputs, [f.name]: e.target.value })
                }
              >
                <option value="">(missing)</option>
                {f.values.map((v: string) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            ) : (
              <input
                value={inputs[f.name] ?? ''}
                placeholder={
                  f.median !== undefined ? `median ${fmt(f.median)}` : ''
                }
                onChange={(e) =>
                  setInputs({ ...inputs, [f.name]: e.target.value })
                }
              />
            )}
          </label>
        ))}
      </div>
      <div className="aiide-toolbar">
        <button
          className="aiide-primary"
          onClick={() =>
            void perform(async () =>
              setResult(
                await call('lab.predict', {
                  model: model.path,
                  rows: [inputs],
                }),
              ),
            )
          }
        >
          <i className="codicon codicon-play" /> Predict
        </button>
        <button
          className="aiide-subtle"
          onClick={() =>
            setInputs(
              Object.fromEntries(
                model.features.map((f: any) => [
                  f.name,
                  f.median !== undefined
                    ? String(f.median)
                    : (f.values?.[0] ?? ''),
                ]),
              ),
            )
          }
        >
          Fill typical values
        </button>
        {result && (
          <div className="aiide-prediction" role="status">
            <small>
              {model.target} · {result.ms} ms
            </small>
            <strong>
              {typeof result.predictions[0].prediction === 'number'
                ? fmt(result.predictions[0].prediction)
                : result.predictions[0].prediction}
            </strong>
            {result.predictions[0].probabilities && (
              <div className="aiide-probs">
                {Object.entries(result.predictions[0].probabilities).map(
                  ([c, p]: any) => (
                    <span key={c}>
                      <i style={{ width: `${p * 100}%` }} />
                      {c} {(p * 100).toFixed(1)}%
                    </span>
                  ),
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <details>
        <summary>Batch predict a CSV</summary>
        <div className="aiide-toolbar">
          <label>
            File with the same feature columns
            <select
              value={batchFile}
              onChange={(e) => setBatchFile(e.target.value)}
            >
              <option value="">Choose a CSV file</option>
              {files.map((f) => (
                <option key={f.file}>{f.file}</option>
              ))}
            </select>
          </label>
          <button
            disabled={!batchFile}
            onClick={() =>
              void perform(async () =>
                setBatch(
                  await call('lab.predict', {
                    model: model.path,
                    file: batchFile,
                  }),
                ),
              )
            }
          >
            Predict file
          </button>
        </div>
        {batch && (
          <p role="status">
            {batch.count.toLocaleString()} predictions in {duration(batch.ms)} →
            saved to <code>{batch.output}</code> (original columns plus
            predicted_{batch.target}).
          </p>
        )}
      </details>
      <p className="aiide-note">
        Saved at <code>{model.path}/model.joblib</code> with its metadata in{' '}
        <code>model.json</code>. Load it in Python with{' '}
        <code>joblib.load(…)</code>; it includes preprocessing.
      </p>
    </section>
  );
}
