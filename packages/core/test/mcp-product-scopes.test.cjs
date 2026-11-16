const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const {
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { Store, Sandbox, McpEndpoint } = require('../lib');

test('product mutations remain IDE-only and voice/RL launches require workflow scope', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-mcp-product-'));
  const store = new Store(path.join(root, 'db.sqlite'));
  const sandbox = new Sandbox(root, path.join(root, '.aiide/sessions'), store);
  const calls = [];
  const endpoint = new McpEndpoint(sandbox, store, async (operation, args) => {
    calls.push({ operation, args });
    if (operation === 'rl.isCustomPolicy')
      return args.policy === 'custom-policy.json';
    return { operation };
  });
  const clients = [];
  await endpoint.start();
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await endpoint.stop();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function connect(scopes) {
    const grant = endpoint.issue(scopes);
    const client = new Client({
      name: 'product-scope-regression',
      version: '1.0',
    });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(grant.url), {
        requestInit: { headers: { Authorization: `Bearer ${grant.token}` } },
      }),
    );
    return client;
  }
  const read = await connect(['read']);
  const staged = await connect(['read', 'edit', 'execute']);
  const workflow = await connect(['read', 'workflow']);
  for (const client of [read, staged]) {
    assert.ok(
      !(await client.listTools()).tools.some(
        (tool) => tool.name === 'run_workflow',
      ),
    );
    for (const operation of ['voice.start', 'rl.train', 'rl.rollout']) {
      assert.equal(
        (
          await client.callTool({
            name: 'run_workflow',
            arguments: { operation, args: {} },
          })
        ).isError,
        true,
      );
    }
  }
  const ideOnly = [
    'documents.preview',
    'documents.save',
    'bundles.files',
    'bundles.preview',
    'bundles.export',
    'bundles.inspect',
    'bundles.import',
    'knowledge.save',
    'knowledge.delete',
    'knowledge.compile',
    'knowledge.import',
    'knowledge.refresh',
    'knowledge.proposals',
    'knowledge.applyProposal',
    'knowledge.discardProposal',
    'knowledge.history',
    'knowledge.restore',
    'knowledge.configureMaintenance',
    'knowledge.scan',
    'knowledge.cancel',
    'evals.snapshot',
    'evals.exportCase',
    'evals.exportTrace',
    'voice.save',
    'voice.token',
    'voice.localStart',
    'sandbox.prepare',
    'sandbox.run',
    'sandbox.apply',
    'rag.ingest',
    'rag.removeSource',
    'rag.previewIdentityReset', 'rag.resetIdentity',
    'drafts.get',
    'drafts.save',
    'sandbox.configure',
    'sandbox.capabilities',
    'rl.environments',
    'rl.previewEnvironment',
    'rl.registerEnvironment',
    'rl.checkEnvironment',
    'rl.isCustomPolicy',
    'rl.trainBuiltin',
    'rl.rolloutBuiltin',
    'knowledge.indexSemantic',
    'knowledge.graph',
    'evidence.list',
    'evidence.get',
    'evidence.preview',
    'evidence.save',
    'evidence.complete',
    'evidence.delete',
    'evidence.exportPreview',
    'evidence.export',
  ];
  for (const operation of ideOnly) {
    for (const name of ['inspect_workflow', 'run_workflow']) {
      const result = await workflow.callTool({
        name,
        arguments: { operation, args: {} },
      });
      assert.equal(
        result.isError,
        true,
        `${operation} must not be exposed through ${name}`,
      );
    }
  }
  assert.deepEqual(
    calls,
    [],
    'Rejected operations must never reach the workspace dispatcher',
  );
  for (const operation of [
    'documents.status',
    'knowledge.maintenance',
    'voice.status',
    'voice.profiles',
    'rl.status',
    'rl.catalog',
    'rl.policies',
    'evals.datasets',
  ]) {
    assert.equal(
      (
        await read.callTool({
          name: 'inspect_workflow',
          arguments: { operation },
        })
      ).isError,
      undefined,
    );
  }
  for (const operation of ['voice.start', 'rl.train', 'rl.rollout']) {
    assert.equal(
      (
        await workflow.callTool({
          name: 'run_workflow',
          arguments: { operation, args: { id: 'fixture' } },
        })
      ).isError,
      undefined,
    );
  }
  assert.deepEqual(
    calls.slice(-4).map((call) => call.operation),
    [
      'voice.start',
      'rl.trainBuiltin',
      'rl.isCustomPolicy',
      'rl.rolloutBuiltin',
    ],
  );
  for (const args of [
    { environment: 'custom:reviewed' },
    { environment: 'CartPole-v1', resume: 'custom-policy.json' },
  ])
    assert.equal(
      (
        await workflow.callTool({
          name: 'run_workflow',
          arguments: { operation: 'rl.train', args },
        })
      ).isError,
      true,
    );
  assert.equal(
    (
      await workflow.callTool({
        name: 'run_workflow',
        arguments: {
          operation: 'rl.rollout',
          args: { policy: 'custom-policy.json' },
        },
      })
    ).isError,
    true,
  );
  for (const operation of [
    'knowledge.indexSemantic',
    'knowledge.searchSemantic',
  ])
    assert.equal(
      (
        await read.callTool({
          name: 'inspect_workflow',
          arguments: { operation },
        })
      ).isError,
      true,
    );
  assert.equal(
    (
      await read.callTool({
        name: 'run_workflow',
        arguments: {
          operation: 'knowledge.searchSemantic',
          args: { query: 'test' },
        },
      })
    ).isError,
    true,
  );
  assert.equal(
    (
      await workflow.callTool({
        name: 'run_workflow',
        arguments: {
          operation: 'knowledge.searchSemantic',
          args: { query: 'test' },
        },
      })
    ).isError,
    undefined,
  );
});
