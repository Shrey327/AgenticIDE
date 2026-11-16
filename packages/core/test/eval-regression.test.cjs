const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const {
  Evals,
  Store,
  Connections,
  saveProject,
  evaluationGate,
} = require('../lib');

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-regression-'));
  saveProject(root, {
    version: 1,
    name: 'Regression',
    telemetry: { captureContent: true },
  });
  const store = new Store(path.join(root, '.aiide/db.sqlite'), true);
  const state = { answer: 'Paris', requests: [] };
  const server = http.createServer(async (req, res) => {
    let content = '';
    for await (const part of req) content += part;
    state.requests.push(JSON.parse(content));
    setTimeout(() => {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: state.answer } }],
        }),
      );
    }, 20);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const connections = new Connections(path.join(root, '.aiide'));
  await connections.save({
    id: 'local',
    kind: 'model',
    model: 'fixture',
    url: `http://127.0.0.1:${server.address().port}/v1`,
  });
  const evals = new Evals(root, store, connections, options.huggingface || {});
  fs.writeFileSync(
    path.join(root, 'cases.jsonl'),
    JSON.stringify({ input: 'Capital of France?', expected: 'Paris' }) + '\n',
  );
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const run = async (extra = {}) => {
    const started = await evals.run({
      dataset: 'cases.jsonl',
      target: 'local',
      scorers: [{ type: 'exact' }],
      ...extra,
    });
    const end = Date.now() + 10000;
    while (store.run(started.id).status === 'running' && Date.now() < end)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(store.run(started.id).status, 'completed');
    return evals.get(started.id);
  };
  return { root, store, evals, state, run };
}

test('real evaluation snapshots dataset/config before inputs change and detects snapshot tampering', async (t) => {
  const { root, evals, run } = await fixture(t);
  const first = await run({ system: 'Answer with a city only.' });
  assert.match(first.datasetVersion.hash, /^[a-f0-9]{64}$/);
  assert.match(first.configVersion, /^[a-f0-9]{64}$/);
  fs.writeFileSync(
    path.join(root, 'cases.jsonl'),
    ' { "expected": "Paris", "input": "Capital of France?" }\n',
  );
  assert.equal(evals.snapshot('cases.jsonl').hash, first.datasetVersion.hash);
  fs.writeFileSync(
    path.join(root, 'cases.jsonl'),
    '{"input":"Different question","expected":"Berlin"}\n',
  );
  assert.notEqual(
    evals.snapshot('cases.jsonl').hash,
    first.datasetVersion.hash,
  );
  assert.match(
    fs.readFileSync(path.join(root, first.datasetVersion.file), 'utf8'),
    /Capital of France/,
  );
  assert.equal(evals.datasets().length, 2);
  fs.writeFileSync(path.join(root, first.datasetVersion.file), 'changed');
  assert.throws(() => evals.datasets(), /checksum/);
});

test('reviewed evaluation and general trace exports preserve input/reference and never overwrite', async (t) => {
  const { root, store, evals, run } = await fixture(t);
  const result = await run({ system: 'Answer briefly.' });
  assert.throws(() =>
    evals.exportCase({
      runId: result.runId,
      index: 0,
      file: 'data/new.jsonl',
      expected: 'Corrected Paris',
      reviewed: false,
    }),
  );
  const exported = evals.exportCase({
    runId: result.runId,
    index: 0,
    file: 'data/new.jsonl',
    expected: 'Corrected Paris',
    reviewed: true,
  });
  const row = JSON.parse(
    fs.readFileSync(path.join(root, exported.file), 'utf8'),
  );
  assert.equal(row.messages[0].content, 'Answer briefly.');
  assert.equal(row.expected, 'Corrected Paris');
  assert.throws(
    () =>
      evals.exportCase({
        runId: result.runId,
        index: 0,
        file: 'data/new.jsonl',
        expected: 'Overwrite',
        reviewed: true,
      }),
    /exists/,
  );
  const span = store
    .spans(result.runId, 0, 500)
    .items.find((item) => item.attributes['aiide.kind'] === 'llm');
  const trace = evals.exportTrace({
    runId: result.runId,
    spanId: span.spanId,
    file: 'data/trace.jsonl',
    expected: 'Paris',
    reviewed: true,
  });
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, trace.file), 'utf8')).metadata
      .sourceSpan,
    span.spanId,
  );
  assert.throws(() =>
    evals.exportTrace({
      runId: result.runId,
      spanId: span.spanId,
      file: '../escape.jsonl',
      expected: 'x',
      reviewed: true,
    }),
  );
  assert.throws(() =>
    evals.exportTrace({
      runId: result.runId,
      spanId: span.spanId,
      file: 'secrets.jsonl',
      expected: 'x',
      reviewed: true,
    }),
  );
  store.captureContent = false;
  store.span({
    traceId: 'redacted',
    spanId: 'redacted',
    runId: result.runId,
    start: 0,
    end: 1,
    name: 'private',
    status: 'ok',
    events: [],
    attributes: { input: 'Private prompt' },
  });
  assert.throws(
    () =>
      evals.exportTrace({
        runId: result.runId,
        spanId: 'redacted',
        file: 'data/redacted.jsonl',
        expected: 'x',
        reviewed: true,
      }),
    /not captured/,
  );
  fs.writeFileSync(
    path.join(root, 'cases.jsonl'),
    JSON.stringify({
      input: 'Weather in Paris?',
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', parameters: { type: 'object' } },
        },
      ],
      expected_tool: { name: 'get_weather', arguments: { city: 'Paris' } },
    }) + '\n',
  );
  const toolResult = await run({ scorers: [{ type: 'tool_call' }] });
  const toolExport = evals.exportCase({
    runId: toolResult.runId,
    index: 0,
    file: 'data/tool.jsonl',
    expected: '{"name":"get_weather","arguments":{"city":"Paris"}}',
    referenceKind: 'tool',
    reviewed: true,
  });
  const toolRow = JSON.parse(
    fs.readFileSync(path.join(root, toolExport.file), 'utf8'),
  );
  assert.deepEqual(toolRow.expected_tool, {
    name: 'get_weather',
    arguments: { city: 'Paris' },
  });
  assert.equal(toolRow.tools[0].function.name, 'get_weather');
});

