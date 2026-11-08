import React from '@theia/core/shared/react';
import type { Connection } from '../common/protocol.js';
import { Call, Perform, Heading, Empty, duration, ago } from './shared.js';
import { TraceView, ScoreChip } from './trace-view.js';

const engineInfo: Record<string, { label: string; note: string }> = {
  transformers: {
    label: 'Built-in (Transformers)',
    note: 'Works everywhere the project trains; serves LoRA adapters directly. Best for quick checks.',
  },
  vllm: {
    label: 'vLLM',
    note: 'High-throughput serving on NVIDIA GPUs (vllm-metal on Apple Silicon). Adapters are merged first.',
  },
  sglang: {
    label: 'SGLang',
    note: 'Fast structured generation on NVIDIA GPUs. Adapters are merged first.',
  },
  mlx: {
    label: 'MLX',
    note: 'Native Apple Silicon serving with mlx-lm. Adapters are merged first.',
  },
};
const scorerInfo: { type: string; label: string; text: string }[] = [
  {
    type: 'contains',
    label: 'Contains',
    text: 'Output contains the expected text',
  },
  {
    type: 'exact',
    label: 'Exact match',
    text: 'Output equals expected (trimmed)',
  },
  { type: 'regex', label: 'Regex', text: 'Output matches a pattern' },
  {
    type: 'json',
    label: 'Valid JSON',
    text: 'Parses; equals expected JSON if given',
  },
  {
    type: 'tool_call',
    label: 'Tool call',
    text: 'Calls expected_tool with matching arguments',
  },
  {
    type: 'python',
    label: 'Python reward',
    text: 'score(output, expected, case, tool_calls) → 0–1',
  },
  {
    type: 'judge',
    label: 'LLM as judge',
    text: 'A model connection grades with your rubric',
  },
  {
    type: 'agent',
    label: 'Agent review',
    text: 'Claude Code or Codex grades over MCP',
  },
];
const defaultRubric =
  'Score how well the response completes the task and agrees with the reference answer when one is given. 1 = fully correct and helpful, 0 = wrong or unhelpful.';
const short = (value: unknown, n = 90) => {
  const text =
    typeof value === 'string'
      ? value
      : Array.isArray(value)
        ? String(
            (value as any[]).filter((m) => m?.role === 'user').at(-1)
              ?.content ?? JSON.stringify(value),
          )
        : value === undefined
          ? ''
          : JSON.stringify(value);
  return text.length > n ? text.slice(0, n) + '…' : text;
};

