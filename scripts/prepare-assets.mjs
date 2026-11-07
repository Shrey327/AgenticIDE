import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'packages/core/resources');
fs.mkdirSync(destination, { recursive: true });
for (const directory of ['python', 'templates'])
  fs.cpSync(path.join(root, directory), path.join(destination, directory), {
    recursive: true,
    filter: (source) =>
      !source.includes('__pycache__') &&
      !source.includes('.venv') &&
      !source.includes('.egg-info'),
  });
const collector = path.join(root, 'resources/otelcol-contrib');
const plugins = path.join(root, 'resources/plugins');
if (fs.existsSync(plugins)) {
  const target = path.join(destination, 'plugins');
  fs.mkdirSync(target, { recursive: true });
  for (const file of fs.readdirSync(target))
    if (file.endsWith('.vsix')) fs.unlinkSync(path.join(target, file));
  fs.cpSync(plugins, target, {
    recursive: true,
    filter: (source) => !source.endsWith('.vsix'),
  });
}
if (fs.existsSync(collector)) {
  const target = path.join(destination, 'otelcol-contrib');
  const digest = (file) =>
    crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (!fs.existsSync(target) || digest(collector) !== digest(target)) {
    fs.copyFileSync(collector, target + '.tmp');
    fs.chmodSync(target + '.tmp', 0o755);
    fs.renameSync(target + '.tmp', target);
  }
}
