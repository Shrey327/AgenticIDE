import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { excluded, hash, within } from './security';

const sourcePath = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (file) =>
      !file.includes('\\') &&
      file.endsWith('.py') &&
      !excluded(file.toLowerCase()) &&
      file.split('/').every((part) => part && part !== '.' && part !== '..'),
    'Select ordinary workspace Python source paths',
  );
const definitionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
    title: z.string().trim().min(1).max(100),
    entrypoint: sourcePath,
    factory: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/)
      .default('make_env'),
    files: z.array(sourcePath).min(1).max(20),
    parameters: z.record(z.unknown()).default({}),
  })
  .strict();
export const customEnvironmentSchema = definitionSchema
  .extend({
    files: z
      .array(
        z
          .object({
            file: sourcePath,
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type CustomEnvironment = z.infer<typeof customEnvironmentSchema>;

/** Source review never imports Python; execution is a separate explicit action. */
export class RLEnvironments {
  constructor(readonly root: string) {}
  private file(id: string) {
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(id))
      throw new Error('Invalid environment ID');
    return within(this.root, `.aiide/rl-environments/${id}.json`, true);
  }
  private source(file: string) {
    const full = within(this.root, sourcePath.parse(file));
    const descriptor = fs.openSync(
      full,
      fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW || 0) |
        (fs.constants.O_NONBLOCK || 0),
    );
    try {
      const info = fs.fstatSync(descriptor);
      if (!info.isFile() || info.size > 256000)
        throw new Error(
          'Environment sources must be regular files below 256 KB',
        );
      const bytes = Buffer.alloc(256001);
      const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
      if (count > 256000) throw new Error('Environment source exceeded 256 KB');
      const source = bytes.subarray(0, count);
      const content = new TextDecoder('utf-8', { fatal: true }).decode(source);
      return { file, sha256: hash(source), content };
    } finally {
      fs.closeSync(descriptor);
    }
  }
  preview(input: unknown) {
    const value = definitionSchema.parse(input);
    const files = [...new Set(value.files)].sort();
    if (!files.includes(value.entrypoint))
      throw new Error('Include the factory source in reviewed files');
    const sources = files.map((file) => this.source(file));
    if (
      sources.reduce(
        (size, source) => size + Buffer.byteLength(source.content),
        0,
      ) > 1000000
    )
      throw new Error('Reviewed environment sources exceed 1 MB');
    const validJson = (value: unknown, depth = 0): boolean =>
      depth <= 10 &&
      (value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value)) ||
        (Array.isArray(value) &&
          value.every((item) => validJson(item, depth + 1))) ||
        (typeof value === 'object' &&
          !Array.isArray(value) &&
          (Object.getPrototypeOf(value) === Object.prototype ||
            Object.getPrototypeOf(value) === null) &&
          Object.values(value!).every((item) => validJson(item, depth + 1))));
    if (!validJson(value.parameters))
      throw new Error(
        'Environment parameters must be finite JSON with at most ten nested levels',
      );
    const parameters = JSON.stringify(value.parameters);
    if (Buffer.byteLength(parameters) > 16000)
      throw new Error('Environment parameters must be finite JSON below 16 KB');
    const definition = {
      ...value,
      parameters: JSON.parse(parameters),
      files: sources.map(({ file, sha256 }) => ({ file, sha256 })),
    };
    const revision = hash(JSON.stringify(definition));
    return {
      definition: { ...definition, revision },
      sources,
      reviewHash: revision,
    };
  }
  register(input: unknown) {
    const args = definitionSchema
      .extend({
        reviewHash: z.string().regex(/^[a-f0-9]{64}$/),
        confirmed: z.literal(true),
      })
      .strict()
      .parse(input);
    const { reviewHash, confirmed: _confirmed, ...definition } = args;
    const preview = this.preview(definition);
    if (reviewHash !== preview.reviewHash)
      throw new Error('Environment sources or settings changed; review again');
    const file = this.file(args.id);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (
      !fs.existsSync(file) &&
      fs
        .readdirSync(path.dirname(file))
        .filter((name) => name.endsWith('.json')).length >= 100
    )
      throw new Error(
        'Limit custom environments to 100 registrations; remove obsolete records before adding another',
      );
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(preview.definition), {
        flag: 'wx',
        mode: 0o600,
      });
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    return preview.definition;
  }
  get(id: string) {
    const file = this.file(id),
      info = fs.statSync(file);
    if (!info.isFile() || info.size > 100000)
      throw new Error(
        'Environment registration must be a regular JSON file below 100 KB',
      );
    const value = customEnvironmentSchema.parse(
      JSON.parse(fs.readFileSync(file, 'utf8')),
    );
    if (value.id !== id)
      throw new Error('Environment registration ID mismatch');
    const { revision: _revision, ...definition } = value;
    const preview = this.preview({
      ...definition,
      files: value.files.map((source) => source.file),
    });
    if (preview.reviewHash !== value.revision)
      throw new Error(
        'Registered environment changed; review and register its sources again',
      );
    return value;
  }
  list() {
    const directory = within(this.root, '.aiide/rl-environments', true);
    if (!fs.existsSync(directory)) return [];
    return fs
      .readdirSync(directory)
      .filter((name) => /^[a-z][a-z0-9_-]{0,39}\.json$/.test(name))
      .slice(0, 100)
      .map((name) => {
        const id = name.slice(0, -5);
        try {
          const value = this.get(id);
          return { ...value, ready: true, error: '' };
        } catch (error) {
          return { id, title: id, ready: false, error: String(error) };
        }
      });
  }
}
