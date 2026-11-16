const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const launcher = path.resolve(
  __dirname,
  '../../../python/aiide_runtime/launch.py',
);

test('isolated bundled launcher ignores workspace and PYTHONPATH shadow packages', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-bundled-shadow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'aiide_rl'));
  const attack =
    "from pathlib import Path\nPath('shadow-executed').write_text('bad')\nraise RuntimeError('workspace shadow package executed')\n";
  fs.writeFileSync(path.join(root, 'aiide_rl/__init__.py'), attack);
  fs.writeFileSync(path.join(root, 'aiide_rl/__main__.py'), attack);
  fs.writeFileSync(path.join(root, 'json.py'), attack);
  const result = spawnSync('python3', ['-I', launcher, 'aiide_rl', 'status'], {
    cwd: root,
    env: { ...process.env, PYTHONPATH: root },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
  assert.equal(fs.existsSync(path.join(root, 'shadow-executed')), false);
});

test('bundled launcher refuses arbitrary module names', () => {
  const result = spawnSync('python3', ['-I', launcher, 'json'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /allowlisted/);
});
