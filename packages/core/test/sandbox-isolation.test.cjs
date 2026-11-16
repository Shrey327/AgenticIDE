const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Sandbox, Store } = require('../lib');
const { AppleSandbox } = require('../lib/sandbox-apple');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-isolation-'));
  const store = new Store(path.join(root, 'db.sqlite'));
  const sandbox = new Sandbox(root, path.join(root, '.aiide/sessions'), store);
  sandbox.prepareImage = async () => {};
  t.after(async () => {
    await sandbox.stop();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, store, sandbox };
}

test('VM policy persists, denies weaker recovered sessions and never falls back to Docker', async (t) => {
  const { root, sandbox, store } = setup(t);
  sandbox.available = async () => true;
  const { id } = await sandbox.create();
  assert.equal(sandbox.status(id).engine, 'docker');
  sandbox.configure({ engine: 'apple-vm' });
  assert.throws(() => sandbox.run(id, 'echo must-not-run'), /dedicated VM/);
  assert.deepEqual(
    new Sandbox(root, path.join(root, '.aiide/sessions'), store).policy(),
    { engine: 'apple-vm' },
  );
  let docker = 0,
    pulls = 0;
  sandbox.available = Sandbox.prototype.available.bind(sandbox);
  sandbox.dockerAvailable = async () => {
    docker++;
    return true;
  };
  sandbox.prepareImage = async () => {
    pulls++;
  };
  sandbox.apple.status = async () => ({ available: false });
  await assert.rejects(sandbox.create(), /Dedicated VM isolation is required/);
  assert.equal(docker, 0);
  assert.equal(pulls, 0);
  assert.equal(sandbox.all().length, 1);
});

test('invalid isolation configuration fails closed before it can be read as a policy', (t) => {
  const { root, sandbox } = setup(t);
  assert.throws(() => sandbox.configure({ engine: 'host' }));
  assert.throws(() =>
    sandbox.configure({ engine: 'docker', fallback: 'host' }),
  );
  fs.mkdirSync(path.join(root, '.aiide'), { recursive: true });
  fs.writeFileSync(path.join(root, '.aiide/sandbox-policy.json'), 'null');
  assert.throws(() => sandbox.policy());
  fs.rmSync(path.join(root, '.aiide/sandbox-policy.json'));
  fs.symlinkSync(
    path.join(root, 'db.sqlite'),
    path.join(root, '.aiide/sandbox-policy.json'),
  );
  assert.throws(() => sandbox.policy(), /Symbolic/);
});

test('VM run policy keeps guest networking, privileges, mounts and environment explicit', () => {
  const apple = new AppleSandbox();
  const args = apple.args(
    'aiide-vm-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'a'.repeat(64),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '/tmp/source stage',
    'python:3.12-slim',
    'echo checked',
    false,
  );
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(value('--network'), 'none');
  assert.ok(args.includes('--no-dns'));
  assert.ok(args.includes('--read-only'));
  assert.equal(value('--cap-drop'), 'ALL');
  assert.equal(value('--memory'), '1G');
  assert.ok(args.includes('nproc=128:128'));
  assert.ok(args.includes('fsize=1073741824:1073741824'));
  assert.equal(
    value('--mount'),
    'type=bind,source=/tmp/source stage,target=/workspace',
  );
  assert.ok(!args.includes('--ssh'));
  assert.ok(!args.includes('--virtualization'));
  assert.ok(!args.includes('--publish'));
  assert.ok(args.includes('/usr/local/bin/python3'));
  assert.ok(args.some((arg) => arg.includes('libc.prctl(38,1')));
  for (const field of args.filter((_arg, i) => args[i - 1] === '--env'))
    assert.ok(field.includes('='));
  const online = apple.args(
    'x',
    'x',
    'x',
    '/tmp/stage',
    'python',
    'echo test',
    true,
  );
  assert.ok(!online.includes('--no-dns'));
  assert.throws(
    () =>
      apple.args(
        'x',
        'x',
        'x',
        '/tmp/comma,source=/private',
        'python',
        'echo test',
        false,
      ),
    /commas/,
  );
});

test('VM ownership checks require workspace, management marker, and matching per-command nonce', async () => {
  const apple = new AppleSandbox(),
    name = 'aiide-vm-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    owner = 'b'.repeat(64);
  let labels = {
      'aiide.workspace': owner,
      'aiide.managed': 'sandbox-vm-v1',
      'aiide.command': name.slice(9),
    },
    deletes = 0;
  apple.call = async (args) => {
    if (args[0] === 'inspect')
      return JSON.stringify([{ configuration: { id: name, labels } }]);
    if (args[0] === 'delete') deletes++;
    return '';
  };
  await apple.cancel(name, owner);
  assert.equal(deletes, 1);
  labels = { ...labels, 'aiide.command': 'foreign' };
  await apple.cancel(name, owner);
  assert.equal(deletes, 1);
  labels = { ...labels, 'aiide.workspace': 'other' };
  await apple.cancel(name, owner);
  assert.equal(deletes, 1);
  assert.equal(await apple.owned('../other', owner), undefined);
});

test('ambiguous CSV mount paths are rejected before images or stages are created', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-path,comma-'));
  const store = new Store(path.join(root, 'db.sqlite'));
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sandbox = new Sandbox(root, path.join(root, '.aiide/sessions'), store);
  sandbox.available = async () => {
    throw new Error('must not query runtime');
  };
  await assert.rejects(sandbox.create(), /commas/);
  assert.equal(fs.existsSync(path.join(root, '.aiide/sessions')), false);
});

test('a crashed environment setup reopens as interrupted instead of pretending work is still active', async (t) => {
  const { root, sandbox, store } = setup(t);
  sandbox.available = async () => true;
  const { id } = await sandbox.create();
  sandbox.sessions.get(id).status = 'preparing';
  sandbox.persist(sandbox.sessions.get(id));
  const recovered = new Sandbox(
    root,
    path.join(root, '.aiide/sessions'),
    store,
  );
  assert.equal(recovered.status(id).status, 'interrupted');
});