test('gates fail incomplete/pending/unknown scores and detect real model regressions against matching datasets', async (t) => {
  const { evals, state, run } = await fixture(t);
  const baseline = await run();
  assert.equal(
    evals.gate({ runId: baseline.runId, thresholds: { exact_match: 1 } })
      .passed,
    true,
  );
  state.answer = 'Wrong';
  const candidate = await run();
  const regression = evals.gate({
    runId: candidate.runId,
    thresholds: { exact_match: 0 },
    baseline: baseline.runId,
  });
  assert.equal(regression.passed, false);
  assert.match(regression.reasons.join(' '), /regressed/);
  assert.equal(
    evals.gate({
      runId: candidate.runId,
      thresholds: { exact_match: 0 },
      baseline: baseline.runId,
      maxRegression: 1,
    }).passed,
    true,
  );
  const pending = structuredClone(baseline);
  pending.cases[0].scores.exact_match = { pending: true };
  assert.equal(
    evaluationGate(pending, { thresholds: { exact_match: 0 } }).passed,
    false,
  );
  const missing = structuredClone(baseline);
  delete missing.cases[0].scores.exact_match;
  assert.equal(
    evaluationGate(missing, { thresholds: { exact_match: 0 } }).passed,
    false,
  );
  assert.equal(
    evaluationGate(
      { ...baseline, status: 'running' },
      { thresholds: { exact_match: 0 } },
    ).passed,
    false,
  );
  assert.equal(
    evaluationGate(baseline, { thresholds: { does_not_exist: 0 } }).passed,
    false,
  );
  const mismatch = structuredClone(baseline);
  mismatch.datasetVersion.hash = 'different';
  assert.equal(
    evaluationGate(candidate, { thresholds: { exact_match: 0 } }, mismatch)
      .passed,
    false,
  );
});

test('the CI CLI returns stable pass/fail/error exit codes without starting a model', async (t) => {
  const { root, run } = await fixture(t);
  const result = await run();
  const cli = path.resolve(__dirname, '../../../scripts/eval-gate.mjs');
  const file = path.join(root, `.aiide/evals/${result.runId}.json`);
  const invoke = (...args) =>
    spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      timeout: 5000,
    });
  const passed = invoke('--result', file, '--threshold', 'exact_match=1');
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(JSON.parse(passed.stdout).passed, true);
  const failed = invoke('--result', file, '--threshold', 'unknown=1');
  assert.equal(failed.status, 1);
  const invalid = invoke('--result', file, '--threshold', 'exact_match=2');
  assert.equal(invalid.status, 2);
  const pending = JSON.parse(fs.readFileSync(file, 'utf8'));
  pending.status = 'running';
  fs.writeFileSync(file, JSON.stringify(pending));
  assert.equal(
    invoke('--result', file, '--threshold', 'exact_match=0').status,
    1,
  );
});

test('Python rewards changed after launch are rejected before executing replacement host code', async (t) => {
  let executed = false;
  const { root, run } = await fixture(t, {
    huggingface: {
      python: async () => {
        executed = true;
        return [{ score: 1 }];
      },
    },
  });
  const file = path.join(root, 'reward.py');
  fs.writeFileSync(file, 'def score(**kwargs): return 1');
  const pending = run({ scorers: [{ type: 'python', file: 'reward.py' }] });
  fs.writeFileSync(file, 'raise RuntimeError("changed")');
  const result = await pending;
  assert.equal(executed, false);
  assert.equal(result.cases[0].scores.reward.score, 0);
  assert.match(result.cases[0].scores.reward.reason, /changed/);
});
