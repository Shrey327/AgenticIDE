import React from '@theia/core/shared/react';
import type { Run, Connection } from '../common/protocol.js';
import { Call, Perform, ago, duration } from './shared.js';

const templates = [
  {
    id: 'python',
    icon: 'beaker',
    title: 'Instrumented Python',
    text: 'Minimal traced pipeline. No model needed.',
  },
  {
    id: 'langgraph',
    icon: 'hubot',
    title: 'LangGraph agent',
    text: 'Tool-using agent graph with node tracing.',
  },
  {
    id: 'rag',
    icon: 'database',
    title: 'LangChain + Qdrant RAG',
    text: 'Ingest, retrieve, answer, evaluate.',
  },
  {
    id: 'pytorch',
    icon: 'pulse',
    title: 'PyTorch training',
    text: 'Training loop with metrics and checkpoint resume.',
  },
  {
    id: 'finetune',
    icon: 'wand',
    title: 'PEFT fine-tuning',
    text: 'LoRA fine-tune a local model.',
  },
  {
    id: 'sklearn',
    icon: 'graph-line',
    title: 'scikit-learn experiment',
    text: 'Classic ML experiment with tracked metrics.',
  },
];

type Step = {
  label: string;
  done: boolean;
  tab?: string;
  template?: string;
};

