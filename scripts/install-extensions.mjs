import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const versions = {
  'vscode/git': '1.95.3',
  'vscode/git-base': '1.95.3',
  'detachhead/basedpyright': '1.40.2',
  'ms-python/python': '2026.4.0',
  'ms-python/debugpy': '2026.6.0',
};
const directory = path.resolve('resources/plugins');
fs.mkdirSync(directory, { recursive: true });
const lockFile = path.resolve('resources/extensions.lock.json');
const lock = fs.existsSync(lockFile)
  ? JSON.parse(fs.readFileSync(lockFile, 'utf8'))
  : {};
for (const [id, version] of Object.entries(versions)) {
  const platform = `${process.platform}-${process.arch}`;
  const targetPlatform = id === 'ms-python/debugpy' ? platform : '';
  const key = targetPlatform ? `${id}/${platform}` : id;
  const filename = `${id.replace('/', '.')}-${version}${targetPlatform ? '@' + platform : ''}.vsix`,
    target = path.join(directory, filename);
  const url = `https://open-vsx.org/api/${id}/${targetPlatform ? platform + '/' : ''}${version}/file/${filename}`;
  if (!fs.existsSync(target)) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`${id}: HTTP ${response.status}`);
    fs.writeFileSync(
      target + '.tmp',
      Buffer.from(await response.arrayBuffer()),
    );
    fs.renameSync(target + '.tmp', target);
  }
  const sha256 = crypto
    .createHash('sha256')
    .update(fs.readFileSync(target))
    .digest('hex');
  if (lock[key] && lock[key].sha256 !== sha256)
    throw new Error(`Extension checksum mismatch: ${id}`);
  lock[key] = { version, url, sha256 };
  const unpacked = path.join(directory, filename.replace(/\.vsix$/, ''));
  if (!fs.existsSync(path.join(unpacked, 'extension/package.json'))) {
    fs.mkdirSync(unpacked, { recursive: true });
    execFileSync('unzip', ['-qo', target, '-d', unpacked]);
  }
  // Some upstream VSIXs declare a localization directory but omit it for English-only builds.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(unpacked, 'extension/package.json'), 'utf8'),
  );
  if (manifest.l10n === './l10n')
    fs.mkdirSync(path.join(unpacked, 'extension/l10n'), { recursive: true });
  console.log(`Verified ${id}@${version}`);
}
fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
