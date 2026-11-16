const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { Workspace, saveProject } = require('../lib');

test('project memory and RL work through Workspace, persist, and respect MCP scopes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-product-'));
  let workspace;
  t.after(async () => { await workspace?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  saveProject(root, { version: 1, name: 'Product workflow', environment: { python: process.env.AIIDE_RL_TEST_PYTHON || 'python3' } });
  workspace = await Workspace.open(root);
  const op = (operation, args) => workspace.operation(operation, args);
  const page = await op('knowledge.save', { title: 'Project decision', body: 'Use held-out seeds for policy evaluation.' });
  assert.equal((await op('knowledge.list', { query: 'held-out' }))[0].id, page.id);
  await assert.rejects(op('knowledge.delete', { id: page.id, revision: 'stale' }), /changed/);
  const catalog = await op('workflows.catalog');
  assert.ok(catalog.reinforcementLearning.steps.includes('rl.train'));
  const grant = workspace.mcp.issue(['read']);
  const client = new Client({ name: 'workflow-audit', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(grant.url), { requestInit: { headers: { Authorization: `Bearer ${grant.token}` } } }));
  try {
    const tools = (await client.listTools()).tools;
    assert.ok(tools.find(tool => tool.name === 'search_knowledge')?.annotations.readOnlyHint);
    assert.ok(!tools.some(tool => /save_knowledge|delete_knowledge|run_workflow/.test(tool.name)));
    const result = await client.callTool({ name: 'read_knowledge', arguments: { id: page.id } });
    assert.equal(result.structuredContent.result.body, page.body);
    assert.equal((await client.callTool({ name: 'inspect_workflow', arguments: { operation: 'rl.catalog' } })).isError, undefined);
    assert.equal((await client.callTool({ name: 'inspect_workflow', arguments: { operation: 'rl.train' } })).isError, true);
  } finally { await client.close(); }
  const run = await op('rl.train', { episodes: 1000, slip: 0, evalEpisodes: 20 });
  const deadline = Date.now() + 20000;
  while (workspace.store.run(run.id).status === 'running' && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(workspace.store.run(run.id).status, 'completed', JSON.stringify(workspace.store.events(run.id)));
  const policies = await op('rl.policies');
  assert.equal(policies.length, 1);
  assert.ok(policies[0].evaluation.successRate > policies[0].baseline.successRate);
  const rollout = await op('rl.rollout', { policy: policies[0].path, seed: 1234 });
  assert.equal(rollout.success, true);
  assert.equal(rollout.states.length, rollout.actions.length + 1);
  assert.ok(workspace.store.events(run.id, 'metric').some(event => event.name === 'rl.episode_reward'));
  const child = await op('project.create', { template: 'rl', name: 'policy-project' });
  assert.ok(fs.existsSync(path.join(child.root, 'aiide_rl', '__init__.py')));
  assert.ok(fs.existsSync(path.join(child.root, 'uv.lock')));
  const standalone = execFileSync(process.env.AIIDE_RL_TEST_PYTHON || 'python3', ['main.py'], {
    cwd: child.root,
    env: { ...process.env, PYTHONPATH: '', AIIDE_EVENTS_ENDPOINT: '', AIIDE_RL_CONFIG: '{"episodes":5}', AIIDE_RL_OUTPUT: 'rl-policies/standalone' },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(JSON.parse(standalone).policy, 'rl-policies/standalone');
  assert.ok(fs.existsSync(path.join(child.root, 'rl-policies/standalone/policy.json')));
  await workspace.close();
  workspace = await Workspace.open(root);
  assert.equal((await op('knowledge.get', { id: page.id })).body, page.body);
  assert.equal((await op('rl.policies')).length, 1);
  assert.equal(workspace.store.run(run.id).status, 'completed');
  await op('knowledge.delete', { id: page.id, revision: page.revision });
  assert.deepEqual(await op('knowledge.list'), []);
});