export function Overview({
  project,
  runs,
  status,
  connections,
  call,
  perform,
  created,
  go,
  openRun,
  openTrace,
}: {
  project: any;
  runs: Run[];
  status: any;
  connections: Connection[];
  call: Call;
  perform: Perform;
  created: (root: string) => Promise<void>;
  go: (tab: string) => void;
  openRun: (id: string) => void;
  openTrace: (id: string) => void;
}) {
  const [template, setTemplate] = React.useState('langgraph'),
    [name, setName] = React.useState('my-ai-project');
  const [integration, setIntegration] = React.useState('langgraph'),
    [plan, setPlan] = React.useState<any>();
  const createRef = React.useRef<HTMLElement>(null);
  const pickTemplate = (id: string) => {
    setTemplate(id);
    setName(`my-${id}-project`);
    createRef.current?.scrollIntoView({ block: 'start' });
    createRef.current?.querySelector<HTMLInputElement>('input')?.focus();
  };

  const models = connections.filter((c) => c.kind === 'model');
  const can = (cap: string) => models.some((c) => c.capabilities?.[cap]);
  const frameworks: string[] = project.environment.frameworks;
  const commands = Object.keys(project.config.commands);
  const done = (r: Run) => r.status === 'completed';
  const setupOk =
    !commands.includes('setup') ||
    runs.some((r) => r.name === 'setup' && done(r));
  const training = runs.filter((r) => r.training);
  const ragRuns = (name: string) => runs.some((r) => r.name === name);
  const workflows: {
    id: string;
    icon: string;
    title: string;
    text: string;
    tab: string;
    cta: string;
    steps: Step[];
  }[] = [
    {
      id: 'train',
      icon: 'pulse',
      title: 'Train a model',
      text: 'Compare models and hyperparameters on a CSV without code, then train and test the winner.',
      tab: 'Lab',
      cta: 'Open experiment lab',
      steps: [
        {
          label: 'Environment ready (run setup)',
          done: setupOk,
          tab: 'Runs',
        },
        {
          label: 'Run a model sweep',
          done: runs.some((r) => r.lab?.kind === 'sweep' && done(r)),
          tab: 'Lab',
        },
        {
          label: 'Train the best model',
          done:
            runs.some((r) => r.lab?.kind === 'final' && done(r)) ||
            training.length > 0,
          tab: 'Lab',
        },
        {
          label: 'Custom training script (PyTorch, Trainer…)',
          done:
            training.length > 0 ||
            ['torch', 'transformers'].some((f) => frameworks.includes(f)),
          template: 'pytorch',
        },
      ],
    },
    {
      id: 'agent',
      icon: 'hubot',
      title: 'Build an agent',
      text: 'Tool-using LangGraph agents, traced node by node back to your code.',
      tab: 'Traces',
      cta: 'Open traces',
      steps: [
        {
          label: 'Connect a chat model',
          done: models.length > 0,
          tab: 'Models',
        },
        { label: 'Verify tool calling', done: can('tools'), tab: 'Models' },
        {
          label: 'LangGraph / LangChain project',
          done: frameworks.some((f) => f.startsWith('lang')),
          template: 'langgraph',
        },
        {
          label: 'Run it and inspect the trace',
          done: runs.some((r) => done(r) && !r.training && r.name !== 'setup'),
          tab: 'Runs',
        },
      ],
    },
    {
      id: 'rag',
      icon: 'database',
      title: 'Build a RAG pipeline',
      text: 'Chunk and embed documents, test retrieval, evaluate on a dataset.',
      tab: 'RAG',
      cta: 'Open RAG',
      steps: [
        {
          label: 'Embedding model connected',
          done: can('embeddings'),
          tab: 'Models',
        },
        {
          label: 'Vector database (Qdrant)',
          done: connections.some((c) => c.kind === 'qdrant'),
          tab: 'RAG',
        },
        { label: 'Ingest a document', done: ragRuns('rag.ingest'), tab: 'RAG' },
        {
          label: 'Query and evaluate',
          done: ragRuns('rag.query') || ragRuns('evaluations.rag'),
          tab: 'RAG',
        },
      ],
    },
    {
      id: 'inference',
      icon: 'server-process',
      title: 'Run model inference',
      text: 'Connect Ollama, vLLM, or any OpenAI-compatible API and try prompts.',
      tab: 'Models',
      cta: 'Open playground',
      steps: [
        {
          label: 'Connect a model endpoint',
          done: models.length > 0,
          tab: 'Models',
        },
        { label: 'Test capabilities', done: can('chat'), tab: 'Models' },
        {
          label: 'Set default model for templates',
          done: Boolean(project.config.services?.chat),
          tab: 'Settings',
        },
      ],
    },
  ];
  const recent = runs.slice(0, 6);
  const running = runs.filter((r) => r.status === 'running').length;
  const failed = runs.filter((r) => r.status === 'failed').length;

  return (
    <>
      <div className="aiide-section-title">
        <div>
          <h2>{runs.length ? 'Welcome back' : 'What are you working on?'}</h2>
          <p>
            Pick a workflow. Each card tracks what is set up in this project and
            links to the next step.
          </p>
        </div>
        <div className="aiide-stat-pills">
          <button className="aiide-pill" onClick={() => go('Runs')}>
            <strong>{runs.length}</strong> runs
          </button>
          <button className="aiide-pill" onClick={() => go('Runs')}>
            <span className={`aiide-dot ${running ? 'warn' : 'idle'}`} />
            <strong>{running}</strong> running
          </button>
          {failed > 0 && (
            <button className="aiide-pill" onClick={() => go('Runs')}>
              <span className="aiide-dot error" />
              <strong>{failed}</strong> failed
            </button>
          )}
          <button className="aiide-pill" onClick={() => go('Models')}>
            <strong>{models.length}</strong> models
          </button>
        </div>
      </div>

      <div className="aiide-workflows">
        {workflows.map((w) => {
          const complete = w.steps.filter((s) => s.done).length;
          const next = w.steps.find((s) => !s.done);
          return (
            <section className="aiide-card aiide-workflow" key={w.id}>
              <div className="aiide-workflow-head">
                <i className={`codicon codicon-${w.icon}`} />
                <div>
                  <h3>{w.title}</h3>
                  <p>{w.text}</p>
                </div>
              </div>
              <div
                className="aiide-progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={w.steps.length}
                aria-valuenow={complete}
                aria-label={`${w.title}: ${complete} of ${w.steps.length} steps done`}
              >
                <span
                  style={{ width: `${(complete / w.steps.length) * 100}%` }}
                />
              </div>
              <ol className="aiide-steps">
                {w.steps.map((s) => (
                  <li key={s.label} className={s.done ? 'done' : ''}>
                    <i
                      className={`codicon codicon-${s.done ? 'pass-filled' : 'circle-large-outline'}`}
                    />
                    <button
                      className="aiide-link"
                      aria-label={`${s.label}: ${s.done ? 'complete' : 'not complete'}`}
                      onClick={() =>
                        s.template ? pickTemplate(s.template) : go(s.tab!)
                      }
                    >
                      {s.label}
                    </button>
                  </li>
                ))}
              </ol>
              <div className="aiide-workflow-foot">
                <small>
                  {complete}/{w.steps.length} done
                  {next ? ` · next: ${next.label.toLowerCase()}` : ' · ready'}
                </small>
                <button
                  className={next ? '' : 'aiide-primary'}
                  onClick={() => go(w.tab)}
                >
                  {w.cta} <i className="codicon codicon-arrow-right" />
                </button>
              </div>
            </section>
          );
        })}
      </div>

      <section className="aiide-card">
        <div className="aiide-row">
          <h3>Recent runs</h3>
          <button className="aiide-subtle" onClick={() => go('Runs')}>
            View previous runs <i className="codicon codicon-arrow-right" />
          </button>
        </div>
        {recent.length ? (
          <div className="aiide-recent">
            {recent.map((r) => (
              <div className="aiide-recent-row" key={r.id}>
                <span className={`aiide-badge ${r.status}`}>{r.status}</span>
                <button className="aiide-link" onClick={() => openRun(r.id)}>
                  {r.name}
                </button>
                <small>
                  {r.training ? `training · ${r.training.target}` : 'run'}
                </small>
                <small>{ago(r.started)}</small>
                <small>{duration((r.ended || Date.now()) - r.started)}</small>
                <button
                  className="aiide-subtle"
                  aria-label={`Trace for ${r.name}`}
                  onClick={() => openTrace(r.id)}
                >
                  Trace ↗
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p>
            No runs yet.{' '}
            {commands.length ? (
              <>
                This project defines{' '}
                <span className="aiide-mono">{commands.join(', ')}</span>.{' '}
                <button className="aiide-link" onClick={() => go('Runs')}>
                  Run one →
                </button>
              </>
            ) : (
              'Add named commands in Settings, or create a project from a template below.'
            )}
          </p>
        )}
      </section>

      <section className="aiide-card" ref={createRef}>
        <span className="aiide-eyebrow">START SOMETHING NEW</span>
        <h3>Create a project from a template</h3>
        <p>
          Every template ships with tracing, an evaluation example, and a
          locked, isolated Python environment.
        </p>
        <div
          className="aiide-templates"
          role="group"
          aria-label="Project template"
        >
          {templates.map((t) => (
            <button
              key={t.id}
              aria-pressed={template === t.id}
              className="aiide-template"
              onClick={() => {
                setTemplate(t.id);
                setName(`my-${t.id}-project`);
              }}
            >
              <i className={`codicon codicon-${t.icon}`} />
              <strong>{t.title}</strong>
              <small>{t.text}</small>
            </button>
          ))}
        </div>
        <div className="aiide-toolbar">
          <label>
            Folder name (created inside the open folder)
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <button
            className="aiide-primary"
            disabled={!name}
            onClick={() =>
              void perform(async () => {
                const result = await call('project.create', { template, name });
                await created(result.root);
              })
            }
          >
            Create project →
          </button>
        </div>
      </section>

      <div className="aiide-columns">
        <details className="aiide-card">
          <summary>Project environment</summary>
          <dl>
            <dt>Python</dt>
            <dd>{project.environment.python}</dd>
            <dt>Package manager</dt>
            <dd>{project.environment.manager}</dd>
            <dt>Detected frameworks</dt>
            <dd>{frameworks.join(', ') || 'Generic Python'}</dd>
            <dt>Dependency files</dt>
            <dd>
              {project.environment.locks.join(', ') || 'No lockfile detected'}
            </dd>
            <dt>Commands</dt>
            <dd className="aiide-mono">{commands.join(', ') || '—'}</dd>
            <dt>Telemetry</dt>
            <dd>{status.collector}</dd>
          </dl>
        </details>
        <details className="aiide-card">
          <summary>Add an integration to this project</summary>
          <p>
            Stages dependency and lockfile changes plus an instrumentation
            helper. Nothing installs until you review and apply.
          </p>
          <div className="aiide-toolbar">
            <label>
              Integration
              <select
                value={integration}
                onChange={(e) => setIntegration(e.target.value)}
              >
                {[
                  'langgraph',
                  'langchain',
                  'qdrant',
                  'sklearn',
                  'pytorch',
                  'finetune',
                  'wandb',
                ].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <button
              onClick={() =>
                void perform(async () =>
                  setPlan(
                    await call('integrations.prepare', { name: integration }),
                  ),
                )
              }
            >
              Prepare dependency changes
            </button>
          </div>
          {plan && (
            <>
              {plan.files.map((f: any) => (
                <details key={f.file}>
                  <summary>{f.file}</summary>
                  <div className="aiide-columns">
                    <pre className="aiide-json">{f.before || '(new file)'}</pre>
                    <pre className="aiide-json">{f.after}</pre>
                  </div>
                </details>
              ))}
              <button
                className="aiide-primary"
                onClick={() =>
                  void perform(async () => {
                    await call('integrations.apply', {
                      id: plan.id,
                      reviewHash: plan.reviewHash,
                    });
                    setPlan(undefined);
                  })
                }
              >
                Apply reviewed changes & install
              </button>
            </>
          )}
        </details>
      </div>
    </>
  );
}
