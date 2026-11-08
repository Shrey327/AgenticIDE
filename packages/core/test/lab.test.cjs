const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Lab, saveProject } = require('../lib');

function lab(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-lab-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  saveProject(root, {
    version: 1,
    name: 'lab',
    environment: { python: 'python3' },
  });
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data/homes.csv'), 'a,b\n1,2\n');
  for (const hidden of ['.venv', 'node_modules', 'models']) {
    fs.mkdirSync(path.join(root, hidden));
    fs.writeFileSync(path.join(root, hidden, 'x.csv'), 'a,b\n');
  }
  const started = [];
  const runs = { start: async (...args) => (started.push(args), { id: 'r' }) };
  return { root, started, lab: new Lab(root, runs, '/assets') };
}
const sweep = {
  file: 'data/homes.csv',
  target: 'b',
  task: 'regression',
  metrics: ['rmse'],
  primary: 'rmse',
  validation: { type: 'kfold', folds: 3 },
  models: [{ id: 'ridge', grid: { alpha: '0.1, 1' } }],
};

test('lab finds workspace datasets but skips environments and models', (t) => {
  const { lab: l } = lab(t);
  assert.deepEqual(
    l.files().map((f) => f.file),
    ['data/homes.csv'],
  );
});

test('sample datasets are created without replacing existing data', async (t) => {
  const { root, lab: l } = lab(t);
  l.call = async () => ({ csv: 'length,species\n1,setosa\n' });
  const first = await l.sample();
  const second = await l.sample();
  assert.notEqual(first.file, second.file);
  assert.equal(
    fs.readFileSync(path.join(root, first.file), 'utf8'),
    'length,species\n1,setosa\n',
  );
  assert.equal(
    fs.readFileSync(path.join(root, 'data/homes.csv'), 'utf8'),
    'a,b\n1,2\n',
  );
});

test('inference rejects model files linked outside the workspace', (t) => {
  const { root, lab: l } = lab(t);
  fs.mkdirSync(path.join(root, 'models', 'unsafe'));
  fs.writeFileSync(
    path.join(root, 'models', 'unsafe', 'model.json'),
    '{"format":"aiide-lab-v1"}',
  );
  fs.symlinkSync(
    '/etc/hosts',
    path.join(root, 'models', 'unsafe', 'model.joblib'),
  );
  assert.throws(
    () => l.predict({ model: 'models/unsafe', rows: [{ a: 1 }] }),
    /Symbolic links/,
  );
});

test('lab sweeps run as recorded IDE commands with validated config', async (t) => {
  const { lab: l, started } = lab(t);
  await l.sweep(sweep);
  const [name, training, env, builtin] = started[0];
  assert.equal(name, 'sweep · b');
  assert.equal(training, undefined);
  assert.deepEqual(builtin.command, ['python', '-m', 'aiide_lab', 'sweep']);
  assert.equal(builtin.lab.kind, 'sweep');
  assert.equal(JSON.parse(env.AIIDE_LAB_CONFIG).models[0].grid.alpha, '0.1, 1');
  await l.final({
    ...sweep,
    model: 'ridge',
    params: { alpha: '1' },
    name: 'Best',
  });
  assert.equal(started[1][0], 'model · Best');
});

test('lab rejects path escapes, foreign files, and unknown model ids', async (t) => {
  const { lab: l } = lab(t);
  assert.throws(
    () => l.sweep({ ...sweep, file: '../etc/passwd.csv' }),
    /escapes/,
  );
  assert.throws(() => l.sweep({ ...sweep, file: '/etc/hosts' }), /relative/);
  assert.throws(() => l.sweep({ ...sweep, models: [{ id: 'os.system' }] }));
  assert.throws(() => l.predict({ model: '../models/x' }));
  assert.throws(
    () => l.predict({ model: 'models/missing' }),
    /ENOENT|Experiment lab/,
  );
});
