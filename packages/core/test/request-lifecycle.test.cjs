const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {
  Connections,
  Evals,
  Store,
  HuggingFace,
  saveProject,
} = require('../lib');

async function fixture(t, respond) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-request-close-'));
  saveProject(root, {
    version: 1,
    name: 'Shutdown',
    environment: { python: 'python3' },
  });
  const requests = [];
  const cleanup = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    respond?.(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const connections = new Connections(path.join(root, '.aiide'));
  await connections.save({
    id: 'local',
    kind: 'model',
    model: 'fixture',
    url: `http://127.0.0.1:${server.address().port}`,
  });
  t.after(async () => {
    connections.close();
    for (const close of cleanup) await close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, requests, connections, cleanup };
}

async function until(check) {
  for (let i = 0; i < 200 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), 'Expected the active operation to reach its fixture');
}

test(
  'connection shutdown aborts real pending headers and streaming response bodies',
  { timeout: 10000 },
  async (t) => {
    const first = await fixture(t);
    const pending = assert.rejects(
      first.connections.request('local', '/hanging'),
      /closed/,
    );
    await until(() => first.requests.length === 1);
    first.connections.close();
    await pending;
    await assert.rejects(first.connections.request('local', '/late'), /closed/);
    assert.equal(first.requests.length, 1);

    const second = await fixture(t, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"partial":');
    });
    const response = await second.connections.request('local', '/stream');
    const body = assert.rejects(response.json(), /abort|closed/i);
    second.connections.close();
    await body;
  },
);

test('closing while the vault is pending prevents a late provider request', async (t) => {
  const { root, requests, connections: original } = await fixture(t);
  let release,
    entered = false;
  const connections = new Connections(path.join(root, '.aiide'), {
    get: async () => {
      entered = true;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    set: async () => {},
  });
  const value = original.get('local');
  connections.write({ ...value, credentialRef: 'fixture-secret' });
  const pending = assert.rejects(
    connections.request('local', '/must-not-start'),
    /closed/,
  );
  assert.equal(entered, true);
  connections.close();
  release('not-a-real-secret');
  await pending;
  assert.deepEqual(requests, []);
});

test(
  'evaluation shutdown awaits cancelled HTTP workers and rejects new runs',
  { timeout: 10000 },
  async (t) => {
    const { root, requests, connections, cleanup } = await fixture(t);
    const store = new Store(path.join(root, '.aiide', 'test.sqlite'));
    const evals = new Evals(root, store, connections, {});
    cleanup.push(async () => {
      await evals.close();
      store.close();
    });
    fs.writeFileSync(
      path.join(root, 'cases.jsonl'),
      '{"input":"first","expected":"answer"}\n{"input":"second","expected":"answer"}\n',
    );
    const input = {
      dataset: 'cases.jsonl',
      target: 'local',
      scorers: [{ type: 'exact' }],
      concurrency: 2,
    };
    const run = await evals.run(input);
    await until(() => requests.length === 2);
    await evals.close();
    assert.equal(store.run(run.id).status, 'cancelled');
    const data = JSON.parse(
      fs.readFileSync(
        path.join(root, '.aiide/evals', run.id + '.json'),
        'utf8',
      ),
    );
    assert.equal(data.status, 'cancelled');
    assert.equal(evals.active.size, 0);
    assert.equal(evals.pending.size, 0);
    await assert.rejects(evals.run(input), /closed/);
  },
);

test(
  'evaluation shutdown terminates an active Python reward helper',
  { timeout: 10000 },
  async (t) => {
    const { root, connections, cleanup } = await fixture(
      t,
      async (req, res) => {
        for await (const _part of req) {
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({ choices: [{ message: { content: 'answer' } }] }),
        );
      },
    );
    const assets = path.join(root, 'resources');
    fs.mkdirSync(path.join(assets, 'python/aiide_eval'), { recursive: true });
    fs.mkdirSync(path.join(assets, 'python/aiide_runtime'), {
      recursive: true,
    });
    fs.copyFileSync(
      path.resolve(__dirname, '../../../python/aiide_runtime/launch.py'),
      path.join(assets, 'python/aiide_runtime/launch.py'),
    );
    fs.writeFileSync(
      path.join(assets, 'python/aiide_eval/__main__.py'),
      'import json,os,sys,time\nfrom pathlib import Path\nr=json.load(sys.stdin)\nPath(r["file"]).with_suffix(".pid").write_text(str(os.getpid()))\ntime.sleep(60)\n',
    );
    fs.writeFileSync(
      path.join(root, 'reward.py'),
      'def score(output, expected): return 1\n',
    );
    fs.writeFileSync(
      path.join(root, 'cases.jsonl'),
      '{"input":"question","expected":"answer"}\n',
    );
    const store = new Store(path.join(root, '.aiide/test.sqlite'));
    const evals = new Evals(
      root,
      store,
      connections,
      new HuggingFace(root, {}, assets),
    );
    cleanup.push(async () => {
      await evals.close();
      store.close();
    });
    const run = await evals.run({
      dataset: 'cases.jsonl',
      target: 'local',
      scorers: [{ type: 'python', file: 'reward.py' }],
    });
    const pidFile = path.join(root, 'reward.pid');
    await until(() => fs.existsSync(pidFile));
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await evals.close();
    assert.equal(store.run(run.id).status, 'cancelled');
    assert.throws(() => process.kill(pid, 0));
  },
);
