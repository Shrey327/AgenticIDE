import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { Store } from './store';
import { Runs } from './runs';
import { Ssh } from './ssh';
import { Telemetry } from './telemetry';
import { Run } from './types';
import { loadProject } from './project';
import { within, redact } from './security';

const startSchema = z.object({
  name: z.string().min(1),
  target: z.enum(['local', 'ssh']),
  profile: z.string().optional(),
  parameters: z
    .record(z.union([z.string().max(4000), z.number().finite(), z.boolean()]))
    .default({}),
  modelPath: z.string().max(1000).optional(),
  datasetPath: z.string().max(1000).optional(),
  resumeFrom: z
    .object({ runId: z.string(), path: z.string().max(1000) })
    .optional(),
});
export class Training {
  private syncing = new Map<string, Promise<unknown>>();
  private timer?: NodeJS.Timeout;
  private closed = false;
  private launching = false;
  readonly ssh: Ssh;
  constructor(
    readonly root: string,
    readonly store: Store,
    readonly runs: Runs,
    readonly telemetry: Telemetry,
    assets: string,
  ) {
    this.ssh = new Ssh(path.join(root, '.aiide'), assets);
    this.timer = setInterval(() => {
      for (const run of store.runs())
        if (
          run.training?.target === 'ssh' &&
          (run.status === 'running' || run.training.remoteStatus === 'draining')
        )
          void this.sync(run.id).catch(() => {});
    }, 3000);
    this.timer.unref();
  }
  async start(input: unknown) {
    if (this.launching)
      throw new Error('A training launch is already in progress');
    this.launching = true;
    try {
      return await this.launch(startSchema.parse(input));
    } finally {
      this.launching = false;
    }
  }
  private async launch(args: z.infer<typeof startSchema>) {
    const config = loadProject(this.root),
      command = config.commands[args.name];
    if (!command) throw new Error('Choose a configured training command');
    if (
      this.store.runs().filter((r) => r.status === 'running' && r.training)
        .length >= 8
    )
      throw new Error('Eight training jobs are already active');
    if (JSON.stringify(args.parameters).length > 16000)
      throw new Error('Training configuration exceeds 16 KB');
    const clean = redact(args.parameters, true);
    if (JSON.stringify(clean) !== JSON.stringify(args.parameters))
      throw new Error('Do not put credentials in recorded training parameters');
    const profile =
      args.target === 'ssh' ? this.ssh.get(args.profile || '') : undefined;
    const env: Record<string, string> = {
      AIIDE_TRAIN_CONFIG: JSON.stringify(args.parameters),
    };
    if (args.modelPath) env.AIIDE_TRAIN_MODEL_PATH = args.modelPath;
    if (args.datasetPath) env.AIIDE_TRAIN_DATASET = args.datasetPath;
    if (args.resumeFrom) {
      const source = this.store.run(args.resumeFrom.runId);
      if (
        !source?.training ||
        !config.training.resume ||
        source.training.framework !== config.training.framework
      )
        throw new Error(
          'This project does not declare compatible checkpoint resume support',
        );
      if (
        source.training.target !== args.target ||
        JSON.stringify(source.training.profile) !== JSON.stringify(profile)
      )
        throw new Error(
          'Resume must use the same execution target and SSH profile as the checkpoint',
        );
      const checkpoint = await this.artifact(
        args.resumeFrom.runId,
        args.resumeFrom.path,
      );
      if (!checkpoint.resumable)
        throw new Error(checkpoint.reason || 'Checkpoint is not resumable');
      env.AIIDE_RESUME_CHECKPOINT = args.resumeFrom.path;
    }
    const training: NonNullable<Run['training']> = {
      target: args.target,
      framework: config.training.framework,
      parameters: args.parameters,
      modelPath: args.modelPath,
      datasetPath: args.datasetPath,
      profile,
      cursor: 0,
      connection: args.target === 'ssh' ? 'launching' : 'connected',
      resumeFrom: args.resumeFrom,
    };
    if (!profile) return this.runs.start(args.name, training, env);
    const run: Run = {
      id: crypto.randomUUID(),
      project: config.name,
      name: args.name,
      status: 'running',
      started: Date.now(),
      command,
      // Local revision is not the remote source fingerprint; record the target explicitly.
      source: 'remote source: awaiting supervisor',
      environment: {
        python: profile.python,
        host: profile.host,
        directory: profile.root,
      },
      configuration: { ...config, trainingParameters: args.parameters },
      training,
    };
    this.store.saveRun(run);
    try {
      await this.ssh.request(profile, {
        action: 'launch',
        id: run.id,
        job: {
          argv:
            command[0] === 'python'
              ? [profile.python, ...command.slice(1)]
              : command,
          env,
          project: config.name,
          capture: config.telemetry.captureContent,
          checkpoint: args.resumeFrom?.path,
          framework: config.training.framework,
        },
      });
      await this.sync(run.id);
    } catch (error) {
      this.connectionError(run.id, error);
    }
    return this.store.run(run.id)!;
  }
  private connectionError(id: string, error: unknown) {
    const run = this.store.run(id);
    if (run?.training)
      this.store.saveRun({
        ...run,
        training: {
          ...run.training,
          connection: 'disconnected',
          error: String(redact(String(error), true)),
        },
      });
  }
  sync(id: string): Promise<any> {
    const pending = this.syncing.get(id);
    if (pending) return pending;
    const work = this.poll(id).finally(() => this.syncing.delete(id));
    this.syncing.set(id, work);
    return work;
  }
  private async poll(id: string) {
    const run = this.store.run(id);
    if (this.closed || !run?.training?.profile) return run;
    try {
      const response = await this.ssh.request(run.training.profile, {
        action: 'poll',
        id,
        cursor: run.training.cursor,
      });
      if (
        !Number.isSafeInteger(response.cursor) ||
        response.cursor < run.training.cursor ||
        !Array.isArray(response.records) ||
        response.records.length > 200
      )
        throw new Error('Invalid remote journal response');
      const latest = this.store.run(id)!;
      this.store.strict = true;
      try {
        this.store.transaction(() => {
          for (const record of response.records) {
            // A remote job can only append telemetry to its own local run.
            for (const event of record.body.events || []) event.runId = id;
            const bindRun = (value: any): void => {
              if (!value || typeof value !== 'object') return;
              if (Array.isArray(value.attributes))
                value.attributes = value.attributes.map((a: any) =>
                  a.key === 'aiide.run.id'
                    ? { key: a.key, value: { stringValue: id } }
                    : a,
                );
              for (const child of Object.values(value)) bindRun(child);
            };
            bindRun(record.body);
            for (const key of [
              'resourceSpans',
              'resourceLogs',
              'resourceMetrics',
            ])
              for (const item of record.body[key] || []) {
                item.resource ||= {};
                item.resource.attributes ||= [];
                item.resource.attributes.push({
                  key: 'aiide.run.id',
                  value: { stringValue: id },
                });
              }
            this.telemetry.ingest(record.route, record.body);
          }
          const terminal = [
            'completed',
            'failed',
            'cancelled',
            'interrupted',
          ].includes(response.status);
          this.store.saveRun({
            ...latest,
            source: response.source
              ? JSON.stringify(response.source)
              : latest.source,
            status: terminal ? response.status : latest.status,
            ended: terminal ? response.ended || Date.now() : latest.ended,
            training: {
              ...latest.training!,
              cursor: response.cursor,
              connection: 'connected',
              remoteStatus: response.hasMore ? 'draining' : response.status,
              lastSync: Date.now(),
              dropped: response.dropped || 0,
              error:
                response.status === 'missing'
                  ? 'No remote job found. Check the target directory; this launch was not confirmed.'
                  : response.error,
            },
          });
        });
      } finally {
        this.store.strict = false;
      }
      return this.store.run(id);
    } catch (error) {
      this.connectionError(id, error);
      return this.store.run(id);
    }
  }
  async cancel(id: string) {
    const run = this.store.run(id);
    if (!run?.training) throw new Error('Training run not found');
    if (run.training.profile) {
      await this.ssh.request(run.training.profile, { action: 'cancel', id });
      return this.sync(id);
    }
    this.runs.cancel(id);
    return this.store.run(id);
  }
  artifacts(id: string) {
    return this.store
      .events(id)
      .filter((e) => ['artifact', 'checkpoint'].includes(e.kind))
      .map((e) => ({ id: e.id, name: e.name, ...(e.value as any) }));
  }
  private registeredPath(id: string, relative: string) {
    const normalized = relative.replaceAll('\\', '/');
    if (normalized.startsWith('/') || normalized.split('/').includes('..'))
      throw new Error('Artifact must be inside the project');
    if (
      !this.artifacts(id).some(
        (a) =>
          typeof a.path === 'string' &&
          (a.path === normalized ||
            normalized.startsWith(a.path.replace(/\/$/, '') + '/')),
      )
    )
      throw new Error('Select an artifact recorded by this run');
    return normalized;
  }
  async artifact(id: string, relative: string) {
    const run = this.store.run(id);
    if (!run?.training) throw new Error('Training run not found');
    const request = {
      action: 'artifact',
      path: this.registeredPath(id, relative),
      framework: run.training.framework,
    };
    return run.training.profile
      ? this.ssh.request(run.training.profile, request)
      : this.ssh.local(this.root, request);
  }
  async download(id: string, relative: string) {
    const run = this.store.run(id);
    if (!run?.training) throw new Error('Training run not found');
    relative = this.registeredPath(id, relative);
    if (!run.training.profile) return { path: within(this.root, relative) };
    const result = await this.ssh.request(run.training.profile, {
      action: 'artifact.read',
      path: relative,
    });
    const directory = within(this.root, `.aiide/artifacts/${id}`, true);
    fs.mkdirSync(directory, { recursive: true });
    const target = within(
      this.root,
      `.aiide/artifacts/${id}/${crypto.randomUUID()}-${path.basename(relative)}`,
      true,
    );
    fs.writeFileSync(target, Buffer.from(result.data, 'base64'), {
      flag: 'wx',
      mode: 0o600,
    });
    return { path: target };
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.allSettled(this.syncing.values());
  }
}
