const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, fork } = require('node:child_process');
const { Sandbox, Store, hash } = require('../lib');

test('sandbox source, conflict baseline and environment state survive reopening; discard is explicit', async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'aiide-sandbox-recovery-'),
  );
  const store = new Store(path.join(root, 'store.sqlite'));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(root, 'main.py'), 'before');
  const directory = path.join(root, '.aiide', 'sessions');
  const sandbox = new Sandbox(root, directory, store);
  sandbox.available = async () => true;
  sandbox.prepareImage = async () => {};
  const { id } = await sandbox.create();
  sandbox.write(id, 'main.py', 'after');
  await sandbox.stop();
  const recovered = new Sandbox(root, directory, store);
  assert.equal(recovered.all()[0].id, id);
  const changes = recovered.diff(id);
  assert.equal(
    changes.find((change) => change.file === 'main.py').after,
    'after',
  );
  recovered.apply(id, hash(JSON.stringify(changes)));
  assert.equal(fs.readFileSync(path.join(root, 'main.py'), 'utf8'), 'after');
  const reopened = new Sandbox(root, directory, store);
  assert.deepEqual(reopened.diff(id), []);
  await reopened.close(id);
  assert.deepEqual(new Sandbox(root, directory, store).all(), []);
});

test('malformed recovery records cannot select arbitrary directories or protected baseline paths', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'aiide-sandbox-bad-record-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, '.aiide/sandbox-state');
  fs.mkdirSync(directory, { recursive: true });
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  fs.writeFileSync(
    path.join(directory, id + '.json'),
    JSON.stringify({
      id,
      status: 'ready',
      output: '',
      created: 1,
      baseline: { '../escape': 'a'.repeat(64) },
    }),
  );
  const sandbox = new Sandbox(root, path.join(root, '.aiide/sessions'), {});
  assert.deepEqual(sandbox.all(), []);
  assert.equal(sandbox.recoveryErrors.length, 1);
  assert.ok(fs.existsSync(path.join(directory, id + '.json')));
});

test('sandbox persistence failures remain visible without escaping command lifecycle callbacks', async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'aiide-sandbox-full-disk-'),
  );
  const store = new Store(path.join(root, 'store.sqlite'));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sandbox = new Sandbox(root, path.join(root, '.aiide/sessions'), store);
  sandbox.available = async () => true;
  sandbox.prepareImage = async () => {};
  const { id } = await sandbox.create();
  const original = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (String(file).includes('sandbox-state') && String(file).endsWith('.tmp'))
      throw Object.assign(new Error('No space left'), { code: 'ENOSPC' });
    return original(file, ...args);
  });
  assert.doesNotThrow(() => sandbox.persist(sandbox.sessions.get(id)));
  assert.match(sandbox.recoveryErrors.at(-1), /could not be saved/);
  assert.ok(store.dropped > 0);
});

test(
  'shutdown aborts environment preparation before it can launch a networked install',
  { timeout: 5000 },
  async (t) => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'aiide-sandbox-preparing-'),
    );
    const store = new Store(path.join(root, 'store.sqlite'));
    t.after(() => {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    fs.writeFileSync(
      path.join(root, 'pyproject.toml'),
      '[project]\nname="fixture"\nversion="0.1.0"',
    );
    fs.writeFileSync(path.join(root, 'uv.lock'), 'fixture');
    const sandbox = new Sandbox(
      root,
      path.join(root, '.aiide/sessions'),
      store,
    );
    sandbox.available = async () => true;
    sandbox.prepareImage = async () => {};
    const { id } = await sandbox.create();
    let installs = 0;
    sandbox.run = async () => {
      installs++;
      return { exitCode: 0, output: '' };
    };
    sandbox.prepareImage = async (_image, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => reject(new Error('Preparation aborted')),
          { once: true },
        ),
      );
    const pending = assert.rejects(sandbox.prepareEnvironment(id), /aborted/);
    assert.throws(() => sandbox.start(id, 'echo duplicate'), /already running/);
    assert.equal(sandbox.status(id).status, 'preparing');
    await sandbox.stop();
    await pending;
    assert.equal(installs, 0);
    assert.equal(sandbox.status(id).status, 'cancelled');
  },
);

