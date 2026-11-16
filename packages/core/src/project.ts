import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
export function ensurePrivateState(root: string) {
  const directory = within(root, '.aiide', true);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = within(root, '.aiide/.gitignore', true);
  if (fs.existsSync(file)) {
    if (!fs.statSync(file).isFile())
      throw new Error('Runtime ignore policy must be a regular file');
    return;
  }
  try {
    fs.writeFileSync(
      file,
      '# AIIDE runtime data stays local; project configuration can be shared.\n*\n!.gitignore\n!project.yaml\n',
      { flag: 'wx', mode: 0o600 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}
export function privateStateStatus(root: string) {
  try {
    const files = execFileSync(
      'git',
      ['-c', 'core.fsmonitor=false', 'ls-files', '-z', '--', '.aiide'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 1000,
        maxBuffer: 65536,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).split('\0');
    return {
      trackedPrivate: files
        .filter(
          (file) =>
            file &&
            !['.aiide/project.yaml', '.aiide/.gitignore'].includes(file),
        )
        .slice(0, 20),
    };
  } catch {
    return { trackedPrivate: [] as string[] };
  }
}
export function loadProject(root: string): Project {
  const file = within(root, '.aiide/project.yaml', true);
  if (!fs.existsSync(file))
    return projectSchema.parse({ version: 1, name: path.basename(root) });
  const info = fs.statSync(file);
  if (!info.isFile() || info.size > 2 * 1024 * 1024)
    throw new Error('Project manifest must be a regular file below 2 MB');
  return projectSchema.parse(parse(fs.readFileSync(file, 'utf8')));
}
export function saveProject(root: string, input: unknown): Project {
  const config = projectSchema.parse(input),
    file = within(root, '.aiide/project.yaml', true);
  const content = stringify(config);
  if (Buffer.byteLength(content) > 2 * 1024 * 1024)
    throw new Error('Project manifest exceeds 2 MB');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  ensurePrivateState(root);
  fs.writeFileSync(file, content, { mode: 0o600 });
  return config;
}
export function detectEnvironment(root: string) {
  const exists = (f: string) => fs.existsSync(path.join(root, f));
  if (
    exists('pyproject.toml') &&
    !fs.statSync(within(root, 'pyproject.toml')).isFile()
  )
    throw new Error('pyproject.toml must be a regular file');
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
