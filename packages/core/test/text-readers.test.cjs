const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Rag, Evals } = require('../lib');

const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const files = [
  'document.md',
  'dataset.jsonl',
  '.aiide/project.yaml',
  '.aiide/connections.json',
  '.aiide/ssh.json',
  'pyproject.toml',
  `.aiide/evals/${id}.json`,
  `.aiide/hf-results/${id}.json`,
  'models/hf-fixture/aiide-model.json',
  'models/lab-fixture/model.json',
  'rl-policies/fixture/policy.json',
];

async function probe(root, modulePath, id) {
  const assert = require('node:assert/strict');
  const {
    Rag,
    Evals,
    Workspace,
    HuggingFace,
    Lab,
    Sandbox,
    loadProject,
    detectEnvironment,
    Connections,
    Ssh,
    ReinforcementLearning,
  } = require(modulePath);
  const { Integrations } = require(
    require('node:path').join(
      require('node:path').dirname(modulePath),
      'integrations.js',
    ),
  );
  const evals = new Evals(root, {}, {}, {});
  assert.throws(
    () => new Rag(root, {}, {}).preview('document.md', 100, 0),
    /regular/,
  );
  assert.throws(() => evals.load('dataset.jsonl'), /regular/);
  assert.throws(() => evals.read(id), /regular/);
  await assert.rejects(
    Workspace.prototype.evaluateRag.call(
      { root },
      { dataset: 'dataset.jsonl' },
    ),
    /regular/,
  );
  const hf = new HuggingFace(root, {}, '');
  assert.throws(() => hf.result(`.aiide/hf-results/${id}.json`), /regular/);
  assert.deepEqual(hf.models(), []);
  assert.deepEqual(new Lab(root, {}, '').models(), []);
  assert.deepEqual(new ReinforcementLearning(root, {}, '').policies(), []);
  assert.throws(() => loadProject(root), /regular/);
  assert.throws(() => detectEnvironment(root), /regular/);
  assert.throws(
    () => new Connections(require('node:path').join(root, '.aiide')).list(),
    /regular/,
  );
  assert.throws(
    () =>
      Ssh.prototype.list.call({
        file: require('node:path').join(root, '.aiide/ssh.json'),
      }),
    /regular/,
  );
  await assert.rejects(
    new Integrations(root, '').prepare('sklearn'),
    /regular/,
  );
  const sandbox = new Sandbox(
    root,
    require('node:path').join(root, '.aiide/sessions'),
    {},
  );
  sandbox.sessions.set('fixture', {
    directory: root,
    baseline: { 'document.md': 'original' },
  });
  assert.throws(() => sandbox.read('fixture', 'document.md'), /regular/);
  assert.throws(
    () => sandbox.write('fixture', 'document.md', 'replacement'),
    /regular/,
  );
  assert.throws(() => sandbox.diff('fixture'), /regular/);
}

for (const kind of ['directory', 'FIFO']) {
  test(
    `text import boundaries reject ${kind}s without blocking the backend`,
    { skip: kind === 'FIFO' && process.platform === 'win32' },
    (t) => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'aiide-text-boundary-'),
      );
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      for (const relative of files) {
        const file = path.join(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (kind === 'directory') fs.mkdirSync(file);
        else execFileSync('mkfifo', [file]);
      }
      // Run in a bounded child so a missing FIFO guard fails rather than hanging this suite.
      execFileSync(
        process.execPath,
        [
          '-e',
          `(${probe.toString()})(...process.argv.slice(1)).catch(error => { console.error(error); process.exit(1); });`,
          root,
          require.resolve('../lib'),
          id,
        ],
        { timeout: 5000, stdio: 'pipe' },
      );
    },
  );
}

test('regular Markdown and JSONL imports retain their existing behavior', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-text-regular-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'document.md'),
    'A regular Markdown document',
  );
  fs.writeFileSync(
    path.join(root, 'dataset.jsonl'),
    '{"input":"Question","expected":"Answer"}\n',
  );
  assert.equal(
    new Rag(root, {}, {}).preview('document.md', 100, 0)[0].text,
    'A regular Markdown document',
  );
  assert.equal(
    new Evals(root, {}, {}, {}).load('dataset.jsonl')[0].expected,
    'Answer',
  );
});