async function setup(t, files = { 'main.py': 'before' }) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'aiide-sandbox-lifecycle-'),
  );
  const store = new Store(path.join(root, '.aiide/test.sqlite'));
  const sandbox = new Sandbox(root, path.join(root, '.aiide/sessions'), store);
  t.after(async () => {
    for (const session of sandbox.all())
      await sandbox.close(session.id).catch(() => {});
    await sandbox.stop();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const [file, text] of Object.entries(files))
    fs.writeFileSync(path.join(root, file), text);
  sandbox.available = async () => true;
  sandbox.prepareImage = async () => {};
  const { id } = await sandbox.create();
  return { root: sandbox.root, sandbox, id };
}

test('failed apply removes only its own partially written temporary file', async (t) => {
  const { root, sandbox, id } = await setup(t);
  sandbox.write(id, 'main.py', 'after');
  const reviewed = hash(JSON.stringify(sandbox.diff(id)));
  const originalWrite = fs.writeFileSync;
  let targetFd;
  const originalOpen = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    const fd = originalOpen(file, ...args);
    if (String(file) === path.join(root, 'main.py.aiide-tmp')) targetFd = fd;
    return fd;
  });
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (file === targetFd) {
      originalWrite(file, 'partial');
      throw Object.assign(new Error('No space left on device'), {
        code: 'ENOSPC',
      });
    }
    return originalWrite(file, ...args);
  });
  assert.throws(() => sandbox.apply(id, reviewed), /No space/);
  assert.equal(fs.readFileSync(path.join(root, 'main.py'), 'utf8'), 'before');
  assert.ok(!fs.existsSync(path.join(root, 'main.py.aiide-tmp')));
});

test('failed rename rolls back earlier applies and cleans the owned temporary file', async (t) => {
  const { root, sandbox, id } = await setup(t, {
    'a.txt': 'old a',
    'b.txt': 'old b',
  });
  sandbox.write(id, 'a.txt', 'new a');
  sandbox.write(id, 'b.txt', 'new b');
  const changes = sandbox.diff(id),
    originalRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (String(source) === path.join(root, 'b.txt.aiide-tmp'))
      throw Object.assign(new Error('Rename refused'), { code: 'EACCES' });
    return originalRename(source, target);
  });
  assert.throws(
    () => sandbox.apply(id, hash(JSON.stringify(changes))),
    /Rename refused/,
  );
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'old a');
  assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'old b');
  assert.ok(!fs.existsSync(path.join(root, 'a.txt.aiide-tmp')));
  assert.ok(!fs.existsSync(path.join(root, 'b.txt.aiide-tmp')));
  assert.deepEqual(sandbox.diff(id), changes);
  t.mock.restoreAll();
  sandbox.apply(id, hash(JSON.stringify(changes)));
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'new a');
  assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'new b');
});

test('apply preserves a preexisting temporary file when exclusive creation fails', async (t) => {
  const { root, sandbox, id } = await setup(t);
  sandbox.write(id, 'main.py', 'after');
  fs.writeFileSync(
    path.join(root, 'main.py.aiide-tmp'),
    'user-owned temporary data',
  );
  assert.throws(
    () => sandbox.apply(id, hash(JSON.stringify(sandbox.diff(id)))),
    /exist/i,
  );
  assert.equal(fs.readFileSync(path.join(root, 'main.py'), 'utf8'), 'before');
  assert.equal(
    fs.readFileSync(path.join(root, 'main.py.aiide-tmp'), 'utf8'),
    'user-owned temporary data',
  );
});

test('apply rollback restores deleted executable permissions and modification preserves them under a restrictive umask', { skip: process.platform === 'win32' }, async (t) => {
  const { root, sandbox, id } = await setup(t, {
    'a-run.sh': '#!/bin/sh\necho before\n',
    'z-result.txt': 'before',
  });
  const executable = path.join(root, 'a-run.sh'),
    stage = sandbox.sessions.get(id).directory,
    originalRename = fs.renameSync;
  fs.chmodSync(executable, 0o751);
  fs.unlinkSync(path.join(stage, 'a-run.sh'));
  sandbox.write(id, 'z-result.txt', 'after');
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (String(source) === path.join(root, 'z-result.txt.aiide-tmp'))
      throw new Error('Injected rename failure');
    return originalRename(source, target);
  });
  const mask = process.umask(0o077);
  try {
    assert.throws(
      () => sandbox.apply(id, hash(JSON.stringify(sandbox.diff(id)))),
      /Injected rename failure/,
    );
    assert.equal(fs.statSync(executable).mode & 0o777, 0o751);
    assert.equal(fs.readFileSync(executable, 'utf8'), '#!/bin/sh\necho before\n');
    assert.equal(fs.readFileSync(path.join(root, 'z-result.txt'), 'utf8'), 'before');
    t.mock.restoreAll();
    sandbox.write(id, 'a-run.sh', '#!/bin/sh\necho after\n');
    sandbox.apply(id, hash(JSON.stringify(sandbox.diff(id))));
    assert.equal(fs.statSync(executable).mode & 0o777, 0o751);
    assert.equal(fs.readFileSync(executable, 'utf8'), '#!/bin/sh\necho after\n');
  } finally {
    process.umask(mask);
  }
});

