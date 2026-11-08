import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { Runs } from './runs';
import { loadProject } from './project';
import { subprocess } from './ssh';
import { within } from './security';

const modelPath = z.string().regex(/^models\/hf-[A-Za-z0-9_-]+$/);
const device = z.enum(['auto', 'cpu', 'mps', 'cuda']).default('auto');
const downloadSchema = z.object({
  repo: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/)
    .max(200),
  revision: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
    .max(100)
    .default('main'),
});
const trainSchema = z.object({
  model: modelPath,
  dataset: z.string().min(1).max(500),
  steps: z.number().int().min(1).max(10000).default(20),
  learningRate: z.number().min(0.000001).max(0.01).default(0.0002),
  batchSize: z.number().int().min(1).max(16).default(1),
  maxLength: z.number().int().min(16).max(2048).default(256),
  rank: z.number().int().min(1).max(64).default(8),
  device,
});

/** Public Hub downloads and local LoRA jobs use the project's Python environment. */
export class HuggingFace {
  private launching = false;
  constructor(
    readonly root: string,
    readonly runs: Runs,
    readonly assets: string,
  ) {}
  status() {
    const configured = loadProject(this.root).environment.python;
    const python = configured.includes('/')
      ? path.resolve(this.root, configured)
      : configured;
    return subprocess(python, ['-m', 'aiide_hf', 'status'], {}, 60000, {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PYTHONPATH: path.join(this.assets, 'python'),
      PYTHONNOUSERSITE: '1',
    } as NodeJS.ProcessEnv);
  }
  files() {
    const found: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 4 || found.length >= 300) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (
          entry.name.startsWith('.') ||
          ['node_modules', 'models', 'venv'].includes(entry.name)
        )
          continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.isFile() && /\.jsonl$/i.test(entry.name))
          found.push(path.relative(this.root, full).split(path.sep).join('/'));
      }
    };
    walk(this.root, 0);
    return found.sort();
  }
  models() {
    const directory = within(this.root, 'models', true);
    if (!fs.existsSync(directory)) return [];
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .flatMap((entry) => {
        if (!entry.isDirectory() || !/^hf-[A-Za-z0-9_-]+$/.test(entry.name))
          return [];
        try {
          const file = within(
            this.root,
            `models/${entry.name}/aiide-model.json`,
          );
          const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
          return meta.format === 'aiide-hf-v1'
            ? [{ ...meta, path: `models/${entry.name}` }]
            : [];
        } catch {
          return [];
        }
      });
  }
  private model(value: string) {
    const relative = modelPath.parse(value);
    if (!this.models().some((model) => model.path === relative))
      throw new Error('Select a completed Hub download or fine-tuned model');
    within(this.root, relative);
    return relative;
  }
  private async start(mode: string, config: Record<string, unknown>) {
    if (
      this.launching ||
      this.runs.store
        .runs()
        .some((run) => run.name.startsWith('hf ') && run.status === 'running')
    )
      throw new Error(
        'A Hub job is already running; finish or cancel it before starting another',
      );
    this.launching = true;
    try {
      const output =
        mode === 'generate'
          ? `.aiide/hf-results/${crypto.randomUUID()}.json`
          : `models/hf-${crypto.randomUUID()}`;
      within(this.root, output, true);
      const run = await this.runs.start(
        `hf ${mode} · ${config.repo || config.model}`,
        mode === 'train'
          ? {
              target: 'local',
              framework: 'transformers',
              parameters: config as Record<string, string | number | boolean>,
              cursor: 0,
              connection: 'connected',
            }
          : undefined,
        {
          AIIDE_HF_CONFIG: JSON.stringify({ ...config, output }),
          HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
          HF_HUB_DISABLE_TELEMETRY: '1',
        },
        {
          command: ['python', '-m', 'aiide_hf', mode],
          lab: undefined,
        },
      );
      const recorded = {
        ...run,
        configuration: {
          ...run.configuration,
          huggingface: { mode, output, model: config.model, repo: config.repo },
        },
      };
      this.runs.store.saveRun(recorded);
      return { ...recorded, output };
    } finally {
      this.launching = false;
    }
  }
  download(input: unknown) {
    return this.start('download', downloadSchema.parse(input));
  }
  train(input: unknown) {
    const config = trainSchema.parse(input);
    this.model(config.model);
    const data = within(this.root, config.dataset);
    if (
      !/\.jsonl$/i.test(data) ||
      !fs.statSync(data).isFile() ||
      fs.statSync(data).size > 50 * 1024 * 1024
    )
      throw new Error(
        'Choose a JSONL dataset up to 50 MB inside this workspace',
      );
    return this.start('train', config);
  }
  generate(input: unknown) {
    const config = z
      .object({
        model: modelPath,
        prompt: z.string().trim().min(1).max(16000),
        maxNewTokens: z.number().int().min(1).max(512).default(64),
        device,
      })
      .parse(input);
    this.model(config.model);
    return this.start('generate', config);
  }
  result(file: string) {
    if (!/^\.aiide\/hf-results\/[a-f0-9-]{36}\.json$/.test(file))
      throw new Error('Invalid generation result');
    const target = within(this.root, file, true);
    return fs.existsSync(target)
      ? JSON.parse(fs.readFileSync(target, 'utf8'))
      : null;
  }
}
