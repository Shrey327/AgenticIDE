import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { loadProject } from './project';
import { Runs } from './runs';
import { subprocess } from './ssh';
import { within } from './security';

const base = z.object({
  file: z.string().min(1).max(500),
  target: z.string().min(1).max(200),
  task: z.enum(['regression', 'classification']),
  features: z.array(z.string().min(1).max(200)).min(1).max(500).optional(),
  seed: z.number().int().min(0).max(2147483647).default(42),
});
const sweepSchema = base.extend({
  metrics: z.array(z.string().max(20)).min(1).max(10),
  primary: z.string().max(20),
  validation: z.object({
    type: z.enum(['kfold', 'holdout']),
    folds: z.number().int().min(2).max(10).default(5),
    test_size: z.number().min(0.05).max(0.5).default(0.2),
  }),
  search: z.enum(['grid', 'random']).default('grid'),
  trials: z.number().int().min(1).max(200).default(20),
  models: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z_]{1,40}$/),
        grid: z.record(z.string().max(400)).default({}),
      }),
    )
    .min(1)
    .max(20),
});
const finalSchema = base.extend({
  model: z.string().regex(/^[a-z_]{1,40}$/),
  params: z.record(z.string().max(100)).default({}),
  name: z.string().max(80).optional(),
  scores: z.record(z.number()).optional(),
  sweep: z.string().max(64).optional(),
});
const predictSchema = z.object({
  model: z.string().regex(/^models\/[A-Za-z0-9._-]{1,120}$/),
  rows: z
    .array(z.record(z.union([z.string(), z.number(), z.null()])))
    .max(1000)
    .optional(),
  file: z.string().min(1).max(500).optional(),
});
const skip = new Set([
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  'models',
]);

/** No-code tabular experiments: data inspection, sweeps, final models, inference. */
export class Lab {
  constructor(
    readonly root: string,
    readonly runs: Runs,
    readonly assets: string,
  ) {}
  private python() {
    const python = loadProject(this.root).environment.python;
    // Same resolution as project runs: virtualenv interpreters are symlinks by design.
    return python.includes('/') ? path.resolve(this.root, python) : python;
  }
  private call(mode: string, request: unknown, timeout = 120000) {
    return subprocess(
      this.python(),
      ['-m', 'aiide_lab', mode],
      request,
      timeout,
      {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PYTHONPATH: path.join(this.assets, 'python'),
        PYTHONNOUSERSITE: '1',
      } as NodeJS.ProcessEnv,
    );
  }
  private data(file: string) {
    const absolute = within(this.root, file);
    if (!/\.(csv|tsv|txt)$/i.test(file) || !fs.statSync(absolute).isFile())
      throw new Error('Choose a .csv or .tsv file in this workspace');
    return absolute;
  }
  catalog() {
    return this.call('catalog', {});
  }
  async sample() {
    const data = (await this.call('sample', {})) as { csv: string };
    const file = `iris-sample-${crypto.randomUUID().slice(0, 8)}.csv`;
    fs.writeFileSync(within(this.root, file, true), data.csv, { flag: 'wx' });
    return { file };
  }
  files() {
    const found: { file: string; bytes: number }[] = [];
    const walk = (directory: string, depth: number) => {
      if (depth > 4 || found.length >= 300) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || skip.has(entry.name)) continue;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.isFile() && /\.(csv|tsv)$/i.test(entry.name))
          found.push({
            file: path.relative(this.root, full).split(path.sep).join('/'),
            bytes: fs.statSync(full).size,
          });
      }
    };
    walk(this.root, 0);
    return found.sort((a, b) => a.file.localeCompare(b.file));
  }
  inspect(file: string) {
    return this.call('inspect', { file: this.data(file) }).then((r: any) => ({
      ...r,
      file,
    }));
  }
  sweep(input: unknown) {
    const config = sweepSchema.parse(input);
    this.data(config.file);
    const jobs =
      config.validation.type === 'kfold'
        ? Math.max(1, Math.min(os.cpus().length - 1, config.validation.folds))
        : 1;
    return this.runs.start(
      `sweep · ${config.target}`,
      undefined,
      { AIIDE_LAB_CONFIG: JSON.stringify({ ...config, jobs }) },
      {
        command: ['python', '-m', 'aiide_lab', 'sweep'],
        lab: { kind: 'sweep', config },
      },
    );
  }
  final(input: unknown) {
    const config = finalSchema.parse(input);
    this.data(config.file);
    return this.runs.start(
      `model · ${config.name || config.model}`,
      undefined,
      { AIIDE_LAB_CONFIG: JSON.stringify(config) },
      {
        command: ['python', '-m', 'aiide_lab', 'final'],
        lab: { kind: 'final', config },
      },
    );
  }
  models() {
    const directory = within(this.root, 'models', true);
    if (!fs.existsSync(directory)) return [];
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .flatMap((e) => {
        try {
          const meta = JSON.parse(
            fs.readFileSync(
              within(this.root, `models/${e.name}/model.json`),
              'utf8',
            ),
          );
          return meta.format === 'aiide-lab-v1'
            ? [{ ...meta, path: `models/${e.name}` }]
            : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.created - a.created);
  }
  predict(input: unknown) {
    const args = predictSchema.parse(input);
    const model = within(this.root, args.model);
    within(this.root, `${args.model}/model.joblib`);
    within(this.root, `${args.model}/model.json`);
    if (!fs.existsSync(path.join(model, 'model.json')))
      throw new Error('Choose a model trained in the Experiment lab');
    if (!args.file)
      return this.call('predict', { model, rows: args.rows || [] }, 60000);
    const output = `predictions/${path.basename(args.model)}-${Date.now()}.csv`;
    return this.call(
      'predict',
      {
        model,
        file: this.data(args.file),
        output: within(this.root, output, true),
        output_display: output,
      },
      300000,
    );
  }
}
