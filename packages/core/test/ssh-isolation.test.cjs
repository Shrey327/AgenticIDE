const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Ssh } = require('../lib/ssh');

test('trusted SSH bootstrap ignores workspace standard-library shadow modules', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-ssh-isolated-'));
  const cwd = process.cwd(),
    assets = path.resolve(__dirname, '../../../');
  t.after(() => {
    process.chdir(cwd);
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, '.aiide'));
  const marker = path.join(root, 'unreviewed-module-ran');
  fs.writeFileSync(
    path.join(root, 'json.py'),
    `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('unsafe')\nraise RuntimeError('must never import workspace json')\n`,
  );
  const ssh = new Ssh(path.join(root, '.aiide'), assets);
  process.chdir(root);
  const result = await ssh.local(root, { action: 'probe' });
  assert.ok(result);
  assert.equal(fs.existsSync(marker), false);
});
