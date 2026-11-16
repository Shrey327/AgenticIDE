import fs from 'node:fs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { within, hash } from './security';

const schema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    readOnly: z.array(z.string().uuid()).max(8),
    legacy: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .min(1)
      .max(8),
  })
  .strict();
export type RagIdentity = z.infer<typeof schema>;
export const ragIdentityFile = '.aiide/rag-state/instance.json';
const policy = '.aiide/rag-state/.gitignore';

function bounded(root: string, name: string, maximum: number) {
  const descriptor = fs.openSync(
    within(root, name),
    fs.constants.O_RDONLY |
      (fs.constants.O_NOFOLLOW || 0) |
      (fs.constants.O_NONBLOCK || 0),
  );
  try {
    const info = fs.fstatSync(descriptor);
    if (!info.isFile() || info.size > maximum)
      throw new Error('RAG identity metadata must be bounded regular files');
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0,
      count;
    while (
      (count = fs.readSync(
        descriptor,
        buffer,
        size,
        buffer.length - size,
        null,
      ))
    ) {
      size += count;
      if (size > maximum)
        throw new Error('RAG identity metadata grew beyond its limit');
    }
    return buffer.subarray(0, size).toString('utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}
function read(root: string): RagIdentity {
  const value = schema.parse(JSON.parse(bounded(root, ragIdentityFile, 4096)));
  if (
    new Set([value.id, ...value.readOnly]).size !== value.readOnly.length + 1 ||
    new Set(value.legacy).size !== value.legacy.length
  )
    throw new Error('RAG identity has duplicate namespaces');
  return value;
}
function temporary(root: string, text: string) {
  const file = within(
    root,
    `.aiide/rag-state/${crypto.randomUUID()}.tmp`,
    true,
  );
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, text);
    fs.fsyncSync(descriptor);
  } catch (error) {
    fs.closeSync(descriptor);
    fs.unlinkSync(file);
    throw error;
  }
  fs.closeSync(descriptor);
  return file;
}
function create(root: string, name: string, text: string) {
  const file = within(root, name, true),
    staged = temporary(root, text);
  try {
    try {
      fs.linkSync(staged, file);
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
    }
  } finally {
    fs.unlinkSync(staged);
  }
}
function verifyPolicy(root: string) {
  if (bounded(root, policy, 4096) !== '*\n')
    throw new Error(
      'RAG state ignore policy changed; inspect the private metadata before continuing',
    );
}
export function loadRagIdentity(root: string) {
  fs.mkdirSync(within(root, '.aiide/rag-state', true), {
    recursive: true,
    mode: 0o700,
  });
  if (!fs.existsSync(within(root, policy, true))) create(root, policy, '*\n');
  verifyPolicy(root);
  if (!fs.existsSync(within(root, ragIdentityFile, true)))
    create(
      root,
      ragIdentityFile,
      JSON.stringify({
        version: 1,
        id: crypto.randomUUID(),
        readOnly: [],
        legacy: [hash(fs.realpathSync(root))],
      }),
    );
  return read(root);
}
export function replaceRagIdentity(
  root: string,
  expected: RagIdentity,
  next: RagIdentity,
) {
  verifyPolicy(root);
  if (JSON.stringify(read(root)) !== JSON.stringify(expected))
    throw new Error(
      'RAG identity changed; reopen the workspace before resetting it',
    );
  const file = within(root, ragIdentityFile),
    staged = temporary(root, JSON.stringify(schema.parse(next)));
  try {
    fs.renameSync(staged, file);
  } finally {
    if (fs.existsSync(staged)) fs.unlinkSync(staged);
  }
  return read(root);
}
