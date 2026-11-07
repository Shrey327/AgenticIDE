import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const version = '0.140.0';
const platform =
  process.platform === 'darwin'
    ? 'darwin'
    : process.platform === 'linux'
      ? 'linux'
      : '';
const arch =
  process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : '';
if (!platform || !arch)
  throw new Error('Collector installer supports macOS/Linux on arm64/x64');
const filename = `otelcol-contrib_${version}_${platform}_${arch}.tar.gz`;
const checksums =
  'opentelemetry-collector-releases_otelcol-contrib_checksums.txt';
const base = `https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${version}`;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-collector-'));
try {
  for (const file of [checksums, filename]) {
    execFileSync(
      'curl',
      [
        '--fail',
        '--location',
        '--proto',
        '=https',
        '--tlsv1.2',
        '--output',
        path.join(temporary, file),
        `${base}/${file}`,
      ],
      { stdio: 'inherit' },
    );
  }
  const expected = fs
    .readFileSync(path.join(temporary, checksums), 'utf8')
    .split('\n')
    .find((line) => line.endsWith(filename))
    ?.split(/\s+/)[0];
  const actual = crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(temporary, filename)))
    .digest('hex');
  if (!expected || actual !== expected)
    throw new Error('Collector archive checksum mismatch');
  execFileSync('tar', [
    '-xzf',
    path.join(temporary, filename),
    '-C',
    temporary,
    'otelcol-contrib',
  ]);
  fs.mkdirSync('resources', { recursive: true });
  fs.copyFileSync(
    path.join(temporary, 'otelcol-contrib'),
    'resources/otelcol-contrib',
  );
  fs.chmodSync('resources/otelcol-contrib', 0o755);
  console.log(
    `Installed OpenTelemetry Collector ${version} (${platform}/${arch}), SHA256 ${actual}`,
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
