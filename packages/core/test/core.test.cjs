const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {
  Store,
  within,
  redact,
  chunks,
  saveProject,
  Workspace,
  Sandbox,
  hash,
  Connections,
  Telemetry,
  McpEndpoint,
} = require('../lib');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const run = (id = 'run') => ({
  id,
  project: 'test',
  name: 'example',
  status: 'completed',
  started: Date.now(),
  command: [],
  environment: {},
  source: '',
  configuration: {},
});
const span = (i = 0) => ({
  traceId: 'a'.repeat(32),
  spanId: i.toString(16).padStart(16, '0'),
  runId: 'run',
  name: 'step',
  start: Date.now() + i,
  end: Date.now() + i + 5,
  status: 'ok',
  attributes: {},
  events: [],
});

test('paths reject traversal, absolute paths, and symlinks', (t) => {
  const root = temporary(t);
  fs.mkdirSync(path.join(root, 'safe'));
  fs.symlinkSync(os.tmpdir(), path.join(root, 'escape'));
  assert.throws(() => within(root, '../outside', true));
  assert.throws(() => within(root, '/etc/passwd'));
  assert.throws(() => within(root, 'escape/something', true));
  assert.equal(
    within(root, 'safe/new.py', true),
    path.join(fs.realpathSync(root), 'safe/new.py'),
  );
});

test('content is private by default and secrets remain redacted with capture enabled', () => {
  assert.deepEqual(
    redact({ prompt: 'private', api_key: 'private', duration: 4 }),
    { prompt: '[CONTENT DISABLED]', api_key: '[REDACTED]', duration: 4 },
  );
  assert.equal(
    redact({ content: 'Bearer abc123', password: 'pw' }, true).content,
    'Bearer [REDACTED]',
  );
  assert.equal(redact({ password: 'pw' }, true).password, '[REDACTED]');
});

test('SQLite persists completed runs and marks abandoned runs interrupted', (t) => {
  const file = path.join(temporary(t), 'store.sqlite');
  let store = new Store(file);
  store.saveRun({ ...run(), status: 'running' });
  store.span({ ...span(), attributes: { prompt: 'sensitive' } });
  store.close();
  store = new Store(file);
  t.after(() => store.close());
  assert.equal(store.run('run').status, 'interrupted');
  assert.equal(
    store.spans('run').items[0].attributes.prompt,
    '[CONTENT DISABLED]',
  );
});

test('10,000 spans remain paginated and query quickly', (t) => {
  const store = new Store(path.join(temporary(t), 'store.sqlite'));
  t.after(() => store.close());
  store.saveRun(run());
  store.transaction(() => {
    for (let i = 0; i < 10000; i++) store.span(span(i));
  });
  const started = performance.now(),
    result = store.spans('run', 9800);
  assert.equal(result.total, 10000);
  assert.equal(result.items.length, 200);
  assert.ok(performance.now() - started < 1000);
});

test('storage budget drops events instead of growing indefinitely', (t) => {
  const store = new Store(path.join(temporary(t), 'store.sqlite'), false, 0);
  t.after(() => store.close());
  store.event({
    runId: 'run',
    kind: 'metric',
    timestamp: Date.now(),
    name: 'x',
    value: 1,
  });
  assert.equal(store.events('run').length, 0);
  assert.equal(store.dropped, 1);
});

test('chunking validates overlap and preserves source offsets', () => {
  assert.throws(() => chunks('a'.repeat(200), 50, 50));
  assert.throws(() => chunks('a', 0, 0));
  const result = chunks('a'.repeat(125), 50, 10);
  assert.deepEqual(
    result.map((c) => [c.start, c.end]),
    [
      [0, 50],
      [40, 90],
      [80, 125],
    ],
  );
});

test('staged changes exclude credentials, preserve host until review, and reject concurrent edits', async (t) => {
  const root = temporary(t),
    directory = path.join(root, '.aiide');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(root, 'main.py'), 'before\n');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=hidden');
  const store = new Store(path.join(directory, 'db.sqlite'));
  t.after(() => store.close());
  const sandbox = new Sandbox(root, path.join(directory, 'sessions'), store);
  sandbox.available = async () => true;
  sandbox.prepareImage = async () => {};
  const { id } = await sandbox.create();
  t.after(() => sandbox.stop());
  assert.deepEqual(sandbox.list(id), ['main.py']);
  sandbox.write(id, 'main.py', 'after\n');
  assert.equal(fs.readFileSync(path.join(root, 'main.py'), 'utf8'), 'before\n');
  assert.throws(() => sandbox.write(id, '../outside', 'x'));
  assert.throws(() => sandbox.write(id, '.env', 'x'));
  const changes = sandbox.diff(id);
  sandbox.apply(id, hash(JSON.stringify(changes)));
  assert.equal(fs.readFileSync(path.join(root, 'main.py'), 'utf8'), 'after\n');
  sandbox.write(id, 'main.py', 'third\n');
  fs.writeFileSync(path.join(root, 'main.py'), 'host edit\n');
  assert.throws(
    () => sandbox.apply(id, hash(JSON.stringify(sandbox.diff(id)))),
    /Concurrent edit/,
  );
  assert.equal(
    fs.readFileSync(path.join(root, 'main.py'), 'utf8'),
    'host edit\n',
  );
});

