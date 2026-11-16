import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { excluded, hash, walk, within } from './security';
import { loadProject, projectSchema } from './project';
import { subprocess } from './ssh';

const selection = z.object({
  files: z.array(z.string().min(1).max(500)).max(1999),
});
const archiveSchema = z.object({ file: z.string().min(1).max(500) });
const metadataName = 'aiide-bundle.json';
const maxFile = 64 * 1024 * 1024;

function inspectSource(file: string) {
  const descriptor = fs.openSync(
    file,
    fs.constants.O_RDONLY |
      (fs.constants.O_NOFOLLOW || 0) |
      (fs.constants.O_NONBLOCK || 0),
  );
  try {
    if (!fs.fstatSync(descriptor).isFile())
      throw new Error('Select a regular source file');
    const digest = crypto.createHash('sha256');
    const buffer = Buffer.alloc(65536);
    let size = 0,
      bytes: number;
    while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null))) {
      size += bytes;
      if (size > maxFile)
        throw new Error('Source exceeded the 64 MB file limit');
      digest.update(buffer.subarray(0, bytes));
    }
    return { size, sha256: digest.digest('hex') };
  } finally {
    fs.closeSync(descriptor);
  }
}

export class ProjectBundles {
  private closed = false;
  private readonly controllers = new Set<AbortController>();
  private readonly requests = new Set<Promise<unknown>>();
  constructor(
    readonly root: string,
    readonly assets: string,
  ) {}
  files() {
    return walk(this.root)
      .filter(
        (file) =>
          !excluded(file.toLowerCase()) &&
          file !== metadataName &&
          !/\.(zip|bin|pt|pth|safetensors|onnx|joblib|npz|npy|pkl|pickle|gguf|h5|keras)$/i.test(
            file,
          ),
      )
      .slice(0, 1999);
  }
  preview(input: unknown) {
    const { files } = selection.parse(input);
    const chosen = [...new Set(files)].sort();
    const entries = chosen.map((file) => {
      if (
        excluded(file.toLowerCase()) ||
        file === metadataName ||
        file.includes('\\') ||
        /[<>:"|?*\x00-\x1f\x7f]/.test(file) ||
        file.split('/').some((part) => part === '.' || part === '..' || !part)
      )
        throw new Error('Protected or non-portable bundle path: ' + file);
      const full = within(this.root, file);
      const info = fs.statSync(full);
      if (!info.isFile() || info.size > maxFile)
        throw new Error('Select regular files up to 64 MB: ' + file);
      return { file, ...inspectSource(full) };
    });
    const original = loadProject(this.root);
    const config = projectSchema.parse({
      version: 1,
      name: original.name,
      environment: { python: '.venv/bin/python' },
      commands: {},
      services: {},
      connections: [],
      adapters: [...new Set(original.adapters)],
      telemetry: { captureContent: false },
    });
    const manifest = JSON.stringify(config, null, 2) + '\n';
    entries.push({
      file: '.aiide/project.yaml',
      size: Buffer.byteLength(manifest),
      sha256: hash(manifest),
    });
    const portable = new Set<string>();
    for (const entry of entries) {
      const file = entry.file.normalize('NFC').toLowerCase();
      if (portable.has(file))
        throw new Error('Selected files have conflicting portable paths');
      portable.add(file);
    }
    for (const file of portable) {
      const parts = file.split('/');
      if (
        parts
          .slice(0, -1)
          .some((_, index) => portable.has(parts.slice(0, index + 1).join('/')))
      )
        throw new Error('Selected files conflict with a directory path');
    }
    if (
      Buffer.byteLength(
        JSON.stringify({ format: 'aiide-project-bundle-v1', files: entries }),
      ) >
      1024 * 1024
    )
      throw new Error('Bundle provenance exceeds 1 MB; select fewer files');
    const totalBytes = entries.reduce((total, entry) => total + entry.size, 0);
    if (totalBytes > 200 * 1024 * 1024)
      throw new Error('Bundle exceeds the 200 MB expanded limit');
    return {
      files: entries,
      totalBytes,
      manifest,
      reviewHash: hash(JSON.stringify({ entries, manifest })),
    };
  }
  async export(input: unknown) {
    const args = selection
      .extend({ reviewHash: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(input);
    const plan = this.preview(args);
    if (plan.reviewHash !== args.reviewHash)
      throw new Error('Selected files changed; preview the bundle again');
    const folder = within(this.root, '.aiide/bundles', true);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = `.aiide/bundles/${crypto.randomUUID()}.zip`;
    const result = await this.call({
      action: 'export',
      root: fs.realpathSync(this.root),
      output: within(this.root, file, true),
      plan,
    });
    return { ...result, file };
  }
  private archive(input: unknown) {
    const { file } = archiveSchema.parse(input);
    if (!file.toLowerCase().endsWith('.zip'))
      throw new Error('Choose a project ZIP bundle');
    const full = within(this.root, file);
    const info = fs.statSync(full);
    if (!info.isFile() || info.size > 100 * 1024 * 1024)
      throw new Error('Choose a regular ZIP file up to 100 MB');
    return { file, full };
  }
  inspect(input: unknown) {
    const archive = this.archive(input);
    return this.call({ action: 'inspect', archive: archive.full });
  }
  async import(input: unknown) {
    const args = archiveSchema
      .extend({
        name: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
        reviewHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(input);
    const archive = this.archive(args);
    const target = within(this.root, args.name, true);
    if (fs.existsSync(target)) throw new Error('Target folder already exists');
    const result = await this.call({
      action: 'import',
      root: fs.realpathSync(this.root),
      archive: archive.full,
      target,
      reviewHash: args.reviewHash,
    });
    return { ...result, root: target };
  }
  private call(request: unknown) {
    if (this.closed)
      return Promise.reject(new Error('Project sharing service is closed'));
    const controller = new AbortController();
    this.controllers.add(controller);
    const operation = subprocess(
      process.platform === 'win32' ? 'python' : 'python3',
      ['-I', path.join(this.assets, 'python', 'project_bundle.py')],
      request,
      120000,
      {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        PYTHONDONTWRITEBYTECODE: '1',
      } as NodeJS.ProcessEnv,
      controller.signal,
    );
    this.requests.add(operation);
    void operation
      .finally(() => {
        this.controllers.delete(controller);
        this.requests.delete(operation);
      })
      .catch(() => {});
    return operation;
  }
  async close() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.requests]);
  }
}
