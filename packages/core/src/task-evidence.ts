import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { Store } from './store';
import { Evals } from './evals';
import { Sandbox } from './sandbox';
import { excluded, hash, redact, walk, within } from './security';
import { Run } from './types';

const uuid = z.string().uuid(),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
const sourcePath = z
  .string()
  .min(1)
  .max(400)
  .refine(
    (file) =>
      !excluded(file.toLowerCase()) &&
      !file.includes('\\') &&
      !file.split('/').some((part) => !part || part === '.' || part === '..'),
    'Select non-secret workspace source paths',
  );
const finding = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
    level: z.enum(['blocking', 'warning', 'info']),
    text: z.string().trim().min(1).max(1500),
    resolved: z.boolean().default(false),
    resolution: z.string().trim().max(1000).default(''),
  })
  .strict()
  .refine(
    (value) => !value.resolved || Boolean(value.resolution),
    'Resolved findings need a written resolution',
  );
const gate = z
  .object({
    runId: uuid,
    thresholds: z
      .record(z.number().finite().min(0).max(1))
      .refine(
        (values) =>
          Object.keys(values).length >= 1 &&
          Object.keys(values).length <= 32 &&
          Object.keys(values).every(
            (key) =>
              /^[A-Za-z0-9_.-]{1,80}$/.test(key) &&
              !['__proto__', 'constructor', 'prototype'].includes(key),
          ),
        'Choose 1–32 scorer thresholds',
      ),
    maxErrors: z.number().int().min(0).max(1000).default(0),
    maxRegression: z.number().min(0).max(1).default(0),
    baseline: uuid.optional(),
  })
  .strict();
const bodySchema = z
  .object({
    title: z.string().trim().min(1).max(140),
    plan: z.string().max(16000).default(''),
    planReviewed: z.boolean().default(false),
    criteria: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
    sourceFiles: z.array(sourcePath).max(20).default([]),
    runIds: z.array(uuid).max(20).default([]),
    evalGates: z.array(gate).max(3).default([]),
    sandboxIds: z.array(uuid).max(10).default([]),
    findings: z.array(finding).max(50).default([]),
  })
  .strict();
const inputSchema = bodySchema
  .extend({
    id: uuid.nullable().default(null),
    revision: digest.nullable().default(null),
    newSourceCheckpoint: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [name, items] of [
      ['sourceFiles', value.sourceFiles],
      ['runIds', value.runIds],
      ['sandboxIds', value.sandboxIds],
      ['evalGates', value.evalGates.map((item) => item.runId)],
      ['findings', value.findings.map((item) => item.id)],
    ] as [string, string[]][])
      if (new Set(items).size !== items.length)
        context.addIssue({
          code: 'custom',
          message: `Duplicate ${name} entries are not allowed`,
        });
  });
const checkpoint = z
  .object({
    at: z.number(),
    fingerprint: digest.nullable(),
    files: z
      .array(z.object({ file: sourcePath, sha256: digest }).strict())
      .max(20),
  })
  .strict();
const recordSchema = z
  .object({
    version: z.literal(1),
    id: uuid,
    created: z.number(),
    updated: z.number(),
    body: bodySchema,
    sourceCheckpoint: checkpoint,
    runs: z.array(z.object({ id: uuid, identity: digest }).strict()).max(20),
    evaluations: z.array(gate.extend({ identity: digest })).max(3),
    sandboxes: z
      .array(z.object({ id: uuid, identity: digest }).strict())
      .max(10),
    completed: z.object({ at: z.number(), evidenceHash: digest }).nullable(),
  })
  .strict();
type RecordData = z.infer<typeof recordSchema>;
type Task = RecordData & { revision: string };

