import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { within } from './security';

export const projectSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1).max(100),
  environment: z
    .object({ python: z.string().default('.venv/bin/python') })
    .default({}),
  commands: z.record(z.array(z.string().max(4096)).min(1).max(100)).default({}),
  adapters: z
    .array(
      z.enum([
        'python',
        'langchain',
        'langgraph',
        'transformers',
        'pytorch',
        'sklearn',
      ]),
    )
    .default(['python']),
  connections: z.array(z.string()).default([]),
  training: z
    .object({
      framework: z
        .enum(['pytorch', 'transformers', 'sklearn', 'custom'])
        .default('custom'),
      resume: z.boolean().default(false),
    })
    .default({}),
  services: z
    .object({
      chat: z.string().optional(),
      embeddings: z.string().optional(),
      vectorStore: z.string().optional(),
    })
    .default({}),
  telemetry: z
    .object({
      captureContent: z.boolean().default(false),
      retentionDays: z.number().int().min(1).max(365).default(7),
      budgetMb: z.number().int().min(1).max(2048).default(2048),
      exportConnection: z.string().optional(),
    })
    .default({}),
});
export type Project = z.infer<typeof projectSchema>;
export function loadProject(root: string): Project {
  const file = within(root, '.aiide/project.yaml', true);
  if (!fs.existsSync(file))
    return projectSchema.parse({ version: 1, name: path.basename(root) });
  return projectSchema.parse(parse(fs.readFileSync(file, 'utf8')));
}
export function saveProject(root: string, input: unknown): Project {
  const config = projectSchema.parse(input),
    file = within(root, '.aiide/project.yaml', true);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, stringify(config), { mode: 0o600 });
  return config;
}
export function detectEnvironment(root: string) {
  const exists = (f: string) => fs.existsSync(path.join(root, f));
  const pyproject = exists('pyproject.toml')
    ? fs.readFileSync(within(root, 'pyproject.toml'), 'utf8')
    : '';
  return {
    python: exists('.venv/bin/python') ? '.venv/bin/python' : 'python3',
    manager: exists('uv.lock')
      ? 'uv'
      : exists('poetry.lock')
        ? 'poetry'
        : exists('Pipfile.lock')
          ? 'pipenv'
          : 'unmanaged',
    frameworks: [
      'langchain',
      'langgraph',
      'torch',
      'transformers',
      'sklearn',
    ].filter((f) => pyproject.includes(f)),
    locks: [
      'uv.lock',
      'poetry.lock',
      'Pipfile.lock',
      'requirements.txt',
    ].filter(exists),
  };
}
