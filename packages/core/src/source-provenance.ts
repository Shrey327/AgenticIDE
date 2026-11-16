import fs from 'node:fs';
import crypto from 'node:crypto';
import { excluded, within } from './security';

export type UpstreamDocument = {
  file: string;
  hash: string;
  status: 'current' | 'changed' | 'unavailable';
  reason?: string;
};
export type SourceChecks = {
  cache: Map<string, string>;
  bytes: number;
};

/** This metadata is a freshness hint from reviewed text, never permission or verified truth. */
export function upstreamDocument(
  root: string,
  text: string,
  checks?: SourceChecks,
): UpstreamDocument | undefined {
  const marker =
    /^<!-- aiide-document-source-v1:([A-Za-z0-9_-]{1,4000}) -->\r?\n/.exec(
      text,
    );
  const legacy =
    /^# [^\r\n]{1,80}\r?\n\r?\nSource: ([^\r\n]{1,500})\r?\n\r?\nSHA-256: ([a-f0-9]{64})\r?\n\r?\n## Page [1-9][0-9]*\r?\n/.exec(
      text,
    );
  if (!marker && !legacy) return undefined;
  let file = 'invalid document provenance',
    expected = '';
  try {
    const entry = marker
      ? JSON.parse(Buffer.from(marker[1], 'base64url').toString('utf8'))
      : { file: legacy![1], hash: legacy![2] };
    if (
      typeof entry.file !== 'string' ||
      entry.file.length > 500 ||
      typeof entry.hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.hash)
    )
      throw new Error('Invalid original document metadata');
    file = entry.file;
    expected = entry.hash;
    if (excluded(file.toLowerCase()) || !/\.(pdf|txt|md)$/i.test(file))
      throw new Error('Original document path is protected or unsupported');
    const full = within(root, file);
    const previous = checks?.cache.get(full);
    if (previous)
      return {
        file,
        hash: expected,
        status: previous === expected ? 'current' : 'changed',
      };
    const descriptor = fs.openSync(
      full,
      fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW || 0) |
        (fs.constants.O_NONBLOCK || 0),
    );
    let actual;
    try {
      const info = fs.fstatSync(descriptor);
      if (!info.isFile() || info.size > 25 * 1024 * 1024)
        throw new Error('Original document must be a regular file below 25 MB');
      if (checks && checks.bytes + info.size > 256 * 1024 * 1024)
        throw new Error(
          'Upstream freshness scan exceeds 256 MB; review a smaller source set',
        );
      const digest = crypto.createHash('sha256'),
        buffer = Buffer.alloc(65536);
      let bytes = 0,
        count;
      while (
        (count = fs.readSync(descriptor, buffer, 0, buffer.length, null))
      ) {
        bytes += count;
        if (checks && checks.bytes + bytes > 256 * 1024 * 1024)
          throw new Error('Upstream freshness scan exceeds 256 MB');
        if (bytes > 25 * 1024 * 1024)
          throw new Error('Original document grew beyond 25 MB');
        digest.update(buffer.subarray(0, count));
      }
      if (checks) checks.bytes += bytes;
      actual = digest.digest('hex');
    } finally {
      fs.closeSync(descriptor);
    }
    const result: UpstreamDocument = {
      file,
      hash: expected,
      status: actual === expected ? 'current' : 'changed',
    };
    checks?.cache.set(full, actual);
    return result;
  } catch (error) {
    return {
      file,
      hash: expected,
      status: 'unavailable',
      reason: String(error),
    };
  }
}
