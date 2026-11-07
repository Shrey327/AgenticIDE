import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import core from '../packages/core/lib/index.js';
import { wandbFixture } from './fixtures/wandb-server.mjs';
const { Connections, Wandb, bundledResources } = core;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-wandb-'));
fs.mkdirSync(path.join(root, '.aiide'));
const fixture = await wandbFixture();
try {
  const secrets = new Map();
  const connections = new Connections(path.join(root, '.aiide'), {
    get: async (k) => secrets.get(k),
    set: async (k, v) => {
      secrets.set(k, v);
    },
  });
  await connections.save(
    { id: 'wandb', kind: 'wandb', url: fixture.url },
    fixture.secret,
  );
  const reader = new Wandb(root, bundledResources, connections);
  await reader.install();
  const args = { connection: 'wandb', project: 'fixture/training' };
  const runs = await reader.query({ ...args, operation: 'runs' });
  assert.equal(runs.items.length, 25);
  assert.equal(runs.nextOffset, 25);
  assert.equal(runs.items[0].config.api_key, '[REDACTED]');
  const next = await reader.query({ ...args, operation: 'runs', offset: 25 });
  assert.equal(next.items.length, 5);
  assert.equal(next.nextOffset, null);
  const history = await reader.query({
    ...args,
    run: 'run0',
    operation: 'history',
  });
  assert.equal(history.items.length, 500);
  assert.equal(history.nextStep, 500);
  assert.equal(history.items[0].loss, 1);
  const remaining = await reader.query({
    ...args,
    run: 'run0',
    operation: 'history',
    step: 500,
  });
  assert.equal(remaining.items.length, 250);
  assert.equal(remaining.nextStep, null);
  assert.equal(remaining.items[0]._step, 500);
  const artifacts = await reader.query({
    ...args,
    run: 'run0',
    operation: 'artifacts',
  });
  assert.equal(artifacts.items[0].name, 'checkpoint:v0');
  const files = await reader.query({
    ...args,
    run: 'run0',
    operation: 'artifact.files',
    artifact: 'checkpoint:v0',
  });
  assert.equal(files.items[0].name, 'checkpoint.json');
  await assert.rejects(
    reader.query({
      ...args,
      run: 'run0',
      operation: 'artifact.files',
      artifact: 'unknown:v0',
    }),
    /not in/,
  );
  await assert.rejects(reader.query({ ...args, operation: 'delete' }));
  fixture.rejectAuth();
  await assert.rejects(reader.query({ ...args, operation: 'runs' }));
  assert.ok(fixture.operations.includes('HistoryPage'));
  assert.ok(
    !fs
      .readFileSync(path.join(root, '.aiide/connections.json'), 'utf8')
      .includes(fixture.secret),
  );
  console.log(
    'PASS: actual W&B SDK → HTTP fixture; paginated runs/history, artifact metadata/files, redaction, read-only policy, and authentication failure',
  );
} finally {
  await fixture.close();
  fs.rmSync(root, { recursive: true, force: true });
}