function dockerFixtureAvailable(t) {
  try {
    execFileSync(
      'docker',
      ['image', 'inspect', 'python:3.12.12-slim-bookworm'],
      { stdio: 'ignore', timeout: 5000 },
    );
    return true;
  } catch {
    t.skip(
      'Real sandbox lifecycle checks require Docker and the cached pinned Python image',
    );
    return false;
  }
}
async function ready(sandbox, id) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (sandbox.status(id).output.includes('fixture ready')) return;
    if (sandbox.status(id).status !== 'running')
      assert.fail(JSON.stringify(sandbox.status(id)));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('Real Docker command did not become ready');
}

test(
  'real Docker start rejects preflight duplicates and close waits without resurrecting recovery',
  { timeout: 25000 },
  async (t) => {
    if (!dockerFixtureAvailable(t)) return;
    const { root, sandbox, id } = await setup(t);
    const stage = sandbox.sessions.get(id).directory;
    sandbox.start(
      id,
      `python -u -c "import time;print('fixture ready');time.sleep(120)"`,
    );
    const operation = sandbox.commands.get(id);
    assert.throws(() => sandbox.start(id, 'echo duplicate'), /already running/);
    await assert.rejects(sandbox.run(id, 'echo duplicate'), /already running/);
    assert.equal(sandbox.commands.get(id), operation);
    assert.equal(sandbox.status(id).status, 'running');
    await ready(sandbox, id);
    const child = sandbox.sessions.get(id).child;
    await sandbox.close(id);
    assert.notEqual(child.exitCode === null && child.signalCode === null, true);
    assert.equal(sandbox.commands.size, 0);
    assert.deepEqual(sandbox.all(), []);
    assert.ok(!fs.existsSync(stage));
    const record = path.join(root, '.aiide/sandbox-state', id + '.json');
    assert.ok(!fs.existsSync(record));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(!fs.existsSync(record));
    assert.throws(() =>
      execFileSync('docker', ['inspect', 'aiide-' + id], { stdio: 'ignore' }),
    );
  },
);

test(
  'real Docker stop waits for command callbacks before returning and preserves cancelled recovery',
  { timeout: 25000 },
  async (t) => {
    if (!dockerFixtureAvailable(t)) return;
    const { root, sandbox, id } = await setup(t);
    sandbox.start(
      id,
      `python -u -c "import time;print('fixture ready');time.sleep(120)"`,
    );
    await ready(sandbox, id);
    await sandbox.stop();
    assert.equal(sandbox.sessions.get(id).child, undefined);
    assert.equal(sandbox.commands.size, 0);
    assert.equal(sandbox.status(id).status, 'cancelled');
    assert.throws(() => sandbox.start(id, 'echo late launch'), /closed/);
    const record = path.join(root, '.aiide/sandbox-state', id + '.json');
    assert.equal(JSON.parse(fs.readFileSync(record)).status, 'cancelled');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(JSON.parse(fs.readFileSync(record)).status, 'cancelled');
    assert.throws(() =>
      execFileSync('docker', ['inspect', 'aiide-' + id], { stdio: 'ignore' }),
    );
  },
);

function inspectContainer(name) {
  try {
    return JSON.parse(
      execFileSync('docker', ['inspect', name], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      }),
    )[0];
  } catch {
    return undefined;
  }
}