/** Human task review links existing evidence; it never runs a command or a model. */
export class TaskEvidence {
  private closed = false;
  constructor(
    readonly root: string,
    readonly store: Store,
    readonly evals: Evals,
    readonly sandbox: Sandbox,
  ) {}
  private open() {
    if (this.closed) throw new Error('Task evidence is closed');
  }
  close() {
    this.closed = true;
  }
  private file(id: string) {
    return within(
      this.root,
      `.aiide/task-evidence/${uuid.parse(id)}.json`,
      true,
    );
  }
  private bytes(file: string, maximum: number) {
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW || 0) |
        (fs.constants.O_NONBLOCK || 0),
    );
    try {
      const info = fs.fstatSync(fd);
      if (!info.isFile() || info.size > maximum)
        throw new Error(
          `Evidence must be a regular file below ${maximum} bytes`,
        );
      const buffer = Buffer.alloc(info.size + 1);
      let count = 0,
        read: number;
      while (
        count < buffer.length &&
        (read = fs.readSync(fd, buffer, count, buffer.length - count, null))
      )
        count += read;
      if (count > maximum)
        throw new Error('Evidence file exceeded its size limit');
      if (count > info.size)
        throw new Error('Evidence file changed while reading');
      return buffer.subarray(0, count);
    } finally {
      fs.closeSync(fd);
    }
  }
  private source(file: string) {
    const bytes = this.bytes(within(this.root, sourcePath.parse(file)), 256000);
    return {
      file,
      sha256: hash(bytes),
      bytes: bytes.length,
      content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    };
  }
  private projectFingerprint() {
    let total = 0;
    return hash(
      walk(this.root)
        .map((file) => {
          const bytes = this.bytes(within(this.root, file), 2 * 1024 * 1024);
          total += bytes.length;
          if (total > 50 * 1024 * 1024)
            throw new Error('Source checkpoint exceeds 50 MB');
          return `${file}:${hash(bytes)}`;
        })
        .join('\n'),
    );
  }
  private read(id: string): Task {
    const bytes = this.bytes(this.file(id), 256000),
      record = recordSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (record.id !== id) throw new Error('Task identity mismatch');
    return { ...record, revision: hash(bytes) };
  }
  list() {
    this.open();
    const directory = within(this.root, '.aiide/task-evidence', true);
    if (!fs.existsSync(directory)) return [];
    return fs
      .readdirSync(directory)
      .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
      .slice(0, 100)
      .map((name) => {
        try {
          const record = this.read(name.slice(0, -5));
          return {
            id: record.id,
            title: record.body.title,
            updated: record.updated,
            revision: record.revision,
            previousCompletion: Boolean(record.completed),
          };
        } catch (error) {
          return {
            id: name.slice(0, -5),
            title: 'Unreadable task record',
            error: String(error),
          };
        }
      })
      .sort((a, b) => (b.updated || 0) - (a.updated || 0));
  }
  private runIdentity(run: Run) {
    return hash(
      JSON.stringify({
        id: run.id,
        project: run.project,
        started: run.started,
        command: run.command,
        source: run.source,
        environment: run.environment,
        configuration: run.configuration,
        parameters: run.training?.parameters,
        lab: run.lab,
      }),
    );
  }
  private evaluationIdentity(value: z.infer<typeof gate>) {
    const files = [value.runId, ...(value.baseline ? [value.baseline] : [])];
    return hash(
      JSON.stringify({
        gate: value,
        artifacts: files.map((id) => ({
          id,
          sha256: hash(
            this.bytes(
              within(this.root, `.aiide/evals/${uuid.parse(id)}.json`),
              50 * 1024 * 1024,
            ),
          ),
        })),
      }),
    );
  }
  private sandboxFact(id: string) {
    const state = this.sandbox.status(id),
      events = this.store.events(id, 'audit'),
      start = events.find((event) => event.name === 'command.start'),
      end = events.find((event) => event.name === 'command.end');
    return {
      id,
      created: state.created,
      status: state.status,
      engine: state.engine,
      isolation: state.isolation,
      sourceAssociation:
        'Audited command exit only; no task source-snapshot binding',
      outputHash: hash(state.output),
      startAudit: start?.id ?? null,
      endAudit: end?.id ?? null,
      exitCode:
        typeof (end?.value as any)?.code === 'number'
          ? (end!.value as any).code
          : null,
    };
  }
  preview(input: unknown) {
    this.open();
    const args = inputSchema.parse(input),
      old = args.id ? this.read(args.id) : undefined;
    if (old?.revision !== args.revision && args.id)
      throw new Error('Task changed; reload before editing');
    if (!args.id && args.revision)
      throw new Error('A new task cannot have an existing revision');
    const { id: _id, revision: _revision, newSourceCheckpoint, ...body } = args;
    const sources = [...body.sourceFiles]
      .sort()
      .map((file) => this.source(file));
    if (sources.reduce((total, source) => total + source.bytes, 0) > 1000000)
      throw new Error('Reviewed task sources exceed 1 MB');
    body.sourceFiles = sources.map((source) => source.file);
    const files = sources.map(({ file, sha256 }) => ({ file, sha256 }));
    let fingerprint: string | null = null;
    const keepCheckpoint =
      old &&
      !newSourceCheckpoint &&
      JSON.stringify(old.sourceCheckpoint.files) === JSON.stringify(files);
    if (keepCheckpoint) fingerprint = old.sourceCheckpoint.fingerprint;
    else
      try {
        fingerprint = this.projectFingerprint();
      } catch {}
    const runs = body.runIds.map((id) => {
      const run = this.store.run(id);
      if (!run) throw new Error(`Recorded run is missing: ${id}`);
      return { id, identity: this.runIdentity(run) };
    });
    const evaluations = body.evalGates.map((value) => {
      if (!this.store.run(value.runId)?.configuration?.evaluation)
        throw new Error(`Choose an actual evaluation run: ${value.runId}`);
      return { ...value, identity: this.evaluationIdentity(value) };
    });
    const sandboxes = body.sandboxIds.map((id) => ({
      id,
      identity: hash(JSON.stringify(this.sandboxFact(id))),
    }));
    const captured = { body, files, fingerprint, runs, evaluations, sandboxes };
    const previewHash = hash(
      JSON.stringify({
        id: args.id,
        revision: args.revision,
        newSourceCheckpoint,
        captured,
      }),
    );
    return {
      ...captured,
      sources,
      reviewHash: previewHash,
      sourceCheckpointAt:
        keepCheckpoint && old ? old.sourceCheckpoint.at : null,
    };
  }
  private write(record: RecordData) {
    const file = this.file(record.id),
      directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (
      !fs.existsSync(file) &&
      fs.readdirSync(directory).filter((name) => name.endsWith('.json'))
        .length >= 100
    )
      throw new Error('Task evidence supports at most 100 local task records');
    const text = JSON.stringify(record);
    if (Buffer.byteLength(text) > 256000)
      throw new Error('Task record exceeds 256 KB');
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  save(input: unknown) {
    this.open();
    const {
      reviewHash,
      confirmed: _confirmed,
      ...fields
    } = z
      .object({ reviewHash: digest, confirmed: z.literal(true) })
      .passthrough()
      .parse(input);
    const data = inputSchema.parse(fields);
    const preview = this.preview(data);
    if (preview.reviewHash !== reviewHash)
      throw new Error(
        'Task sources or evidence changed after preview; review again',
      );
    const old = data.id ? this.read(data.id) : undefined,
      now = Date.now(),
      id = data.id || crypto.randomUUID();
    this.write({
      version: 1,
      id,
      created: old?.created || now,
      updated: now,
      body: preview.body,
      sourceCheckpoint: {
        at: preview.sourceCheckpointAt ?? now,
        fingerprint: preview.fingerprint,
        files: preview.files,
      },
      runs: preview.runs,
      evaluations: preview.evaluations,
      sandboxes: preview.sandboxes,
      completed: null,
    });
    return this.get(id);
  }
  private report(task: Task) {
    const reasons: string[] = [];
    if (!task.body.plan.trim() || !task.body.planReviewed)
      reasons.push('The plan needs explicit human review');
    if (!task.body.criteria.length)
      reasons.push('Define at least one completion criterion for human review');
    if (!task.sourceCheckpoint.files.length)
      reasons.push('Select reviewed source files for this task');
    if (!task.runs.length && !task.evaluations.length && !task.sandboxes.length)
      reasons.push('Link actual recorded run, evaluation or sandbox evidence');
    const sources = task.sourceCheckpoint.files.map((source) => {
      try {
        const current = this.source(source.file);
        return {
          ...source,
          currentHash: current.sha256,
          current: current.sha256 === source.sha256,
          error: '',
        };
      } catch (error) {
        return {
          ...source,
          currentHash: null,
          current: false,
          error: String(error),
        };
      }
    });
    for (const source of sources)
      if (!source.current)
        reasons.push(`Source changed or is unavailable: ${source.file}`);
    const runs = task.runs.map((reference) => {
      const run = this.store.run(reference.id);
      if (!run)
        return {
          id: reference.id,
          name: 'Missing run',
          status: 'missing',
          current: false,
          sourceMatches: false,
          passed: false,
        };
      const current = this.runIdentity(run) === reference.identity,
        sourceMatches = Boolean(
          task.sourceCheckpoint.fingerprint &&
            run.source.endsWith('source:' + task.sourceCheckpoint.fingerprint),
        );
      return {
        id: run.id,
        name: run.name,
        status: run.status,
        started: run.started,
        ended: run.ended,
        source: run.source,
        current,
        sourceMatches,
        passed: current && sourceMatches && run.status === 'completed',
      };
    });
    for (const run of runs)
      if (!run.passed)
        reasons.push(
          `Run ${run.id}: ${run.status}; ${!run.current ? 'record changed/missing' : !run.sourceMatches ? 'source differs from the reviewed checkpoint' : 'completion required'}`,
        );
    const evaluations = task.evaluations.map((reference) => {
      try {
        const { identity, ...options } = reference,
          report = this.evals.gate(options),
          run = this.store.run(reference.runId),
          current = this.evaluationIdentity(options) === identity;
        const baselineCurrent =
          !reference.baseline ||
          this.store.run(reference.baseline)?.status === 'completed';
        return {
          runId: reference.runId,
          current,
          report,
          passed:
            current &&
            run?.status === 'completed' &&
            baselineCurrent &&
            report.passed &&
            Boolean(report.datasetVersion && report.configVersion),
          error: '',
        };
      } catch (error) {
        return {
          runId: reference.runId,
          current: false,
          passed: false,
          error: String(error),
        };
      }
    });
    for (const evaluation of evaluations)
      if (!evaluation.passed)
        reasons.push(
          `Evaluation ${evaluation.runId}: ${evaluation.error || (!evaluation.current ? 'artifact changed; review the updated evidence' : 'gate failed or versioned evidence is incomplete')}`,
        );
    const sandboxes = task.sandboxes.map((reference) => {
      try {
        const fact = this.sandboxFact(reference.id),
          current = hash(JSON.stringify(fact)) === reference.identity;
        return {
          ...fact,
          current,
          passed:
            current &&
            fact.status === 'completed' &&
            fact.exitCode === 0 &&
            Boolean(
              fact.startAudit &&
                fact.endAudit &&
                fact.endAudit > fact.startAudit,
            ),
          error: '',
        };
      } catch (error) {
        return {
          id: reference.id,
          current: false,
          passed: false,
          error: String(error),
        };
      }
    });
    for (const sandbox of sandboxes)
      if (!sandbox.passed)
        reasons.push(
          `Sandbox ${sandbox.id}: completed command audit evidence is missing, changed or unsuccessful`,
        );
    const blocking = task.body.findings.filter(
      (finding) => finding.level === 'blocking' && !finding.resolved,
    );
    if (blocking.length)
      reasons.push(
        `${blocking.length} blocking review finding(s) remain unresolved`,
      );
    const evidenceHash = hash(
      JSON.stringify({
        body: task.body,
        checkpoint: task.sourceCheckpoint,
        sources,
        runs,
        evaluations,
        sandboxes,
      }),
    );
    const ready = reasons.length === 0,
      currentCompletion = Boolean(
        task.completed && task.completed.evidenceHash === evidenceHash && ready,
      );
    return {
      ready,
      reasons,
      sources,
      runs,
      evaluations,
      sandboxes,
      evidenceHash,
      reviewHash: hash(
        JSON.stringify({ id: task.id, revision: task.revision, evidenceHash }),
      ),
      status: currentCompletion
        ? 'reviewed-complete'
        : task.completed
          ? 'stale-completion'
          : ready
            ? 'ready-for-review'
            : 'needs-evidence',
      currentCompletion,
      criteriaReview:
        'Completion criteria and source coverage are human-reviewed. Freshness checks cover selected files only. Host runs bind to the checkpoint at launch; sandbox links prove audited command exit only, without source-snapshot binding.',
    };
  }
  get(input: string | { id: string }) {
    this.open();
    const task = this.read(
      typeof input === 'string' ? input : uuid.parse(input.id),
    );
    return { task, report: this.report(task) };
  }
  delete(input: unknown) {
    this.open();
    const args = z
      .object({ id: uuid, revision: digest, confirmed: z.literal(true) })
      .strict()
      .parse(input);
    if (this.read(args.id).revision !== args.revision)
      throw new Error('Task changed; reload before removing its record');
    fs.unlinkSync(this.file(args.id));
    return { removed: args.id };
  }
  complete(input: unknown) {
    this.open();
    const args = z
        .object({
          id: uuid,
          revision: digest,
          reviewHash: digest,
          confirmed: z.literal(true),
        })
        .strict()
        .parse(input),
      current = this.get(args.id);
    if (
      current.task.revision !== args.revision ||
      current.report.reviewHash !== args.reviewHash
    )
      throw new Error(
        'Task evidence changed after review; refresh before recording completion',
      );
    if (!current.report.ready)
      throw new Error(
        'Completion is blocked: ' + current.report.reasons.join('; '),
      );
    const { revision: _revision, ...record } = current.task;
    this.write({
      ...record,
      updated: Date.now(),
      completed: { at: Date.now(), evidenceHash: current.report.evidenceHash },
    });
    return this.get(args.id);
  }
  exportPreview(input: unknown) {
    this.open();
    const { id } = z.object({ id: uuid }).strict().parse(input),
      current = this.get(id);
    const document = redact(
      {
        format: 'aiide-task-evidence-v1',
        id,
        title: current.task.body.title,
        created: current.task.created,
        updated: current.task.updated,
        plan: current.task.body.plan,
        planReviewed: current.task.body.planReviewed,
        criteria: current.task.body.criteria,
        findings: current.task.body.findings,
        sourceCheckpoint: current.task.sourceCheckpoint,
        status: current.report.status,
        humanCompletion: current.task.completed,
        evidence: current.report,
      },
      true,
    );
    const content = JSON.stringify(document, null, 2) + '\n';
    if (Buffer.byteLength(content) > 256000)
      throw new Error('Task export exceeds 256 KB');
    return {
      filename: `task-evidence-${id}.json`,
      content,
      revision: current.task.revision,
      reviewHash: hash(content),
    };
  }
  export(input: unknown) {
    this.open();
    const args = z
        .object({
          id: uuid,
          revision: digest,
          reviewHash: digest,
          confirmed: z.literal(true),
        })
        .strict()
        .parse(input),
      preview = this.exportPreview({ id: args.id });
    if (
      preview.revision !== args.revision ||
      preview.reviewHash !== args.reviewHash
    )
      throw new Error('Task export changed after review; preview again');
    return {
      filename: preview.filename,
      content: preview.content,
      sha256: preview.reviewHash,
    };
  }
}
