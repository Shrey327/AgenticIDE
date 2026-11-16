import { spawn, ChildProcess, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from './store';
import { Telemetry } from './telemetry';
import { loadProject, detectEnvironment } from './project';
import { fingerprint } from './security';
import { Run } from './types';
import { Connections } from './models';

export class Runs {
  private children = new Map<string, ChildProcess>();
  private killTimers = new Map<string, NodeJS.Timeout>();
  private supervisorPython?: string;
  private closed = false;
  constructor(
    readonly root: string,
    readonly store: Store,
    readonly telemetry: Telemetry,
    readonly sdkPath: string,
    readonly connections: Connections,
  ) {}
  async start(
    name: string,
    training?: Run['training'],
    trainingEnv: Record<string, string> = {},
    /** IDE-provided command (e.g. the experiment lab) instead of a named project command. */
    builtin?: { command: string[]; lab: Run['lab'] },
  ): Promise<Run> {
    if (this.closed) throw new Error('Workspace runs are closed');
    const project = loadProject(this.root),
      command = builtin?.command ?? project.commands[name];
    if (!command?.length) throw new Error('Choose a configured run command');
    if (this.children.size >= 8)
      throw new Error('Eight runs are already active');
    const serviceEnv: Record<string, string> = {};
    for (const [role, prefix] of [
      ['chat', 'AIIDE_MODEL'],
      ['embeddings', 'AIIDE_EMBEDDING'],
      ['vectorStore', 'QDRANT'],
    ] as const) {
      const id = project.services[role];
      if (!id) continue;
      const connection = this.connections.get(id);
      if (connection.kind !== (role === 'vectorStore' ? 'qdrant' : 'model'))
        throw new Error(`Incorrect connection type for ${role}`);
      serviceEnv[`${prefix}_URL`] = connection.url;
      if (connection.model) serviceEnv[`${prefix}_NAME`] = connection.model;
      if (role === 'embeddings' && connection.model)
        serviceEnv.AIIDE_EMBEDDING_MODEL = connection.model;
      const secret = connection.credentialRef
        ? await this.connections.vault.get(connection.credentialRef)
        : undefined;
      if (secret)
        serviceEnv[
          role === 'vectorStore' ? 'QDRANT_API_KEY' : `${prefix}_KEY`
        ] = secret;
    }
    if (this.closed) throw new Error('Workspace runs are closed');
    if (this.children.size >= 8)
      throw new Error('Eight runs are already active');
    const env = detectEnvironment(this.root);
    let sourceFingerprint: string;
    try {
      sourceFingerprint = `source:${fingerprint(this.root)}`;
    } catch {
      sourceFingerprint = 'source:unavailable';
    }
    let revision = '';
    try {
      revision = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: this.root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      /* New workspace. */
    }
    const run: Run = {
      id: crypto.randomUUID(),
      project: project.name,
      name,
      status: 'running',
      started: Date.now(),
      command,
      source: `${revision}:${sourceFingerprint}`,
      environment: env,
      configuration: project,
      training,
      lab: builtin?.lab,
    };
    this.store.saveRun(run);
    const executable =
      command[0] === 'python' ? project.environment.python : command[0];
    const jobEnv = {
      ...process.env,
      ...serviceEnv,
      ...trainingEnv,
      PYTHONUNBUFFERED: '1',
      PYTHONPATH: [this.sdkPath, process.env.PYTHONPATH]
        .filter(Boolean)
        .join(path.delimiter),
      AIIDE_RUN_ID: run.id,
      AIIDE_PROJECT: project.name,
      AIIDE_CAPTURE_CONTENT: String(project.telemetry.captureContent),
      AIIDE_EVENTS_ENDPOINT: this.telemetry.url,
      AIIDE_TOKEN: this.telemetry.token,
      OTEL_EXPORTER_OTLP_ENDPOINT: this.telemetry.exporterUrl,
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
      OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${this.telemetry.token}`,
      OTEL_RESOURCE_ATTRIBUTES: `aiide.run.id=${run.id}`,
      WANDB_MODE: 'disabled',
      LANGSMITH_TRACING: 'false',
    };
    let child: ChildProcess;
    try {
      const runtimeArgs =
        builtin && command[0] === 'python' && command[1] === '-m'
          ? [
              '-I',
              path.join(this.sdkPath, 'aiide_runtime', 'launch.py'),
              ...command.slice(2),
            ]
          : command.slice(1);
      const helper = path.join(this.sdkPath, 'aiide_runtime', 'local.py');
      if (process.platform !== 'win32' && !fs.statSync(helper).isFile())
        throw new Error('Local job supervisor is unavailable');
      if (process.platform !== 'win32')
        this.supervisorPython ??= execFileSync(
          'python3',
          ['-I', '-c', 'import sys;print(sys.executable)'],
          {
            encoding: 'utf8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        ).trim();
      child = spawn(
        process.platform === 'win32' ? executable : this.supervisorPython!,
        process.platform === 'win32'
          ? runtimeArgs
          : ['-I', helper, executable, ...runtimeArgs],
        {
          cwd: this.root,
          detached: process.platform !== 'win32',
          stdio:
            process.platform === 'win32'
              ? ['ignore', 'pipe', 'pipe']
              : ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
          env: jobEnv,
        },
      );
    } catch (error) {
      this.finish(run.id, 'failed');
      this.launchFailure(run.id, (error as Error).message);
      return this.store.run(run.id)!;
    }
    this.children.set(run.id, child);
    // FD 3 is kept open only by this IDE process; its EOF also detects SIGKILL/crashes.
    child.stdio[3]?.on('error', () => {});
    let diagnostic = '';
    child.stdio[4]?.on('data', (data) => {
      diagnostic = (diagnostic + String(data)).slice(0, 8192);
      const end = diagnostic.indexOf('\n');
      if (end < 0) return;
      try {
        const result = JSON.parse(diagnostic.slice(0, end));
        if (typeof result.error === 'string')
          this.launchFailure(run.id, result.error);
      } catch {
        this.launchFailure(
          run.id,
          'Local job supervisor returned invalid diagnostics',
        );
      }
      diagnostic = '';
    });
    let outputBytes = 0;
    for (const [name, stream] of [
      ['stdout', child.stdout],
      ['stderr', child.stderr],
    ] as const)
      stream?.on('data', (data) => {
        outputBytes += data.length;
        if (outputBytes < 2 * 1024 * 1024)
          this.store.event({
            runId: run.id,
            kind: 'log',
            timestamp: Date.now(),
            name,
            value: String(data),
          });
        else this.store.dropped++;
      });
    child.once('error', (error) => {
      this.finish(run.id, 'failed');
      this.launchFailure(run.id, error.message);
    });
    child.once('exit', (code) =>
      this.finish(run.id, code === 0 ? 'completed' : 'failed'),
    );
    return run;
  }
  private launchFailure(id: string, message: string) {
    this.store.event({
      runId: id,
      kind: 'diagnostic',
      timestamp: Date.now(),
      name: 'Launch failed',
      value: message,
    });
  }
  private finish(id: string, status: 'completed' | 'failed') {
    try {
      const run = this.store.run(id);
      if (run?.status === 'running')
        this.store.saveRun({ ...run, status, ended: Date.now() });
    } catch {
      // A full disk must not terminate the IDE or the remaining user processes.
      this.store.dropped++;
    } finally {
      clearTimeout(this.killTimers.get(id));
      this.killTimers.delete(id);
      this.children.delete(id);
    }
  }
  cancel(id: string) {
    const child = this.children.get(id),
      run = this.store.run(id);
    if (!child || !run) throw new Error('Run is not active');
    try {
      this.store.saveRun({ ...run, status: 'cancelled', ended: Date.now() });
    } finally {
      // The POSIX supervisor forwards TERM, then kills its target group after 3s.
      // shortcut: Windows lacks parent-death/tree guarantees until Job Objects are added.
      child.kill('SIGTERM');
    }
    if (process.platform !== 'win32') return;
    const kill = setTimeout(() => {
      child.kill('SIGKILL');
    }, 3000);
    this.killTimers.set(id, kill);
    kill.unref();
  }
  async stop() {
    this.closed = true;
    const exits = [...this.children.entries()].map(
      ([id, child]) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 4000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
          this.cancel(id);
        }),
    );
    await Promise.all(exits);
  }
}