test(
  'actual IDE SIGKILL removes a TERM-resistant Docker container without reopening the workspace',
  { skip: process.platform === 'win32', timeout: 35000 },
  async (t) => {
    if (!dockerFixtureAvailable(t)) return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-sandbox-crash-'));
    const script = path.join(root, 'ide.cjs');
    fs.writeFileSync(
      script,
      `
    const path = require('node:path');
    const {Sandbox,Store} = require(${JSON.stringify(path.resolve(__dirname, '../lib'))});
    (async()=>{
      const root=${JSON.stringify(root)};
      const sandbox=new Sandbox(root,path.join(root,'.aiide/sessions'),new Store(path.join(root,'.aiide/test.sqlite')));
      sandbox.available=async()=>true; sandbox.prepareImage=async()=>{};
      const {id}=await sandbox.create();
      sandbox.start(id, 'python -u -c "import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);print(\\\'fixture ready\\\');time.sleep(120)"');
      const timer=setInterval(()=>{
        if(sandbox.status(id).output.includes('fixture ready')){clearInterval(timer);process.send({id,guardian:sandbox.sessions.get(id).child.pid});}
      },20);
    })().catch(error=>{console.error(error);process.exit(1)});
  `,
    );
    const ide = fork(script, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = '',
      name;
    ide.stdout.on('data', (data) => {
      output += data;
    });
    ide.stderr.on('data', (data) => {
      output += data;
    });
    t.after(() => {
      if (ide.exitCode === null && ide.signalCode === null) ide.kill('SIGKILL');
      if (name) {
        try {
          execFileSync('docker', ['rm', '-f', name], {
            stdio: 'ignore',
            timeout: 5000,
          });
        } catch {}
      }
      fs.rmSync(root, { recursive: true, force: true });
    });
    const message = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('IDE fixture did not start: ' + output)),
        15000,
      );
      ide.once('message', (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      ide.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error('IDE fixture exited: ' + code + ' ' + output));
      });
    });
    name = 'aiide-' + message.id;
    assert.equal(inspectContainer(name)?.State.Running, true);
    ide.kill('SIGKILL');
    await new Promise((resolve) => ide.once('exit', resolve));
    const deadline = Date.now() + 16000;
    while (Date.now() < deadline && inspectContainer(name))
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      inspectContainer(name),
      undefined,
      'Orphan container remained after IDE death',
    );
    assert.ok(
      fs.existsSync(
        path.join(root, '.aiide/sandbox-state', message.id + '.json'),
      ),
    );
  },
);

test(
  'guardian refuses same-name containers from another workspace or a later command',
  { skip: process.platform === 'win32', timeout: 20000 },
  async (t) => {
    if (!dockerFixtureAvailable(t)) return;
    const command = require('node:crypto').randomUUID();
    for (const [owner, instance] of [
      ['another-owner', command],
      ['f'.repeat(64), require('node:crypto').randomUUID()],
    ]) {
      const name = 'aiide-' + require('node:crypto').randomUUID();
      const foreign = execFileSync(
        'docker',
        [
          'run',
          '-d',
          '--rm',
          '--network=none',
          '--name',
          name,
          '--label',
          'aiide.workspace=' + owner,
          '--label',
          'aiide.command=' + instance,
          'python:3.12.12-slim-bookworm',
          'sleep',
          '120',
        ],
        { encoding: 'utf8', timeout: 5000 },
      ).trim();
      t.after(() => {
        try {
          execFileSync('docker', ['rm', '-f', foreign], {
            stdio: 'ignore',
            timeout: 5000,
          });
        } catch {}
      });
      const helper = path.resolve(
        __dirname,
        '../../../python/aiide_runtime/sandbox.py',
      );
      const child = spawn(
        'python3',
        [
          '-I',
          helper,
          name,
          'f'.repeat(64),
          command,
          'run',
          '--rm',
          '--name',
          name,
          '--label',
          'aiide.workspace=' + 'f'.repeat(64),
          'python:3.12.12-slim-bookworm',
          'sleep',
          '120',
        ],
        { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] },
      );
      child.stdio[3].on('error', () => {});
      await new Promise((resolve, reject) => {
        child.once('exit', resolve);
        child.once('error', reject);
      });
      assert.equal(inspectContainer(name)?.Id, foreign);
      assert.equal(inspectContainer(name)?.State.Running, true);
    }
  },
);

