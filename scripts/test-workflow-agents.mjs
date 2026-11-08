import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import core from '../packages/core/lib/index.js';
const { Workspace } = core;
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-workflow-agents-')),
);
let workspace, client;
async function connect(directory) {
  workspace = await Workspace.open(directory);
  const grant = workspace.mcp.issue(['read', 'workflow']);
  client = new Client({ name: 'workflow-acceptance', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(grant.url), {
      requestInit: { headers: { Authorization: `Bearer ${grant.token}` } },
    }),
  );
}
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result.content));
  return result.structuredContent.result;
}
const workflow = (operation, args = {}) =>
  call('run_workflow', { operation, args });
async function complete(run, timeout = 180000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const { run: current } = await call('inspect_run', { runId: run.id });
    if (current.status !== 'running') {
      assert.equal(
        current.status,
        'completed',
        JSON.stringify(await call('inspect_events', { runId: run.id })),
      );
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${run.name}`);
}
try {
  await connect(root);
  const created = await workflow('project.create', {
    template: 'sklearn',
    name: 'classification',
  });
  assert.equal(created.root, path.join(root, 'classification'));
  assert.ok(fs.existsSync(path.join(created.root, 'AGENTS.md')));
  await client.close();
  client = undefined;
  await workspace.close();
  workspace = undefined;
  await connect(created.root);
  const originalLock = fs.readFileSync(
    path.join(created.root, 'uv.lock'),
    'utf8',
  );
  await complete(await workflow('environment.setup'));
  assert.equal(
    fs.readFileSync(path.join(created.root, 'uv.lock'), 'utf8'),
    originalLock,
  );
  const sample = await workflow('lab.sample');
  const data = await call('inspect_workflow', {
    operation: 'lab.inspect',
    file: sample.file,
  });
  assert.equal(data.rows, 150);
  const config = {
    file: sample.file,
    target: 'species',
    task: 'classification',
    metrics: ['accuracy', 'f1'],
    primary: 'f1',
    validation: { type: 'kfold', folds: 3 },
    models: [
      { id: 'svm', grid: { C: '0.1,1', kernel: 'rbf' } },
      { id: 'logistic', grid: { C: '1' } },
    ],
  };
  const sweep = await complete(await workflow('lab.sweep', { config }));
  const events = await call('inspect_events', { runId: sweep.id, limit: 100 });
  const metrics = await call('inspect_metrics', { runId: sweep.id });
  assert.ok(events.items.length > 0);
  assert.ok(metrics.names.length > 0);
  await complete(
    await workflow('lab.final', {
      config: {
        file: sample.file,
        target: 'species',
        task: 'classification',
        model: 'svm',
        params: { C: '1', kernel: 'rbf' },
        name: 'Iris classifier',
      },
    }),
  );
  const models = await call('inspect_workflow', { operation: 'lab.models' });
  assert.equal(models.length, 1);
  const prediction = await workflow('lab.predict', {
    model: models[0].path,
    file: sample.file,
  });
  assert.ok(prediction);
  console.log(
    'PASS: MCP-only template creation → locked environment install → Iris data → multi-model sweep → final SVM → batch inference; lockfile preserved',
  );
} finally {
  if (client) await client.close();
  if (workspace) await workspace.close();
  fs.rmSync(root, { recursive: true, force: true });
}
