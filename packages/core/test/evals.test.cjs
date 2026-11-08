const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Store, Connections, Evals, verify, saveProject } = require('../lib');

const temporary = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-evals-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

// Fake OpenAI-compatible server: a tool call for weather questions, text otherwise; judge replies with JSON.
async function fakeModel(t) {
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const last = request.messages.at(-1).content;
    const message =
      request.model === 'judge'
        ? {
            role: 'assistant',
            content: 'Sure: {"score": 0.8, "reason": "Mostly right"}',
          }
        : /weather/i.test(last)
          ? {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"city":"Paris"}',
                  },
                },
              ],
            }
          : {
              role: 'assistant',
              content: '<think>hmm</think>The capital is Paris.',
            };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/v1`;
}

test('verifiable scorers', () => {
  const out = (content, tool_calls = []) => ({ content, tool_calls });
  assert.equal(
    verify({ type: 'exact' }, { expected: 'a' }, out(' a ')).score,
    1,
  );
  assert.equal(
    verify({ type: 'contains' }, { expected: 'PARIS' }, out('in paris')).score,
    1,
  );
  assert.ok(verify({ type: 'exact' }, {}, out('x')).skipped);
  assert.equal(
    verify({ type: 'regex', pattern: '^\\d+$' }, {}, out('42')).score,
    1,
  );
  assert.equal(
    verify(
      { type: 'json' },
      { expected: '{"b":1,"a":2}' },
      out('```json\n{"a":2,"b":1}\n```'),
    ).score,
    1,
  );
  assert.equal(verify({ type: 'json' }, {}, out('nope')).score, 0);
  const call = [{ function: { name: 'f', arguments: '{"x":1}' } }];
  assert.equal(
    verify({ type: 'tool_call' }, { expected_tool: 'f' }, out('', call)).score,
    1,
  );
  assert.equal(
    verify(
      { type: 'tool_call' },
      { expected_tool: { name: 'f', arguments: { x: 2 } } },
      out('', call),
    ).score,
    0.5,
  );
  assert.equal(
    verify({ type: 'tool_call' }, { expected_tool: 'g' }, out('', call)).score,
    0,
  );
});

test('evaluation run records cases, traces, judge scores and agent grades', async (t) => {
  const root = temporary(t);
  saveProject(root, {
    version: 1,
    name: 'evals',
    telemetry: { captureContent: true },
  });
  const url = await fakeModel(t);
  const store = new Store(path.join(root, 'db.sqlite'), true);
  const secrets = new Map();
  const connections = new Connections(root, {
    get: async (k) => secrets.get(k),
    set: async (k, v) => void secrets.set(k, v),
  });
  await connections.save({ id: 'ft', kind: 'model', url, model: 'ft-model' });
  await connections.save({ id: 'judge', kind: 'model', url, model: 'judge' });
  fs.writeFileSync(
    path.join(root, 'eval.jsonl'),
    [
      { input: 'Capital of France?', expected: 'Paris' },
      {
        input: 'Weather in Paris?',
        tools: [
          {
            type: 'function',
            function: { name: 'get_weather', parameters: {} },
          },
        ],
        expected_tool: { name: 'get_weather', arguments: { city: 'Paris' } },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n'),
  );
  const evals = new Evals(root, store, connections, {});
  const run = await evals.run({
    dataset: 'eval.jsonl',
    target: 'ft',
    scorers: [
      { type: 'contains' },
      { type: 'tool_call' },
      { type: 'judge', connection: 'judge' },
      { type: 'agent' },
    ],
  });
  for (let i = 0; i < 100 && store.run(run.id).status === 'running'; i++)
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.run(run.id).status, 'completed');
  const result = evals.get(run.id);
  assert.equal(result.cases.length, 2);
  const [text, tool] = result.cases;
  assert.equal(text.scores.contains.score, 1);
  assert.equal(text.output.reasoning, 'hmm');
  assert.equal(text.output.content, 'The capital is Paris.');
  assert.ok(text.scores.tool_call.skipped);
  assert.equal(text.scores.llm_judge.score, 0.8);
  assert.ok(text.scores.agent_review.pending);
  assert.equal(tool.scores.tool_call.score, 1);
  assert.deepEqual(
    tool.trace.map((n) => n.kind).sort(),
    ['chain', 'evaluator', 'evaluator', 'llm', 'llm', 'tool'].sort(),
  );
  assert.equal(result.summary.scorers.agent_review.pending, 2);
  assert.ok(result.summary.throughput.perRequest > 0 && result.summary.throughput.aggregate > 0);
  assert.equal(
    store.spans(run.id).total,
    tool.trace.length + text.trace.length,
  );
  evals.score(run.id, {
    scores: [
      { index: 0, score: 1 },
      { index: 1, score: 0.5, reason: 'ok' },
    ],
  });
  const graded = evals.get(run.id);
  assert.equal(graded.summary.scorers.agent_review.mean, 0.75);
  assert.equal(graded.summary.scorers.agent_review.pending, 0);
  assert.equal(evals.list()[0].runId, run.id);
  await assert.rejects(
    evals.run({
      dataset: 'eval.jsonl',
      target: 'missing',
      scorers: [{ type: 'exact' }],
    }),
  );
});

test('a connected agent grades pending cases over MCP', async (t) => {
  const { Workspace } = require('../lib');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const {
    StreamableHTTPClientTransport,
  } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const root = temporary(t);
  saveProject(root, { version: 1, name: 'agent evals' });
  const url = await fakeModel(t);
  fs.writeFileSync(
    path.join(root, 'eval.jsonl'),
    JSON.stringify({ input: 'Capital of France?', expected: 'Paris' }) + '\n',
  );
  const workspace = await Workspace.open(root);
  t.after(() => workspace.close());
  await workspace.connections.save({
    id: 'ft',
    kind: 'model',
    url,
    model: 'ft-model',
  });
  const grant = workspace.mcp.issue(['read', 'workflow']);
  const agent = new Client({ name: 'grader', version: '1.0' });
  await agent.connect(
    new StreamableHTTPClientTransport(new URL(grant.url), {
      requestInit: { headers: { Authorization: `Bearer ${grant.token}` } },
    }),
  );
  t.after(() => agent.close());
  const tool = async (name, args) => {
    const result = await agent.callTool({ name, arguments: args });
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return result.structuredContent.result;
  };
  const run = await tool('run_workflow', {
    operation: 'evals.run',
    args: {
      dataset: 'eval.jsonl',
      target: 'ft',
      scorers: [{ type: 'agent', rubric: 'Correct capital' }],
    },
  });
  for (
    let i = 0;
    i < 100 && workspace.store.run(run.id).status === 'running';
    i++
  )
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(
    (await tool('inspect_workflow', { operation: 'evals.list' }))[0].summary
      .scorers.agent_review.pending,
    1,
  );
  const cases = await tool('run_workflow', {
    operation: 'evals.get',
    args: { runId: run.id },
  });
  assert.equal(cases.cases[0].output.content, 'The capital is Paris.');
  await tool('run_workflow', {
    operation: 'evals.score',
    args: {
      runId: run.id,
      scores: [{ index: 0, score: 1, reason: 'Names Paris' }],
    },
  });
  assert.equal(
    workspace.evals.get(run.id).summary.scorers.agent_review.mean,
    1,
  );
  await assert.rejects(
    tool('run_workflow', {
      operation: 'evals.run',
      args: {
        dataset: 'eval.jsonl',
        target: 'ft',
        scorers: [{ type: 'python', file: 'x.py' }],
      },
    }),
    /host code/,
  );
});
