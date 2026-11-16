import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
for (const [command, args] of [
  [process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:core']],
  [process.execPath, ['--test', 'packages/core/test/local-runs.test.cjs']],
]) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