export function EvalsPanel({
  call,
  perform,
  connections,
  refresh,
  initialModel,
  openTrace,
  openRun,
}: {
  call: Call;
  perform: Perform;
  connections: Connection[];
  refresh: () => Promise<void>;
  initialModel?: string;
  openTrace?: (id: string) => void;
  openRun?: (id: string) => void;
}) {
  const [models, setModels] = React.useState<any[]>([]),
    [engines, setEngines] = React.useState<Record<string, string>>({
      transformers: 'built-in',
    }),
    [servers, setServers] = React.useState<any[]>([]),
    [files, setFiles] = React.useState<{
      datasets: string[];
      scripts: string[];
    }>({ datasets: [], scripts: [] }),
    [experiments, setExperiments] = React.useState<any[]>([]);
  const [model, setModel] = React.useState(initialModel || ''),
    [engine, setEngine] = React.useState('transformers');
  const [dataset, setDataset] = React.useState(''),
    [target, setTarget] = React.useState(''),
    [system, setSystem] = React.useState(''),
    [temperature, setTemperature] = React.useState(0),
    [maxTokens, setMaxTokens] = React.useState(256),
    [thinking, setThinking] = React.useState(false);
  const [enabled, setEnabled] = React.useState<Set<string>>(
      new Set(['contains', 'tool_call']),
    ),
    [pattern, setPattern] = React.useState(''),
    [judge, setJudge] = React.useState(''),
    [rubric, setRubric] = React.useState(defaultRubric),
    [script, setScript] = React.useState('');
  const [selected, setSelected] = React.useState(''),
    [detail, setDetail] = React.useState<any>(),
    [caseIndex, setCaseIndex] = React.useState<number>();
  const [busy, setBusy] = React.useState(false);
  const modelConnections = connections.filter((c) => c.kind === 'model');

  React.useEffect(() => {
    if (initialModel) setModel(initialModel);
  }, [initialModel]);
  React.useEffect(() => {
    void call('hf.status')
      .then((s) => s?.engines && setEngines(s.engines))
      .catch(() => undefined);
  }, [call]);
  React.useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [m, s, f, e] = await Promise.all([
          call('hf.models'),
          call('serving.list'),
          call('evals.files'),
          call('evals.list'),
        ]);
        if (!active) return;
        setModels(m);
        setServers(s);
        setFiles(f);
        setExperiments(e);
        setDataset(
          (d) => d || f.datasets.find((x: string) => /eval/i.test(x)) || '',
        );
        if (s.some((x: any) => x.state === 'ready' && x.connection))
          void refresh();
      } catch {
        /* Shown through actions; polling keeps trying. */
      }
    };
    void load();
    const timer = setInterval(load, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [call]);
  React.useEffect(() => {
    if (!selected) return;
    let active = true;
    const load = async () => {
      const next = await call('evals.get', {
        runId: selected,
        limit: 1000,
      }).catch(() => undefined);
      if (active && next) setDetail(next);
    };
    void load();
    // Keeps polling after completion so agent grades appear as they arrive.
    const timer = setInterval(load, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [selected, call]);

  const toggle = (type: string) => {
    const next = new Set(enabled);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    setEnabled(next);
  };
  const scorers = scorerInfo
    .filter((s) => enabled.has(s.type))
    .map((s) =>
      s.type === 'regex'
        ? { type: 'regex', pattern }
        : s.type === 'judge'
          ? { type: 'judge', connection: judge, rubric }
          : s.type === 'python'
            ? { type: 'python', file: script }
            : s.type === 'agent'
              ? { type: 'agent', rubric }
              : { type: s.type },
    );
  const invalid =
    !dataset ||
    !target ||
    !scorers.length ||
    (enabled.has('regex') && !pattern) ||
    (enabled.has('judge') && !judge) ||
    (enabled.has('python') && !script);
  const act = (fn: () => Promise<unknown>) => {
    setBusy(true);
    void perform(fn).finally(() => setBusy(false));
  };
  const scorerNames: string[] = detail?.scorers?.map((s: any) => s.name) ?? [];
  const pendingAgent = detail?.scorers
    ?.filter((s: any) => s.type === 'agent')
    .reduce(
      (n: number, s: any) => n + (detail.summary.scorers[s.name]?.pending || 0),
      0,
    );
  const current = detail?.cases?.find((c: any) => c.index === caseIndex);

  return (
    <>
      <Heading
        title="Serve & evaluate"
        text="Serve a base or fine-tuned model, run an eval dataset against it, and inspect every case as a trace."
      />

      <section className="aiide-card" aria-labelledby="serve-title">
        <h3 id="serve-title">1. Serve a model</h3>
        <div className="aiide-form-grid">
          <label>
            Model or LoRA adapter
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Choose a model</option>
              {models.map((m) => (
                <option key={m.path} value={m.path}>
                  {m.repo} ·{' '}
                  {m.kind === 'adapter' ? `LoRA (${m.steps} steps)` : 'base'} ·{' '}
                  {m.path.slice(-8)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Inference engine
            <select value={engine} onChange={(e) => setEngine(e.target.value)}>
              {Object.entries(engineInfo).map(([id, info]) => (
                <option key={id} value={id} disabled={!engines[id]}>
                  {info.label}
                  {engines[id] ? '' : ' — not installed'}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="aiide-note">
          {engineInfo[engine].note} Serves an OpenAI-compatible API on 127.0.0.1
          and adds it to your model connections. Install vLLM, SGLang or mlx-lm
          into the project environment (or on PATH) to enable them.
        </p>
        {!models.length && (
          <p className="aiide-note">
            No models yet. Download or fine-tune one in Hugging Face &
            fine-tuning first — or evaluate any existing model connection below.
          </p>
        )}
        <button
          className="aiide-primary"
          disabled={busy || !model || !engines[engine]}
          onClick={() =>
            act(async () => {
              await call('serving.start', { model, engine });
              setServers(await call('serving.list'));
              await refresh();
            })
          }
        >
          <i className="codicon codicon-play" /> Serve model
        </button>
        {servers.length > 0 && (
          <div className="aiide-servers">
            {servers.map((s) => (
              <div key={s.runId} className="aiide-server">
                <span className={`aiide-dot aiide-dot-${s.state}`} />
                <div>
                  <strong>{s.name}</strong>
                  <small>
                    {s.state === 'ready'
                      ? `${s.url} · connection ${s.connection}`
                      : s.state === 'starting'
                        ? 'Loading weights… the first start can take a minute'
                        : `${s.state} ${ago(s.started)}`}
                  </small>
                </div>
                <div className="aiide-actions">
                  {s.state === 'ready' && (
                    <button onClick={() => setTarget(s.connection)}>
                      Evaluate this
                    </button>
                  )}
                  {openRun && (
                    <button onClick={() => openRun(s.runId)}>Logs</button>
                  )}
                  {(s.state === 'ready' || s.state === 'starting') && (
                    <button
                      onClick={() =>
                        act(async () => {
                          await call('runs.cancel', { id: s.runId });
                          await refresh();
                        })
                      }
                    >
                      Stop
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="aiide-card" aria-labelledby="eval-title">
        <h3 id="eval-title">2. Set up an evaluation</h3>
        <div className="aiide-form-grid">
          <label>
            Eval dataset (JSONL)
            <select
              value={dataset}
              onChange={(e) => setDataset(e.target.value)}
            >
              <option value="">Choose a dataset</option>
              {files.datasets.map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </label>
          <label>
            Model to evaluate
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Choose a model connection</option>
              {modelConnections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.id} / {c.model}
                </option>
              ))}
            </select>
          </label>
          <label>
            Temperature
            <input
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={temperature}
              onChange={(e) => setTemperature(Number(e.target.value))}
            />
          </label>
          <label>
            Max output tokens
            <input
              type="number"
              min={1}
              max={8192}
              value={maxTokens}
              onChange={(e) => setMaxTokens(Number(e.target.value))}
            />
          </label>
        </div>
        <label className="aiide-checkbox">
          <input
            type="checkbox"
            checked={thinking}
            onChange={(e) => setThinking(e.target.checked)}
          />
          Let reasoning models think first (Qwen3 thinking mode; slower, uses
          more tokens). Reasoning is shown in traces, never scored.
        </label>
        <label>
          System prompt (optional)
          <textarea
            rows={2}
            value={system}
            onChange={(e) => setSystem(e.target.value)}
          />
        </label>
        <p className="aiide-note">
          One case per line: <code>{'{"input":"…","expected":"…"}'}</code>, or{' '}
          <code>"messages"</code> for multi-turn. For tool use add OpenAI{' '}
          <code>"tools"</code> and{' '}
          <code>{'"expected_tool":{"name":"…","arguments":{…}}'}</code>.{' '}
          <button
            className="aiide-link"
            disabled={busy}
            onClick={() =>
              act(async () => {
                const created = await call('evals.sample');
                setDataset(created.dataset);
                setScript(created.reward);
                setFiles(await call('evals.files'));
              })
            }
          >
            Create a sample dataset & reward
          </button>
        </p>
        <h4>Scorers</h4>
        <div className="aiide-scorers">
          {scorerInfo.map((s) => (
            <button
              key={s.type}
              className="aiide-scorer"
              aria-pressed={enabled.has(s.type)}
              onClick={() => toggle(s.type)}
            >
              <strong>{s.label}</strong>
              <small>{s.text}</small>
            </button>
          ))}
        </div>
        <div className="aiide-form-grid">
          {enabled.has('regex') && (
            <label>
              Regex pattern
              <input
                value={pattern}
                placeholder="^\d+$"
                onChange={(e) => setPattern(e.target.value)}
              />
            </label>
          )}
          {enabled.has('python') && (
            <label>
              Reward file
              <select
                value={script}
                onChange={(e) => setScript(e.target.value)}
              >
                <option value="">Choose a .py file</option>
                {files.scripts.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </label>
          )}
          {enabled.has('judge') && (
            <label>
              Judge model
              <select value={judge} onChange={(e) => setJudge(e.target.value)}>
                <option value="">Choose a model connection</option>
                {modelConnections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id} / {c.model}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {(enabled.has('judge') || enabled.has('agent')) && (
          <label>
            Grading rubric (judge and agent)
            <textarea
              rows={3}
              value={rubric}
              onChange={(e) => setRubric(e.target.value)}
            />
          </label>
        )}
        <button
          className="aiide-primary"
          disabled={busy || invalid}
          onClick={() =>
            act(async () => {
              const run = await call('evals.run', {
                dataset,
                target,
                system: system || undefined,
                temperature,
                maxTokens,
                thinking,
                scorers,
              });
              setSelected(run.id);
              setCaseIndex(undefined);
              await refresh();
            })
          }
        >
          <i className="codicon codicon-beaker" /> Run evaluation
        </button>
      </section>

      <section className="aiide-card" aria-labelledby="exp-title">
        <h3 id="exp-title">3. Experiments</h3>
        {!experiments.length ? (
          <Empty>Run an evaluation to compare models here.</Empty>
        ) : (
          <div className="aiide-table-wrap">
            <table aria-label="Evaluation experiments">
              <thead>
                <tr>
                  <th>Experiment</th>
                  <th>Model</th>
                  <th>Progress</th>
                  <th>Scores</th>
                  <th>p50 latency</th>
                  <th>Tokens</th>
                </tr>
              </thead>
              <tbody>
                {experiments.map((e) => (
                  <tr
                    key={e.runId}
                    className={`aiide-clickable ${selected === e.runId ? 'selected' : ''}`}
                    tabIndex={0}
                    onClick={() => {
                      setSelected(e.runId);
                      setCaseIndex(undefined);
                    }}
                    onKeyDown={(k) => {
                      if (k.key === 'Enter') setSelected(e.runId);
                    }}
                  >
                    <td>
                      <strong>{e.name}</strong>
                      <br />
                      <small>{ago(e.started)}</small>
                    </td>
                    <td>
                      <code>{e.target.connection}</code>
                    </td>
                    <td>
                      <span className={`aiide-badge ${e.status}`}>
                        {e.status}
                      </span>{' '}
                      {e.summary.done}/{e.total}
                    </td>
                    <td>
                      <div className="aiide-score-bars">
                        {Object.entries(e.summary.scorers).map(
                          ([name, s]: any) => (
                            <span key={name} title={name}>
                              <small>{name}</small>
                              <span className="aiide-bar">
                                <span
                                  style={{
                                    width: `${(s.mean ?? 0) * 100}%`,
                                  }}
                                />
                              </span>
                              <b>
                                {s.mean === null
                                  ? s.pending
                                    ? 'pending'
                                    : '—'
                                  : s.mean.toFixed(2)}
                              </b>
                            </span>
                          ),
                        )}
                      </div>
                    </td>
                    <td>{duration(e.summary.latency.p50)}</td>
                    <td>
                      {(
                        e.summary.tokens.input + e.summary.tokens.output
                      ).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {detail && (
        <section className="aiide-card" aria-labelledby="result-title">
          <div className="aiide-section-title">
            <div>
              <h3 id="result-title">{detail.name}</h3>
              <p>
                {detail.target.connection} · {detail.target.model} ·{' '}
                {detail.dataset} · {detail.summary.done}/{detail.total} cases
                {detail.summary.errors
                  ? ` · ${detail.summary.errors} errors`
                  : ''}
              </p>
            </div>
            <div className="aiide-section-actions">
              {detail.status === 'running' && (
                <button
                  onClick={() =>
                    act(() => call('runs.cancel', { id: detail.runId }))
                  }
                >
                  Cancel
                </button>
              )}
              {openTrace && (
                <button onClick={() => openTrace(detail.runId)}>
                  All traces
                </button>
              )}
            </div>
          </div>
          <div className="aiide-stats">
            {scorerNames.map((name) => {
              const s = detail.summary.scorers[name];
              return (
                <div key={name}>
                  <small>{name.toUpperCase()}</small>
                  <strong>
                    {s.mean === null ? '—' : `${Math.round(s.mean * 100)}%`}
                  </strong>
                  <small>
                    {s.count} scored{s.pending ? ` · ${s.pending} pending` : ''}
                  </small>
                </div>
              );
            })}
          </div>
          {pendingAgent > 0 && detail.status !== 'running' && (
            <div className="aiide-callout">
              <i className="codicon codicon-hubot" />
              <div>
                <strong>
                  {pendingAgent} case(s) waiting for your coding agent
                </strong>
                <p>
                  Connect Claude Code or Codex in Build → External agents with
                  workflow permission, then ask it:
                </p>
                <code className="aiide-copy">
                  Grade AIIDE evaluation {detail.runId}: read cases with
                  run_workflow evals.get, judge each against the rubric, and
                  submit scores with evals.score.
                </code>
              </div>
            </div>
          )}
          <div className="aiide-table-wrap">
            <table className="aiide-cases" aria-label="Evaluation cases">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th>Reference</th>
                  {scorerNames.map((n) => (
                    <th key={n}>{n}</th>
                  ))}
                  <th>Latency</th>
                </tr>
              </thead>
              <tbody>
                {detail.cases.map((c: any) => (
                  <tr
                    key={c.index}
                    tabIndex={0}
                    className={`aiide-clickable ${caseIndex === c.index ? 'selected' : ''}`}
                    onClick={() => setCaseIndex(c.index)}
                    onKeyDown={(k) => {
                      if (k.key === 'Enter') setCaseIndex(c.index);
                    }}
                  >
                    <td>{c.id ?? c.index + 1}</td>
                    <td>{short(c.input)}</td>
                    <td>
                      {c.error ? (
                        <span className="aiide-danger">{short(c.error)}</span>
                      ) : (
                        <>
                          {short(c.output?.content, 120)}
                          {c.output?.tool_calls?.map((t: any, i: number) => (
                            <code key={i} className="aiide-tool-chip">
                              <i className="codicon codicon-tools" />{' '}
                              {t.function?.name}
                            </code>
                          ))}
                        </>
                      )}
                    </td>
                    <td>{short(c.expected, 60)}</td>
                    {scorerNames.map((n) => (
                      <td key={n} title={c.scores[n]?.reason}>
                        {c.scores[n]?.skipped ? (
                          <small>n/a</small>
                        ) : (
                          <ScoreChip
                            score={c.scores[n]?.score}
                            pending={c.scores[n]?.pending}
                          />
                        )}
                      </td>
                    ))}
                    <td>{duration(c.latencyMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {current ? (
            <>
              <h4>Trace · case {current.id ?? current.index + 1}</h4>
              <TraceView key={current.traceId} nodes={current.trace} />
            </>
          ) : (
            detail.cases.length > 0 && (
              <p className="aiide-note">
                Select a case to open its trace: model call, tool calls and
                every scorer's verdict.
              </p>
            )
          )}
        </section>
      )}
    </>
  );
}
