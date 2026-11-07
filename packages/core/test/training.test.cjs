const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, Workspace, saveProject, sshSchema, quote, bundledResources } = require('../lib');
const temporary = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-training-unit-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };

test('SSH validation rejects option injection and preserves literal shell arguments', () => {
  assert.throws(() => sshSchema.parse({ id: 'x', host: '-oProxyCommand=evil', root: '/project' }));
  assert.throws(() => sshSchema.parse({ id: 'x', host: 'host;touch /tmp/bad', root: '/project' }));
  assert.equal(quote("path with ' quote"), "'path with '\\'' quote'");
});

test('remote runs survive opening an existing database while local runs become interrupted', t => {
  const file = path.join(temporary(t), 'db.sqlite'); let store = new Store(file);
  const base = { name: 'train', status: 'running', started: Date.now(), project: 'test', command: [], configuration: {}, environment: {}, source: '' };
  store.saveRun({ ...base, id: 'remote', training: { target: 'ssh', cursor: 40, connection: 'disconnected', framework: 'custom', parameters: {} } });
  store.saveRun({ ...base, id: 'local', training: { target: 'local', cursor: 0, connection: 'connected', framework: 'pytorch', parameters: {} } });
  store.close(); store = new Store(file); t.after(() => store.close());
  assert.equal(store.run('remote').status, 'running'); assert.equal(store.run('remote').training.cursor, 40); assert.equal(store.run('local').status, 'interrupted');
});

test('training telemetry replay rolls back cursor and events together on disk failure', async t => {
  const workspace = await Workspace.open(temporary(t)); t.after(() => workspace.close());
  const run = { id: 'remote', name: 'train', status: 'running', started: Date.now(), project: 'test', command: [], configuration: {}, environment: {}, source: '', training: { target: 'ssh', cursor: 0, connection: 'connected', framework: 'custom', parameters: {}, profile: { id: 'test' } } };
  workspace.store.saveRun(run);
  workspace.training.ssh.request = async () => ({ status: 'completed', cursor: 120, records: [{ route: '/events', body: { events: [{ runId: 'malicious-other-run', kind: 'metric', name: 'loss', value: 0.5, timestamp: Date.now(), step: 1 }] } }] });
  const original = workspace.store.event.bind(workspace.store);
  workspace.store.event = e => { original(e); throw new Error('simulated disk failure'); };
  await workspace.training.sync(run.id);
  assert.equal(workspace.store.run(run.id).training.cursor, 0); assert.equal(workspace.store.events(run.id).length, 0);
  workspace.store.event = original;
  await workspace.training.sync(run.id);
  assert.equal(workspace.store.run(run.id).training.cursor, 120); assert.equal(workspace.store.events(run.id).length, 1); assert.equal(workspace.store.events('malicious-other-run').length, 0);
});

test('checkpoint inspection rejects missing state, unknown references and symlink escapes', async t => {
  const root = temporary(t), workspace = await Workspace.open(root); t.after(() => workspace.close());
  workspace.store.saveRun({ id: 'r', name: 'train', project: 'test', status: 'completed', started: Date.now(), command: [], source: '', configuration: {}, environment: {}, training: { target: 'local', framework: 'transformers', cursor: 0, connection: 'connected', parameters: {} } });
  fs.mkdirSync(path.join(root, 'checkpoint'));
  fs.writeFileSync(path.join(root, 'checkpoint/trainer_state.json'), '{"global_step":2}');
  workspace.store.event({ runId: 'r', kind: 'artifact', name: 'checkpoint', value: { path: 'checkpoint' }, timestamp: Date.now() });
  assert.equal((await workspace.training.artifact('r', 'checkpoint')).resumable, false);
  await assert.rejects(workspace.training.artifact('r', '../outside'));
  await assert.rejects(workspace.training.artifact('r', 'unregistered'));
  fs.symlinkSync(os.tmpdir(), path.join(root, 'checkpoint/escape'));
  await assert.rejects(workspace.training.artifact('r', 'checkpoint/escape'), /symlink/i);
});

test('metric downsampling preserves actual steps and endpoints', t => {
  const store = new Store(path.join(temporary(t), 'db.sqlite')); t.after(() => store.close());
  store.transaction(() => { for (let step = 0; step < 1500; step++) store.event({ runId: 'r', kind: 'metric', name: 'loss', value: 1 / (step + 1), timestamp: Date.now(), step: step * 2 }); });
  const points = store.metricSeries('r'); assert.equal(points.length, 500); assert.equal(points[0].step, 0); assert.equal(points.at(-1).step, 2998);
});

test('remote OTLP attributes cannot redirect telemetry into another run', async t => {
  const workspace = await Workspace.open(temporary(t)); t.after(() => workspace.close());
  const base = { name: 'train', status: 'running', started: Date.now(), project: 'test', command: [], configuration: {}, environment: {}, source: '' };
  workspace.store.saveRun({ ...base, id: 'other' });
  workspace.store.saveRun({ ...base, id: 'remote', training: { target: 'ssh', cursor: 0, connection: 'connected', framework: 'custom', parameters: {}, profile: { id: 'test' } } });
  workspace.training.ssh.request = async () => ({ status: 'completed', cursor: 100, records: [{ route: '/v1/metrics', body: { resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'loss', gauge: { dataPoints: [{ asDouble: 0.2, timeUnixNano: String(Date.now() * 1e6), attributes: [{ key: 'aiide.run.id', value: { stringValue: 'other' } }] }] } }] }] }] } }] });
  await workspace.training.sync('remote');
  assert.equal(workspace.store.events('other').length, 0);
  assert.equal(workspace.store.events('remote')[0].name, 'loss');
});
