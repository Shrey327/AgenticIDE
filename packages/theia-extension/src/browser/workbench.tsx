import { Overview } from './overview.js';
import { RunsPanel } from './runs-panel.js';
import { TracePanel } from './trace-panel.js';
import { ModelsPanel } from './models-panel.js';
import { RagPanel } from './rag-panel.js';
import { AssistantPanel } from './assistant-panel.js';
import { TrainingPanel } from './training-panel.js';
import { LabPanel } from './lab-panel.js';
import { FinetunePanel } from './finetune-panel.js';
import { SettingsPanel } from './settings-panel.js';
import { AgentAccessPanel } from './agent-access-panel.js';
import { Call, format, Heading } from './shared.js';
import { CommandService } from '@theia/core/lib/common';
import { WorkspaceCommands } from '@theia/workspace/lib/browser/workspace-commands';
import React from '@theia/core/shared/react';
import {
  inject,
  injectable,
  postConstruct,
} from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { WorkspaceTrustService } from '@theia/workspace/lib/browser/workspace-trust-service';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import URI from '@theia/core/lib/common/uri';
import { EngineeringService, Run, Connection } from '../common/protocol.js';

type NavItem = { id: string; label: string; icon: string; group?: string };
const nav: NavItem[] = [
  { id: 'Overview', label: 'Home', icon: 'home' },
  {
    id: 'Models',
    label: 'Models & playground',
    icon: 'server-process',
    group: 'Build',
  },
  { id: 'RAG', label: 'RAG pipelines', icon: 'database', group: 'Build' },
  {
    id: 'Assistant',
    label: 'Coding assistant',
    icon: 'sparkle',
    group: 'Build',
  },
  { id: 'Agents', label: 'External agents', icon: 'plug', group: 'Build' },
  { id: 'Lab', label: 'Experiment lab', icon: 'graph-scatter', group: 'Train' },
  {
    id: 'Finetune',
    label: 'Hugging Face & fine-tuning',
    icon: 'hubot',
    group: 'Train',
  },
  { id: 'Training', label: 'Training jobs', icon: 'pulse', group: 'Train' },
  { id: 'Runs', label: 'Runs', icon: 'history', group: 'Observe' },
  { id: 'Traces', label: 'Traces', icon: 'list-tree', group: 'Observe' },
];

@injectable()
export class EngineeringWidget extends ReactWidget {
  static readonly ID = 'aiide.workbench';
  @inject(EngineeringService) protected readonly service!: EngineeringService;
  @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
  @inject(WorkspaceTrustService)
  protected readonly trust!: WorkspaceTrustService;
  @inject(EditorManager) protected readonly editors!: EditorManager;
  @inject(CommandService) protected readonly commands!: CommandService;
  private root = '';
  /** Already-trusted projects open straight into the workspace. */
  private autoOpen?: boolean;
  protected onActivateRequest() {
    this.node.focus();
  }
  @postConstruct() protected init() {
    this.id = EngineeringWidget.ID;
    this.title.label = 'AI Engineering';
    this.title.caption = 'AI Engineering workspace';
    this.node.tabIndex = 0;
    this.title.closable = true;
    this.title.iconClass = 'codicon codicon-beaker';
    this.addClass('aiide-widget');
    const refresh = async () => {
      this.root = (await this.workspace.roots)[0]?.resource.path.fsPath() || '';
      this.autoOpen = undefined;
      this.update();
      this.autoOpen = Boolean(
        this.root && (await this.trust.getWorkspaceTrust()),
      );
      this.update();
    };
    this.toDispose.push(
      this.workspace.onWorkspaceChanged(() => {
        void refresh();
      }),
    );
    void refresh();
  }
  protected render() {
    if (this.autoOpen === undefined)
      return <div className="aiide aiide-loading">Loading workspace…</div>;
    return (
      <Workbench
        key={this.root}
        initialRoot={this.root}
        autoOpen={this.autoOpen}
        service={this.service}
        chooseProject={async (recent) => {
          await this.commands.executeCommand(
            recent
              ? WorkspaceCommands.OPEN_RECENT_WORKSPACE.id
              : WorkspaceCommands.OPEN_FOLDER.id,
          );
        }}
        openProject={async (root) => {
          await this.workspace.openWorkspace(new URI(root).withScheme('file'), {
            preserveWindow: true,
          });
        }}
        trusted={async () =>
          (await this.trust.getWorkspaceTrust()) ||
          Boolean(await this.trust.requestWorkspaceTrust())
        }
        source={async (file, line) => {
          await this.editors.open(new URI(file).withScheme('file'), {
            selection: { start: { line: Math.max(0, line - 1), character: 0 } },
          });
        }}
        selection={() =>
          this.editors.currentEditor?.editor.document.getText(
            this.editors.currentEditor.editor.selection,
          ) || ''
        }
      />
    );
  }
}

