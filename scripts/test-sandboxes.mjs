import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import core from '../packages/core/lib/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-sandbox-real-'));
const directory = path.join(root, '.aiide/sessions');
fs.mkdirSync(path.dirname(directory), { recursive: true });
const store = new core.Store(path.join(root, '.aiide/test.sqlite'));
let sandbox = new core.Sandbox(root, directory, store);
try {
  fs.writeFileSync(path.join(root, 'main.py'), 'print("original")\n');
  fs.writeFileSync(path.join(root, '.env'), 'DO_NOT_STAGE=private\n');
  fs.writeFileSync(
    path.join(root, 'pyproject.toml'),
    '[project]\nname="sandbox-check"\nversion="0.1.0"\nrequires-python=">=3.12,<3.14"\ndependencies=[]\n[tool.uv]\npackage=false\n',
  );
  fs.writeFileSync(
    path.join(root, 'uv.lock'),
    'version = 1\nrevision = 3\nrequires-python = ">=3.12, <3.14"\n[[package]]\nname = "sandbox-check"\nversion = "0.1.0"\nsource = { virtual = "." }\n',
  );
  const { id } = await sandbox.create();
  const checked = await sandbox.run(
    id,
    `python - <<'PY'
import os,socket
assert os.getuid()!=0
assert not os.path.exists('/var/run/docker.sock')
assert not os.path.exists('/workspace/.env')
try: open('/outside', 'w')
except OSError: pass
else: raise AssertionError('Root filesystem writable')
try: socket.create_connection(('1.1.1.1',443),timeout=.3)
except OSError: pass
else: raise AssertionError('Network available')
open('main.py','w').write('print("staged")\\n')
print('isolation passed')
PY`,
  );
  assert.equal(checked.exitCode, 0, checked.output);
  assert.match(fs.readFileSync(path.join(root, 'main.py'), 'utf8'), /original/);
  const setup = await sandbox.prepareEnvironment(id);
  assert.equal(setup.exitCode, 0, setup.output);
  assert.equal(sandbox.status(id).environmentReady, true);
  const environment = await sandbox.run(
    id,
    'python -c "import sys; assert sys.prefix == \'/workspace/.venv\'; print(sys.prefix)"',
  );
  assert.equal(environment.exitCode, 0, environment.output);
  assert.equal(fs.existsSync(path.join(root, '.venv')), false);
  const running = sandbox.start(id, 'python -c "import time; time.sleep(120)"');
  assert.equal(running.status, 'running');
  let container;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      container = JSON.parse(
        execFileSync('docker', ['inspect', 'aiide-' + id], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      )[0];
      if (container.State.Running) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(container?.State.Running);
  assert.equal(container.HostConfig.NetworkMode, 'none');
  assert.equal(container.HostConfig.Memory, 1024 ** 3);
  assert.equal(container.HostConfig.ReadonlyRootfs, true);
  assert.equal(container.HostConfig.PidsLimit, 128);
  await sandbox.cancel(id);
  for (let i = 0; i < 40 && sandbox.sessions.get(id).child; i++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sandbox.status(id).status, 'cancelled');
  const budget = await sandbox.run(
    id,
    `python - <<'PY'
import time
for index in range(17):
    with open('quota-' + str(index), 'wb') as stream: stream.truncate(128 * 1024 * 1024)
time.sleep(30)
PY`,
  );
  assert.notEqual(budget.exitCode, 0);
  assert.equal(sandbox.status(id).status, 'resource-limit');
  const stage = sandbox.sessions.get(id).directory;
  for (const name of fs
    .readdirSync(stage)
    .filter((name) => name.startsWith('quota-')))
    fs.unlinkSync(path.join(stage, name));
  await sandbox.stop();
  sandbox = new core.Sandbox(root, directory, store);
  assert.equal(sandbox.status(id).environmentReady, true);
  execFileSync('docker', [
    'run',
    '-d',
    '--name',
    'aiide-' + id,
    '--label',
    `aiide.workspace=${core.hash(sandbox.root)}`,
    '--network=none',
    '--memory=64m',
    '--cap-drop=ALL',
    '--user=1000',
    sandbox.image,
    'python',
    '-c',
    'import time; time.sleep(30)',
  ]);
  await sandbox.recover();
  assert.equal(sandbox.status(id).status, 'interrupted');
  assert.throws(() =>
    execFileSync('docker', ['inspect', 'aiide-' + id], { stdio: 'pipe' }),
  );
  const changes = sandbox.diff(id);
  assert.equal(changes.length, 1);
  sandbox.apply(id, core.hash(JSON.stringify(changes)));
  assert.match(fs.readFileSync(path.join(root, 'main.py'), 'utf8'), /staged/);
  await sandbox.close(id);
  console.log(
    'PASS: real Docker isolation, resource/storage limits, cancellation, locked environment, orphan cleanup, source recovery and reviewed application',
  );
} finally {
  for (const session of sandbox.all())
    await sandbox.close(session.id).catch(() => {});
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
