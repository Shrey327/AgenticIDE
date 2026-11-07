import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function within(
  root: string,
  relative: string,
  allowMissing = false,
): string {
  if (!relative || path.isAbsolute(relative) || relative.includes('\0'))
    throw new Error('A relative workspace path is required');
  const base = fs.realpathSync(root);
  const candidate = path.resolve(base, relative);
  if (!candidate.startsWith(base + path.sep))
    throw new Error('Path escapes workspace');
  let current = base;
  for (const part of path.relative(base, candidate).split(path.sep)) {
    current = path.join(current, part);
    let info: fs.Stats;
    try {
      info = fs.lstatSync(current);
    } catch (error: any) {
      if (allowMissing && error.code === 'ENOENT') continue;
      throw error;
    }
    if (info.isSymbolicLink())
      throw new Error('Symbolic links are not allowed');
  }
  return candidate;
}

export const excluded = (relative: string): boolean =>
  relative
    .split(/[\\/]/)
    .some(
      (p) =>
        [
          '.git',
          '.aiide',
          '.venv',
          'venv',
          'node_modules',
          '__pycache__',
          '.mypy_cache',
          '.pytest_cache',
          '.ruff_cache',
          '.ssh',
          '.aws',
          '.gnupg',
          '.npmrc',
          '.pypirc',
          '.mcp.json',
          '.codex',
          '.claude',
          '.cursor',
        ].includes(p) ||
        /^\.env(?:\.|$)/i.test(p) ||
        /(?:credentials|secrets?|id_rsa|id_ed25519|\.pem$|\.key$)/i.test(p),
    );

export function walk(root: string): string[] {
  const files: string[] = [];
  let total = 0;
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name),
        relative = path.relative(root, absolute);
      if (excluded(relative) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const size = fs.statSync(absolute).size;
        // Model weights and large datasets are artifacts, not agent source context.
        if (size > 2 * 1024 * 1024) continue;
        total += size;
        if (total > 50 * 1024 * 1024 || files.length >= 10000)
          throw new Error(
            'Workspace staging limit exceeded (2 MB/file, 50 MB total, 10,000 files)',
          );
        files.push(relative);
      }
    }
  };
  visit(root);
  return files.sort();
}

export const hash = (value: string | Buffer) =>
  crypto.createHash('sha256').update(value).digest('hex');
export function fingerprint(root: string): string {
  return hash(
    walk(root)
      .map((f) => `${f}:${hash(fs.readFileSync(within(root, f)))}`)
      .join('\n'),
  );
}

export function redact(value: unknown, captureContent = false): any {
  if (Array.isArray(value))
    return value.slice(0, 1000).map((v) => redact(v, captureContent));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 500)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      if (
        /api.?key|authorization|password|secret|access.?token|credential/i.test(
          key,
        )
      )
        result[key] = '[REDACTED]';
      else if (
        !captureContent &&
        typeof item !== 'number' &&
        typeof item !== 'boolean' &&
        /prompt|completion|input|output|content|document|state|message|body|payload|query|actual|expected|text|answer|passage/i.test(
          key,
        )
      )
        result[key] = '[CONTENT DISABLED]';
      else result[key] = redact(item, captureContent);
    }
    return result;
  }
  if (typeof value === 'string')
    return value
      .slice(0, 16384)
      .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
      .replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]{10,})\b/g, '[REDACTED]')
      .replace(
        /((?:api[_-]?key|password|secret|token)\s*[:=]\s*)[^\s,;"']+/gi,
        '$1[REDACTED]',
      );
  return value;
}

export function endpoint(value: string): URL {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new Error(
      'Use an HTTP(S) endpoint without credentials, query, or fragment',
    );
  if (
    url.protocol === 'http:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    throw new Error('Remote endpoints require HTTPS');
  return url;
}