test('missing Docker never falls back to host execution', async (t) => {
  const root = temporary(t),
    store = new Store(path.join(root, 'db.sqlite'));
  t.after(() => store.close());
  const sandbox = new Sandbox(root, path.join(root, 'sessions'), store);
  sandbox.available = async () => false;
  await assert.rejects(sandbox.create(), /Host execution is disabled/);
});

test('OTLP ingestion rejects unauthorized requests and correlates spans', async (t) => {
  const store = new Store(path.join(temporary(t), 'db.sqlite'));
  store.saveRun(run());
  const telemetry = new Telemetry(store, path.dirname(store.file));
  await telemetry.start();
  t.after(async () => {
    await telemetry.stop();
    store.close();
  });
  const body = {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: 'aiide.run.id', value: { stringValue: 'run' } }],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 'a'.repeat(32),
                spanId: 'b'.repeat(16),
                name: 'test',
                startTimeUnixNano: String(BigInt(Date.now()) * 1000000n),
                endTimeUnixNano: String(BigInt(Date.now()) * 1000000n),
                attributes: [],
              },
            ],
          },
        ],
      },
    ],
  };
  assert.equal(
    (
      await fetch(telemetry.url + '/v1/traces', {
        method: 'POST',
        body: JSON.stringify(body),
      })
    ).status,
    403,
  );
  const result = await fetch(telemetry.url + '/v1/traces', {
    method: 'POST',
    headers: { Authorization: `Bearer ${telemetry.token}` },
    body: JSON.stringify(body),
  });
  assert.equal(result.status, 200);
  assert.equal(store.spans('run').total, 1);
});

test('MCP requires credentials, enforces scopes and rejects browser origins', async (t) => {
  const root = temporary(t),
    store = new Store(path.join(root, 'db.sqlite'));
  const sandbox = new Sandbox(root, path.join(root, 'sessions'), store);
  const mcp = new McpEndpoint(sandbox, store);
  await mcp.start();
  t.after(async () => {
    await mcp.stop();
    store.close();
  });
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  });
  const { token } = mcp.issue(['read']);
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  assert.equal((await fetch(mcp.url, { method: 'POST', body })).status, 401);
  assert.equal(
    (
      await fetch(mcp.url, {
        method: 'POST',
        body,
        headers: { ...headers, Origin: 'https://evil.example' },
      })
    ).status,
    403,
  );
  const tools = await (
    await fetch(mcp.url, { method: 'POST', body, headers })
  ).json();
  assert.ok(tools.result.tools.some((t) => t.name === 'list_runs'));
  assert.ok(!tools.result.tools.some((t) => t.name === 'apply_changes'));
  const denied = await (
    await fetch(mcp.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'create_session', arguments: {} },
      }),
    })
  ).json();
  assert.ok(denied.result?.isError || denied.error);
  assert.equal((await fetch(mcp.url, { method: 'POST', headers, body: '{broken' })).status, 400);
  await new Promise((resolve) => {
    const request = http.request(mcp.url, { method: 'POST', headers: { ...headers, 'Content-Length': '100000' } });
    request.on('error', () => {});
    request.on('close', resolve);
    request.write('{');
    setTimeout(() => request.destroy(), 20);
  });
  assert.equal((await fetch(mcp.url, { method: 'POST', body, headers })).status, 200);
  await mcp.revoke();
  assert.equal(
    (await fetch(mcp.url, { method: 'POST', body, headers })).status,
    401,
  );
});

test('model capabilities are checked independently and credentials are never written to disk', async (t) => {
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const c of req) text += c;
    const body = JSON.parse(text || '{}');
    if (req.url === '/v1/embeddings') {
      res.writeHead(400).end('{}');
      return;
    }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n',
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: body.tools
              ? {
                  tool_calls: [
                    { function: { name: 'ping', arguments: '{"value":"ok"}' } },
                  ],
                }
              : { content: 'OK' },
          },
        ],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const root = temporary(t),
    secrets = new Map(),
    vault = {
      get: async (k) => secrets.get(k),
      set: async (k, v) => {
        secrets.set(k, v);
      },
    };
  const connections = new Connections(root, vault);
  await connections.save(
    {
      id: 'test',
      kind: 'model',
      url: `http://127.0.0.1:${server.address().port}/v1`,
      model: 'test',
    },
    'private-test-key',
  );
  const { capabilities } = await connections.probe('test');
  assert.deepEqual(capabilities, {
    chat: true,
    streaming: true,
    tools: true,
    embeddings: false,
  });
  assert.ok(
    !fs
      .readFileSync(path.join(root, 'connections.json'), 'utf8')
      .includes('private-test-key'),
  );
  await connections.save({
    id: 'test',
    kind: 'model',
    url: 'https://different.example/v1',
    model: 'test',
  });
  assert.equal(connections.get('test').credentialRef, undefined);
});

