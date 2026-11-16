const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { Workspace, TaskEvidence, saveProject } = require('../lib');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-task-evidence-'));
  saveProject(root, {
    version: 1,
    name: 'Evidence project',
    environment: { python: 'python3' },
    commands: { verify: ['python', '-m', 'unittest', 'test_behavior', '-v'] },
  });
  fs.writeFileSync(path.join(root, 'main.py'), 'def answer():\n return 42\n');
  fs.writeFileSync(
    path.join(root, 'test_behavior.py'),
    'import unittest\nfrom main import answer\nclass Behavior(unittest.TestCase):\n def test_answer(self):self.assertEqual(answer(),42)\n',
  );
  fs.writeFileSync(
    path.join(root, 'cases.jsonl'),
    JSON.stringify({ input: 'Capital?', expected: 'Paris' }) + '\n',
  );
  const state = { answer: 'Wrong' };
  const server = http.createServer(async (req, res) => {
    for await (const part of req) {
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: state.answer } }],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const workspace = await Workspace.open(root);
  await workspace.connections.save({
    id: 'fixture',
    kind: 'model',
    model: 'fixture',
    url: `http://127.0.0.1:${server.address().port}/v1`,
  });
  const evidence = new TaskEvidence(
    root,
    workspace.store,
    workspace.evals,
    workspace.sandbox,
  );
  t.after(async () => {
    evidence.close();
    await workspace.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const body = {
    title: 'Fix a regression',
    plan: 'Run local checks, compare the evaluation and review evidence.',
    planReviewed: true,
    criteria: [
      'Local behavior tests complete',
      'Exact evaluation meets its threshold',
    ],
    sourceFiles: ['main.py', 'test_behavior.py', 'cases.jsonl'],
    runIds: [],
    evalGates: [],
    sandboxIds: [],
    findings: [],
  };
  const save = (args) => {
    const preview = evidence.preview(args);
    return evidence.save({
      ...args,
      reviewHash: preview.reviewHash,
      confirmed: true,
    });
  };
  const wait = async (run) => {
    const end = Date.now() + 10000;
    while (workspace.store.run(run.id).status === 'running' && Date.now() < end)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(workspace.store.run(run.id).status, 'completed');
    return run;
  };
  const evaluate = async () =>
    wait(
      await workspace.evals.run({
        dataset: 'cases.jsonl',
        target: 'fixture',
        scorers: [{ type: 'exact' }],
      }),
    );
  return { root, workspace, evidence, body, state, save, wait, evaluate };
}

test('task completion uses actual unittest and evaluation evidence, finding review and fresh sources', async (t) => {
  const { root, workspace, evidence, body, state, save, wait, evaluate } =
    await fixture(t);
  let task = save(body);
  assert.equal(task.report.ready, false);
  assert.throws(
    () =>
      evidence.complete({
        id: task.task.id,
        revision: task.task.revision,
        reviewHash: task.report.reviewHash,
        confirmed: true,
      }),
    /blocked/,
  );
  const run = await wait(await workspace.runs.start('verify')),
    bad = await evaluate();
  task = save({
    ...task.task.body,
    id: task.task.id,
    revision: task.task.revision,
    runIds: [run.id],
    evalGates: [{ runId: bad.id, thresholds: { exact_match: 1 } }],
    findings: [
      {
        id: 'regression',
        level: 'blocking',
        text: 'Investigate wrong answer',
        resolved: false,
        resolution: '',
      },
    ],
  });
  assert.equal(task.report.runs[0].sourceMatches, true);
  assert.equal(task.report.evaluations[0].report.passed, false);
  assert.equal(task.report.ready, false);
  state.answer = 'Paris';
  const good = await evaluate();
  task = save({
    ...task.task.body,
    id: task.task.id,
    revision: task.task.revision,
    evalGates: [{ runId: good.id, thresholds: { exact_match: 1 } }],
    findings: [
      {
        id: 'regression',
        level: 'blocking',
        text: 'Investigate wrong answer',
        resolved: true,
        resolution: 'Reproduced failure and attached a new passing evaluation',
      },
    ],
  });
  assert.equal(task.report.ready, true, JSON.stringify(task.report));
  const completed = evidence.complete({
    id: task.task.id,
    revision: task.task.revision,
    reviewHash: task.report.reviewHash,
    confirmed: true,
  });
  assert.equal(completed.report.status, 'reviewed-complete');
  const preview = evidence.exportPreview({ id: task.task.id });
  const artifact = evidence.export({
    id: task.task.id,
    revision: preview.revision,
    reviewHash: preview.reviewHash,
    confirmed: true,
  });
  const document = JSON.parse(artifact.content);
  assert.equal(document.status, 'reviewed-complete');
  assert.equal(
    document.evidence.evaluations[0].report.scores.exact_match.mean,
    1,
  );
  assert.ok(
    !artifact.content.includes('Capital?'),
    'raw model conversations are not exported',
  );
  assert.ok(
    !artifact.content.includes('def answer()'),
    'source bodies are not exported',
  );
  fs.appendFileSync(path.join(root, 'main.py'), '\n# changed after review\n');
  assert.equal(evidence.get(task.task.id).report.status, 'stale-completion');
  assert.throws(
    () =>
      evidence.export({
        id: task.task.id,
        revision: preview.revision,
        reviewHash: preview.reviewHash,
        confirmed: true,
      }),
    /changed/,
  );
});

test('artifact changes and recorded failures cannot retain a passing completion, and deletion preserves evidence', async (t) => {
  const { root, workspace, evidence, body, state, save, wait, evaluate } =
    await fixture(t);
  let value = save(body);
  const run = await wait(await workspace.runs.start('verify'));
  state.answer = 'Paris';
  const evaluation = await evaluate();
  value = save({
    ...value.task.body,
    id: value.task.id,
    revision: value.task.revision,
    runIds: [run.id],
    evalGates: [{ runId: evaluation.id, thresholds: { exact_match: 1 } }],
  });
  assert.equal(value.report.ready, true, JSON.stringify(value.report));
  const file = path.join(root, '.aiide/evals', evaluation.id + '.json'),
    original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original + '\n');
  assert.equal(evidence.get(value.task.id).report.ready, false);
  fs.writeFileSync(file, original);
  workspace.store.saveRun({ ...workspace.store.run(run.id), status: 'failed' });
  assert.equal(evidence.get(value.task.id).report.ready, false);
  const stale = value.task.revision;
  value = save({
    ...value.task.body,
    id: value.task.id,
    revision: value.task.revision,
    title: 'Reviewed failure',
  });
  assert.throws(
    () =>
      evidence.delete({ id: value.task.id, revision: stale, confirmed: true }),
    /changed/,
  );
  evidence.delete({
    id: value.task.id,
    revision: value.task.revision,
    confirmed: true,
  });
  assert.equal(evidence.list().length, 0);
  assert.ok(workspace.store.run(run.id));
  assert.ok(fs.existsSync(file));
  assert.ok(fs.existsSync(path.join(root, 'main.py')));
});