function Workbench({
  initialRoot,
  autoOpen,
  service,
  trusted,
  source,
  selection,
  openProject,
  chooseProject,
}: {
  initialRoot: string;
  autoOpen: boolean;
  service: EngineeringService;
  trusted: () => Promise<boolean>;
  source: (file: string, line: number) => Promise<void>;
  selection: () => string;
  openProject: (root: string) => Promise<void>;
  chooseProject: (recent: boolean) => Promise<void>;
}) {
  const [root, setRoot] = React.useState(initialRoot),
    [connected, setConnected] = React.useState(false);
  const [tab, setTab] = React.useState('Overview'),
    [error, setError] = React.useState(''),
    [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState<any>(),
    [project, setProject] = React.useState<any>(),
    [runs, setRuns] = React.useState<Run[]>([]);
  const [connections, setConnections] = React.useState<Connection[]>([]),
    [runId, setRunId] = React.useState('');
  const [context, setContext] = React.useState('');
  const call: Call = React.useCallback(
    async (operation, args) =>
      service.request({ workspace: root, operation, args }),
    [root, service],
  );
  const perform = React.useCallback(async (fn: () => Promise<unknown>) => {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(String(e).replace(/^Error: /, ''));
    } finally {
      setBusy(false);
    }
  }, []);
  const refresh = React.useCallback(async () => {
    const [status, project, runs, connections] = await Promise.all([
      call('status'),
      call('project.get'),
      call('runs.list'),
      call('connections.list'),
    ]);
    setStatus(status);
    setProject(project);
    setRuns(runs);
    setConnections(connections);
  }, [call]);
  React.useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    const timer = setInterval(() => {
      if (!cancelled)
        void call('runs.list')
          .then(setRuns)
          .catch((e) => setError(String(e)));
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [connected, call]);
  const connect = () =>
    perform(async () => {
      if (!(await trusted()))
        throw new Error(
          'Trust this workspace to enable project execution and local services',
        );
      await refresh();
      setConnected(true);
    });
  const content = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (content.current) {
      content.current.scrollTop = 0;
      content.current.querySelector<HTMLElement>('main')?.focus();
    }
  }, [tab]);
  const [opening, setOpening] = React.useState(autoOpen);
  React.useEffect(() => {
    if (autoOpen) void connect().finally(() => setOpening(false));
  }, []);
  const attach = (value: unknown) => {
    setContext(format(value));
    setTab('Assistant');
  };
  const activeRun = runs.find((r) => r.id === runId);
  const running = runs.filter((r) => r.status === 'running').length;
  const collectorUp = String(status?.collector || '').startsWith(
    'Collector running',
  );
  const openTrace = (id: string) => {
    setRunId(id);
    setTab('Traces');
  };
  const openRun = (id: string) => {
    setRunId(id);
    setTab('Runs');
  };
  if (opening && !connected)
    return <div className="aiide aiide-loading">Opening workspace…</div>;
  if (!connected)
    return (
      <div className="aiide" aria-busy={busy}>
        {error && <ErrorBanner error={error} clear={() => setError('')} />}
        <Welcome
          root={root}
          busy={busy}
          connect={() => void connect()}
          choose={(recent) => void perform(() => chooseProject(recent))}
        />
      </div>
    );
  const groups = [...new Set(nav.map((n) => n.group))];
  const item = (n: NavItem) => (
    <button
      key={n.id}
      data-tab={n.id}
      title={n.label}
      aria-label={n.label}
      aria-current={tab === n.id ? 'page' : undefined}
      onClick={() => setTab(n.id)}
    >
      <i aria-hidden="true" className={`codicon codicon-${n.icon}`} />
      <span className="aiide-nav-label">{n.label}</span>
      {n.id === 'Runs' && running > 0 && (
        <span className="aiide-nav-count" title={`${running} running`}>
          {running}
        </span>
      )}
    </button>
  );
  return (
    <div className="aiide aiide-app" aria-busy={busy}>
      <aside className="aiide-sidebar">
        <div className="aiide-brand">
          <i className="codicon codicon-beaker" />
          <span className="aiide-nav-label">AI Engineering</span>
        </div>
        <div className="aiide-project-chip" title={root}>
          <div className="aiide-nav-label">
            <strong>{project?.config.name || 'Workspace'}</strong>
            <small>{root.split('/').slice(-2).join('/')}</small>
          </div>
          <button
            className="aiide-icon-button"
            title="Refresh"
            aria-label="Refresh workspace data"
            onClick={() => void perform(refresh)}
          >
            <i
              className={`codicon codicon-refresh ${busy ? 'codicon-modifier-spin' : ''}`}
            />
          </button>
        </div>
        <nav className="aiide-tabs" aria-label="Engineering panels">
          {groups.map((g) => (
            <React.Fragment key={g || 'top'}>
              {g && <div className="aiide-nav-group">{g}</div>}
              {nav.filter((n) => n.group === g).map(item)}
            </React.Fragment>
          ))}
          <div className="aiide-nav-spacer" />
          {item({ id: 'Settings', label: 'Settings', icon: 'settings-gear' })}
        </nav>
        <div
          className="aiide-sidebar-foot aiide-nav-label"
          title={status?.collector}
        >
          <span>
            <span className={`aiide-dot ${collectorUp ? '' : 'warn'}`} />
            {collectorUp ? 'Telemetry connected' : 'Local receiver'}
          </span>
          <span>
            {((status?.storageBytes || 0) / 1024 / 1024).toFixed(1)} MB ·{' '}
            {status?.dropped || 0} dropped · capture{' '}
            {project?.config.telemetry.captureContent ? 'on' : 'off'}
          </span>
        </div>
      </aside>
      <div className="aiide-content" ref={content}>
        {error && <ErrorBanner error={error} clear={() => setError('')} />}
        <main
          className="aiide-main"
          data-page={tab}
          tabIndex={-1}
          aria-label={nav.find((n) => n.id === tab)?.label || tab}
        >
          {tab === 'Overview' && (
            <Overview
              project={project}
              runs={runs}
              status={status}
              connections={connections}
              call={call}
              perform={perform}
              go={setTab}
              openRun={openRun}
              openTrace={openTrace}
              created={async (next: string) => {
                await openProject(next);
                setRoot(next);
                setConnected(false);
                setProject(undefined);
                setRuns([]);
                setRunId('');
              }}
            />
          )}
          {tab === 'Runs' && (
            <RunsPanel
              runs={runs}
              project={project}
              call={call}
              perform={perform}
              selected={runId}
              select={setRunId}
              inspect={openTrace}
              refresh={refresh}
              attach={attach}
            />
          )}
          {tab === 'Traces' && (
            <TracePanel
              run={activeRun}
              runs={runs}
              select={setRunId}
              call={call}
              perform={perform}
              source={source}
              attach={attach}
            />
          )}
          {tab === 'Models' && (
            <ModelsPanel
              connections={connections}
              call={call}
              perform={perform}
              refresh={refresh}
            />
          )}
          {tab === 'RAG' && (
            <RagPanel
              connections={connections}
              call={call}
              perform={perform}
              refresh={refresh}
              attach={attach}
            />
          )}
          {tab === 'Assistant' && (
            <AssistantPanel
              connections={connections}
              call={call}
              perform={perform}
              context={context}
              setContext={setContext}
              selection={selection}
            />
          )}
          {tab === 'Agents' && (
            <>
              <Heading
                title="External coding agents"
                text="Let Codex or Claude Code diagnose failures, prepare staged fixes, and run local setup, training, and inference with workflow permission."
              />
              <AgentAccessPanel call={call} perform={perform} />
            </>
          )}
          {tab === 'Lab' && (
            <LabPanel
              runs={runs}
              call={call}
              perform={perform}
              refresh={refresh}
              openTrace={openTrace}
            />
          )}
          {tab === 'Training' && (
            <TrainingPanel
              project={project}
              connections={connections}
              refresh={refresh}
              runs={runs}
              selected={runId}
              select={setRunId}
              call={call}
              perform={perform}
            />
          )}
          {tab === 'Finetune' && (
            <FinetunePanel
              call={call}
              perform={perform}
              runs={runs}
              select={setRunId}
              refresh={refresh}
              openRun={openRun}
            />
          )}
          {tab === 'Settings' && (
            <SettingsPanel
              project={project}
              status={status}
              call={call}
              perform={perform}
              refresh={refresh}
              connections={connections}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function ErrorBanner({ error, clear }: { error: string; clear: () => void }) {
  return (
    <div className="aiide-error" role="alert">
      <i className="codicon codicon-error" />
      <span>{error}</span>
      <button aria-label="Dismiss error" onClick={clear}>
        ×
      </button>
    </div>
  );
}

const capabilities = [
  {
    icon: 'pulse',
    title: 'Train models',
    text: 'Local or SSH jobs, live loss curves, checkpoint resume, W&B.',
  },
  {
    icon: 'hubot',
    title: 'Build agents',
    text: 'LangGraph agents with tools, traced step by step back to code.',
  },
  {
    icon: 'database',
    title: 'RAG pipelines',
    text: 'Chunk, embed, retrieve, and evaluate against a dataset.',
  },
  {
    icon: 'server-process',
    title: 'Model inference',
    text: 'Connect Ollama or any OpenAI-compatible API and try prompts.',
  },
];

function Welcome({
  root,
  busy,
  connect,
  choose,
}: {
  root: string;
  busy: boolean;
  connect: () => void;
  choose: (recent: boolean) => void;
}) {
  return (
    <div className="aiide-welcome">
      <span className="aiide-eyebrow">
        <i className="codicon codicon-beaker" /> AI ENGINEERING · PREVIEW 0.2.1
      </span>
      <h2>Train, build, and debug AI systems in one place.</h2>
      <p>
        Runs, traces, models, RAG, and training live next to your code. Data
        stays on this device in a private <code>.aiide</code> folder.
      </p>
      <div className="aiide-welcome-actions">
        {root ? (
          <>
            <button
              className="aiide-primary aiide-large"
              disabled={busy}
              onClick={connect}
            >
              Open engineering workspace <span>→</span>
            </button>
            <span className="aiide-mono aiide-muted">{root}</span>
          </>
        ) : (
          <button
            className="aiide-primary aiide-large"
            disabled={busy}
            onClick={() => choose(false)}
          >
            <i className="codicon codicon-folder-opened" /> Open folder…
          </button>
        )}
        <div className="aiide-welcome-links">
          {root && (
            <button
              className="aiide-subtle"
              disabled={busy}
              onClick={() => choose(false)}
            >
              Open folder…
            </button>
          )}
          <button
            className="aiide-subtle"
            disabled={busy}
            onClick={() => choose(true)}
          >
            Open recent…
          </button>
        </div>
      </div>
      {root && (
        <p className="aiide-note">
          You will be asked to trust this folder once. That enables running its
          commands and local services.
        </p>
      )}
      <div className="aiide-feature-grid">
        {capabilities.map((c) => (
          <section className="aiide-card" key={c.title}>
            <i className={`codicon codicon-${c.icon} aiide-feature-icon`} />
            <h3>{c.title}</h3>
            <p>{c.text}</p>
          </section>
        ))}
      </div>
      <p className="aiide-note">
        Closed this tab? Click <strong>AI Engineering</strong> in the status
        bar, or press ⌘⌥E / Ctrl+Alt+E.
      </p>
    </div>
  );
}
