const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Sandbox, Store } = require('../lib');

function setup(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'aiide-sandbox-creation-'),
  );
  const store = new Store(path.join(root, '.aiide/test.sqlite'));
  const sandbox = new Sandbox(root, path.join(root, '.aiide/sessions'), store);
  t.after(async () => {
    await sandbox.stop();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, sandbox };
}

test(
  'shutdown cancels and awaits an actual image-pull CLI before creating source stages',
  { skip: process.platform === 'win32', timeout: 10000 },
  async (t) => {
    const { root, sandbox } = setup(t);
    const bin = path.join(root, 'bin'),
      pidFile = path.join(root, 'pull.pid');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'docker'),
      `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);if(args.includes('pull')){fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);}else if(args.includes('image')){process.exit(1);}else if(args.includes('context')){console.log('unix:///unused-fixture');}else{console.log('fixture');}\n`,
      { mode: 0o700 },
    );
    t.mock.method(sandbox, 'available', async () => true);
    const originalPath = process.env.PATH;
    process.env.PATH = bin + path.delimiter + originalPath;
    t.after(() => {
      process.env.PATH = originalPath;
    });
    const pending = assert.rejects(sandbox.create(), /abort/i);
    for (let i = 0; i < 200 && !fs.existsSync(pidFile); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(
      fs.existsSync(pidFile),
      'the image pull must have actually started',
    );
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await sandbox.stop();
    await pending;
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') break;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.deepEqual(sandbox.all(), []);
    await assert.rejects(sandbox.create(), /stopped/);
  },
);

test('shutdown during capability discovery cannot start a late image pull', async (t) => {
  const { sandbox } = setup(t);
  let available,
    pulls = 0;
  sandbox.available = () =>
    new Promise((resolve) => {
      available = resolve;
    });
  sandbox.prepareImage = async () => {
    pulls++;
  };
  const pending = assert.rejects(sandbox.create(), /abort|stopped/i);
  const stopped = sandbox.stop();
  available(true);
  await stopped;
  await pending;
  assert.equal(pulls, 0);
  assert.deepEqual(sandbox.all(), []);
});

test('VM-required policy blocks old Docker environment setup before any image/build action', async (t) => {
  const { root, sandbox } = setup(t);
  fs.writeFileSync(
    path.join(root, 'pyproject.toml'),
    '[project]\nname="fixture"\nversion="0.0.1"',
  );
  fs.writeFileSync(path.join(root, 'uv.lock'), 'fixture');
  sandbox.available = async () => true;
  sandbox.prepareImage = async () => {};
  const { id } = await sandbox.create();
  sandbox.configure({ engine: 'apple-vm' });
  let pulls = 0;
  sandbox.prepareImage = async () => {
    pulls++;
  };
  sandbox.apple.prepare = async () => {
    pulls++;
  };
  assert.throws(
    () => sandbox.prepareEnvironment(id),
    /requires a dedicated VM/,
  );
  assert.equal(pulls, 0);
  assert.equal(sandbox.status(id).status, 'ready');
});

test('a failed source-stage write cleans only its fresh partial stage and permits retry', async (t) => {
  const { root, sandbox } = setup(t);
  fs.writeFileSync(
    path.join(root, 'source.py'),
    'print("host source is retained")',
  );
  sandbox.available = async () => true;
  sandbox.prepareImage = async () => {};
  const original = fs.writeFileSync;
  const mocked = t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (
      String(file).includes('/.aiide/sessions/') &&
      String(file).endsWith('/source.py')
    )
      throw Object.assign(new Error('No space left'), { code: 'ENOSPC' });
    return original(file, ...args);
  });
  await assert.rejects(sandbox.create(), /No space/);
  assert.deepEqual(fs.readdirSync(path.join(root, '.aiide/sessions')), []);
  assert.deepEqual(sandbox.all(), []);
  assert.equal(
    fs.readFileSync(path.join(root, 'source.py'), 'utf8'),
    'print("host source is retained")',
  );
  mocked.mock.restore();
  const { id } = await sandbox.create();
  assert.equal(sandbox.status(id).status, 'ready');
});
