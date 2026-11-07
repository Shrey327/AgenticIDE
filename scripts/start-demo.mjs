import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(
  'npm',
  [
    'run',
    'start',
    '-w',
    '@aiide/desktop',
    '--',
    path.join(root, 'examples/local-lab'),
  ],
  { cwd: root, stdio: 'inherit' },
);
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
