const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Workspace, EngineeringBackend } = require('../lib');

test('one cleanup failure cannot leave MCP/telemetry listeners and database open', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = await Workspace.open(root),
    url = workspace.mcp.url;
  const closeKnowledge = workspace.knowledge.close.bind(workspace.knowledge);
  workspace.knowledge.close = async () => {
    throw new Error('simulated cleanup failure');
  };
  await assert.rejects(workspace.close(), AggregateError);
  await closeKnowledge();
  assert.equal(fs.existsSync(path.join(root, '.aiide/workspace.lock')), false);
  await assert.rejects(fetch(url));
  assert.throws(() => workspace.store.runs());
});

test(
  'workspace shutdown aborts in-flight RAG and awaits its final record before closing SQLite',
  { timeout: 10000 },
  async (t) => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'aiide-close-active-rag-'),
    );
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(
      path.join(root, 'source.md'),
      'A source whose embedding must be interrupted',
    );
    let ready;
    const embedding = new Promise((resolve) => {
      ready = resolve;
    });
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url);
      if (req.url === '/v1/embeddings') {
        ready();
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ result: { collections: [] } }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const workspace = await Workspace.open(root);
    t.after(() => workspace.close());
    const url = `http://127.0.0.1:${server.address().port}`;
    await workspace.connections.save({ id: 'db', kind: 'qdrant', url });
    await workspace.connections.save({
      id: 'embed',
      kind: 'model',
      url: url + '/v1',
      model: 'fixture',
    });
    const pending = workspace.operation('rag.ingest', {
      vector: 'db',
      embedding: 'embed',
      collection: 'docs',
      file: 'source.md',
      size: 100,
      overlap: 0,
    });
    const rejected = assert.rejects(pending, /abort|closed/i);
    await embedding;
    const closing = workspace.close();
    assert.equal(
      workspace.close(),
      closing,
      'concurrent callers await the same shutdown',
    );
    await closing;
    await rejected;
    assert.ok(
      !requests.some((request) => request.includes('/points')),
      'aborted embedding must never publish vectors',
    );
    const reopened = await Workspace.open(root);
    try {
      assert.equal(
        reopened.store.runs().find((run) => run.name === 'rag.ingest').status,
        'cancelled',
      );
    } finally {
      await reopened.close();
    }
  },
);

test('closed backend refuses late RPC calls instead of reopening workspace services', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-closed-backend-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backend = new EngineeringBackend();
  await backend.close();
  await assert.rejects(
    backend.request({ workspace: root, operation: 'status' }),
    /closed/,
  );
  assert.equal(fs.existsSync(path.join(root, '.aiide')), false);
});
