import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { Connections } from './models';
import { subprocess } from './ssh';
import { endpoint, within } from './security';

const execute = promisify(execFile);
const schema = z.object({
  connection: z.string(),
  project: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  run: z
    .string()
    .regex(/^[\w-]+$/)
    .optional(),
  operation: z.enum(['runs', 'history', 'artifacts', 'artifact.files']),
  offset: z.number().int().min(0).max(1000).default(0),
  step: z.number().int().min(0).max(100000000).default(0),
  artifact: z.string().max(300).optional(),
});
export class Wandb {
  private installing?: Promise<unknown>;
  private pending = 0;
  readonly environment: string;
  readonly python: string;
  constructor(
    readonly root: string,
    readonly assets: string,
    readonly connections: Connections,
  ) {
    this.environment = within(root, '.aiide/connectors/wandb', true);
    this.python = path.join(this.environment, 'bin/python');
  }
  status() {
    return {
      installed: fs.existsSync(this.python),
      version: '0.23.0',
      installing: Boolean(this.installing),
    };
  }
  install() {
    if (this.installing) return this.installing;
    const promise = execute(
      'uv',
      [
        'sync',
        '--project',
        path.join(this.assets, 'python/connectors'),
        '--locked',
      ],
      {
        cwd: this.root,
        timeout: 180000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, UV_PROJECT_ENVIRONMENT: this.environment },
      },
    )
      .then(() => this.status())
      .finally(() => {
        this.installing = undefined;
      });
    this.installing = promise;
    return promise;
  }
  async query(input: unknown) {
    const args = schema.parse(input);
    if (args.operation !== 'runs' && !args.run)
      throw new Error('Select a W&B run');
    if (args.operation === 'artifact.files' && !args.artifact)
      throw new Error('Select a W&B artifact');
    if (!this.status().installed)
      throw new Error('Install the W&B reader first');
    const connection = this.connections.get(args.connection);
    if (connection.kind !== 'wandb') throw new Error('Select a W&B connection');
    endpoint(connection.url);
    const secret = connection.credentialRef
      ? await this.connections.vault.get(connection.credentialRef)
      : undefined;
    if (!secret)
      throw new Error(
        'Save a W&B API key in the connection; ambient credentials are not used',
      );
    if (this.pending >= 2)
      throw new Error('Two W&B requests are already in progress');
    this.pending++;
    try {
      return await subprocess(
        this.python,
        [path.join(this.assets, 'python/wandb_reader.py')],
        { ...args, url: connection.url, secret },
        30000,
        {
          PATH: process.env.PATH,
          HOME: this.environment,
          PYTHONPATH: path.join(this.assets, 'python'),
          WANDB_SILENT: 'true',
          WANDB_ERROR_REPORTING: 'false',
          WANDB_CONSOLE: 'off',
          WANDB_CONFIG_DIR: path.join(this.environment, 'config'),
        },
      );
    } finally {
      this.pending--;
    }
  }
}