test('task review detects concurrent edits and rejects special paths, oversized plans and fabricated completion fields', async (t) => {
  const { root, evidence, body, save } = await fixture(t);
  const preview = evidence.preview(body);
  fs.appendFileSync(path.join(root, 'main.py'), '# changed during review\n');
  assert.throws(
    () =>
      evidence.save({
        ...body,
        reviewHash: preview.reviewHash,
        confirmed: true,
      }),
    /changed/,
  );
  assert.throws(() =>
    evidence.preview({ ...body, sourceFiles: ['/etc/passwd'] }),
  );
  assert.throws(() => evidence.preview({ ...body, plan: 'x'.repeat(16001) }));
  assert.throws(() => evidence.preview({ ...body, status: 'completed' }));
  const stored = save(body),
    change = {
      ...stored.task.body,
      id: stored.task.id,
      revision: stored.task.revision,
      title: 'Updated',
    };
  save(change);
  assert.throws(() => save({ ...change, title: 'Stale edit' }), /changed/);
  if (process.platform !== 'win32') {
    const id = crypto.randomUUID(),
      file = path.join(root, '.aiide/task-evidence', id + '.json');
    execFileSync('mkfifo', [file]);
    execFileSync(
      process.execPath,
      [
        '-e',
        "const assert=require('node:assert/strict');const{TaskEvidence}=require(process.argv[1]);assert.throws(()=>new TaskEvidence(process.argv[2],{},{},{}).get(process.argv[3]),/regular/);",
        require.resolve('../lib/task-evidence'),
        root,
        id,
      ],
      { timeout: 3000 },
    );
  }
  evidence.close();
  assert.throws(() => evidence.list(), /closed/);
});