test('real Python run persists traces after workspace restart', async (t) => {
  const root = temporary(t);
  fs.copyFileSync(
    path.resolve(__dirname, '../../..', 'templates/python/main.py'),
    path.join(root, 'main.py'),
  );
  saveProject(root, {
    version: 1,
    name: 'integration',
    environment: { python: 'python3' },
    commands: { example: ['python', 'main.py'] },
  });
  let workspace = await Workspace.open(root);
  t.after(async () => {
    if (workspace) await workspace.close();
  });
  await assert.rejects(Workspace.open(root), /already open/);
  assert.match(workspace.telemetry.collectorStatus, /^Collector running at/);
  const started = await workspace.operation('runs.start', { name: 'example' });
  const deadline = Date.now() + 15000;
  while (
    workspace.store.run(started.id).status === 'running' &&
    Date.now() < deadline
  )
    await new Promise((r) => setTimeout(r, 100));
  assert.equal(workspace.store.run(started.id).status, 'completed');
  while (workspace.store.spans(started.id).total < 3 && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 100));
  assert.equal(workspace.store.spans(started.id).total, 3);
  await workspace.close();
  workspace = await Workspace.open(root);
  assert.equal(workspace.store.spans(started.id).total, 3);
  assert.equal(workspace.store.events(started.id, 'evaluation').length, 1);
});

test('telemetry write failure is counted without throwing into user processes', (t) => {
  const store = new Store(path.join(temporary(t), 'store.sqlite'));
  t.after(() => store.close());
  store.db.exec('PRAGMA query_only=ON');
  assert.doesNotThrow(() => store.span(span()));
  assert.doesNotThrow(() => store.event({ runId: 'run', kind: 'metric', timestamp: Date.now(), name: 'x', value: 1 }));
  assert.equal(store.dropped, 2);
});

test('OTLP export respects content opt-in and always redacts credentials', () => {
  const { scrubOtlp } = require('../lib');
  const body = { resourceSpans: [{ scopeSpans: [{ spans: [{ attributes: [
    { key: 'gen_ai.prompt', value: { stringValue: 'private prompt' } },
    { key: 'authorization', value: { stringValue: 'Bearer hidden' } },
    { key: 'tokens', value: { intValue: '12' } },
  ] }] }] }] };
  const attrs = scrubOtlp(body, false).resourceSpans[0].scopeSpans[0].spans[0].attributes;
  assert.equal(attrs[0].value.stringValue, '[CONTENT DISABLED]');
  assert.equal(attrs[1].value.stringValue, '[REDACTED]');
  assert.equal(attrs[2].value.intValue, '12');
  assert.equal(scrubOtlp(body, true).resourceSpans[0].scopeSpans[0].spans[0].attributes[0].value.stringValue, 'private prompt');
  assert.equal(body.resourceSpans[0].scopeSpans[0].spans[0].attributes[0].value.stringValue, 'private prompt');
});

test('source fingerprint excludes large artifacts and sandbox preserves executable modes', async (t) => {
  const { walk } = require('../lib');
  const root = temporary(t);
  fs.writeFileSync(path.join(root, 'weights.bin'), Buffer.alloc(3 * 1024 * 1024));
  fs.writeFileSync(path.join(root, 'run.sh'), '#!/bin/sh\necho before\n', { mode: 0o755 });
  assert.deepEqual(walk(root), ['run.sh']);
  const store = new Store(path.join(root, '.aiide', 'db.sqlite'));
  t.after(() => store.close());
  const sandbox = new Sandbox(root, path.join(root, '.aiide', 'sessions'), store);
  sandbox.available = async () => true;
  sandbox.prepareImage = async () => {};
  const { id } = await sandbox.create();
  t.after(() => sandbox.stop());
  sandbox.write(id, 'run.sh', '#!/bin/sh\necho after\n');
  sandbox.apply(id, hash(JSON.stringify(sandbox.diff(id))));
  assert.equal(fs.statSync(path.join(root, 'run.sh')).mode & 0o777, 0o755);
});

test('Collector restart keeps the endpoint used by active Python environments', async (t) => {
  const root = temporary(t);
  const workspace = await Workspace.open(root);
  t.after(() => workspace.close());
  const endpoint = workspace.telemetry.exporterUrl;
  const first = workspace.telemetry.collector;
  first.kill('SIGKILL');
  const deadline = Date.now() + 10000;
  while ((workspace.telemetry.collector === first || !workspace.telemetry.collectorStatus.startsWith('Collector running at')) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.notEqual(workspace.telemetry.collector, first);
  assert.match(workspace.telemetry.collectorStatus, /^Collector running at/);
  assert.equal(workspace.telemetry.exporterUrl, endpoint);
});