test(
  'guardian handles an in-flight Docker create after the IDE dies',
  { skip: process.platform === 'win32', timeout: 25000 },
  async (t) => {
    if (!dockerFixtureAvailable(t)) return;
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'aiide-sandbox-create-race-'),
    );
    const name = 'aiide-' + require('node:crypto').randomUUID(),
      owner = hash(root),
      command = require('node:crypto').randomUUID();
    const binary = execFileSync('which', ['docker'], {
      encoding: 'utf8',
    }).trim();
    const bin = path.join(root, 'bin'),
      marker = path.join(root, 'creating');
    fs.mkdirSync(bin);
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    fs.writeFileSync(
      path.join(bin, 'docker'),
      `#!/bin/sh\nif [ "$1" = run ]; then\n: > ${quote(marker)}\nsleep .6\nfi\nexec ${quote(binary)} "$@"\n`,
      { mode: 0o700 },
    );
    const script = path.join(root, 'ide.cjs');
    const helper = path.resolve(
      __dirname,
      '../../../python/aiide_runtime/sandbox.py',
    );
    fs.writeFileSync(
      script,
      `
    const fs=require('node:fs');
    const {spawn}=require('node:child_process');
    const child=spawn('python3',['-I',${JSON.stringify(helper)},${JSON.stringify(name)},${JSON.stringify(owner)},${JSON.stringify(command)},'run','--rm','--name',${JSON.stringify(name)},'--label',${JSON.stringify('aiide.workspace=' + owner)},'--label',${JSON.stringify('aiide.command=' + command)},'python:3.12.12-slim-bookworm','sleep','120'],{detached:true,stdio:['ignore','ignore','ignore','pipe']});
    child.stdio[3].on('error',()=>{});
    const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)})){clearInterval(timer);process.send({guardian:child.pid});}},10);
  `,
    );
    const since = Math.floor(Date.now() / 1000) - 1;
    const ide = fork(script, [], {
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let guardian;
    t.after(() => {
      if (ide.exitCode === null && ide.signalCode === null) ide.kill('SIGKILL');
      try {
        execFileSync('docker', ['rm', '-f', name], {
          stdio: 'ignore',
          timeout: 5000,
        });
      } catch {}
      fs.rmSync(root, { recursive: true, force: true });
    });
    guardian = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Delayed create did not launch')),
        10000,
      );
      ide.once('message', (message) => {
        clearTimeout(timer);
        resolve(message.guardian);
      });
    });
    ide.kill('SIGKILL');
    const alive = () => {
      try {
        process.kill(guardian, 0);
        return true;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 16000;
    while (alive() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(alive(), false, 'Guardian did not finish bounded cleanup');
    const events = execFileSync(
      'docker',
      [
        'events',
        '--since',
        String(since),
        '--until',
        String(Math.floor(Date.now() / 1000) + 1),
        '--filter',
        'type=container',
        '--filter',
        'event=create',
        '--filter',
        'label=aiide.workspace=' + owner,
        '--format',
        '{{.Actor.ID}}',
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
    assert.match(
      events,
      /[a-f0-9]{64}/,
      'Fixture never reached an actual delayed Docker create',
    );
    assert.equal(inspectContainer(name), undefined);
  },
);

test(
  'cancellation uses the inspected immutable ID when a foreign container replaces its name',
  { timeout: 20000 },
  async (t) => {
    if (!dockerFixtureAvailable(t)) return;
    const { root, sandbox, id } = await setup(t);
    const name = 'aiide-' + id;
    const binary = execFileSync('which', ['docker'], {
      encoding: 'utf8',
    }).trim();
    const owned = execFileSync(
      binary,
      [
        'run',
        '-d',
        '--rm',
        '--name',
        name,
        '--label',
        'aiide.workspace=' + hash(root),
        'python:3.12.12-slim-bookworm',
        'sleep',
        '120',
      ],
      { encoding: 'utf8', timeout: 5000 },
    ).trim();
    const bin = path.join(root, 'bin'),
      marker = path.join(root, 'swapped');
    fs.mkdirSync(bin);
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    fs.writeFileSync(
      path.join(bin, 'docker'),
      `#!/bin/sh\nfor target; do :; done\nif [ "$1" = inspect ] && [ "$target" = ${quote(name)} ] && [ ! -e ${quote(marker)} ]; then\nresult=$(${quote(binary)} "$@") || exit $?\n: > ${quote(marker)}\n${quote(binary)} rename ${quote(name)} ${quote(name + '-old')} || exit $?\n${quote(binary)} run -d --rm --name ${quote(name)} --label aiide.workspace=another-owner python:3.12.12-slim-bookworm sleep 120 > /dev/null || exit $?\nprintf '%s\\n' "$result"\nelse\nexec ${quote(binary)} "$@"\nfi\n`,
      { mode: 0o700 },
    );
    const originalPath = process.env.PATH;
    t.after(() => {
      for (const container of [owned, name]) {
        try {
          execFileSync(binary, ['rm', '-f', container], {
            stdio: 'ignore',
            timeout: 5000,
          });
        } catch {}
      }
    });
    try {
      process.env.PATH = bin + path.delimiter + originalPath;
      await sandbox.cancel(id);
    } finally {
      process.env.PATH = originalPath;
    }
    assert.ok(fs.existsSync(marker));
    assert.equal(inspectContainer(owned), undefined);
    const foreign = inspectContainer(name);
    assert.equal(foreign?.Config.Labels['aiide.workspace'], 'another-owner');
    assert.equal(foreign?.State.Running, true);
  },
);
