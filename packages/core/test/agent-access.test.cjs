const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { Store, Sandbox, McpEndpoint, saveProject, agentClientSetup, installAgentGuides } = require('../lib');
const temporary = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-agent-test-')); t.after(() => fs.rmSync(root, {recursive:true,force:true})); return root; };
async function client(t, endpoint, scopes) {
  const grant = endpoint.issue(scopes), connection = new Client({ name: 'acceptance-agent', version: '1.0' });
  await connection.connect(new StreamableHTTPClientTransport(new URL(grant.url), { requestInit: { headers: { Authorization: `Bearer ${grant.token}` } } }));
  t.after(() => connection.close()); return connection;
}
const call = async (client, name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify(result.content));
  return result.structuredContent.result;
};

test('agent setup uses environment credentials and preserves existing guidance', t => {
  const root = temporary(t), setup = agentClientSetup('http://127.0.0.1:32123/mcp');
  assert.match(setup.codexCommand, /bearer_token_env_var/);
  assert.equal(JSON.parse(setup.claude).mcpServers.aiide.headers.Authorization, 'Bearer ${AIIDE_MCP_TOKEN}');
  assert.throws(() => agentClientSetup('https://evil.example/mcp'));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Existing instructions');
  assert.deepEqual(installAgentGuides(root), { created:['CLAUDE.md'], skipped:['AGENTS.md'] });
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), 'Existing instructions');
  assert.deepEqual(installAgentGuides(root).created, []);
  fs.unlinkSync(path.join(root,'CLAUDE.md')); fs.symlinkSync('/tmp',path.join(root,'CLAUDE.md'));
  assert.throws(() => installAgentGuides(root), /Symbolic/);
});

test('standard MCP client discovers scoped diagnostics, pages events, and cannot access another credential session', async t => {
  const root = temporary(t), store = new Store(path.join(root,'db.sqlite'));
  saveProject(root, {version:1,name:'agent fixture',commands:{example:['python','main.py']},training:{framework:'pytorch',resume:true}});
  const sandbox = new Sandbox(root,path.join(root,'.aiide/sessions'),store);
  // Staging is tested here without Docker; the runtime acceptance test uses real containers.
  sandbox.available = async () => true; sandbox.prepareImage = async () => {};
  fs.writeFileSync(path.join(root,'main.py'),'print("before")');
  fs.writeFileSync(path.join(root,'.mcp.json'),'{"token":"private"}');
  const endpoint = new McpEndpoint(sandbox,store); await endpoint.start();
  t.after(async () => {await endpoint.stop();store.close();});
  const read = await client(t,endpoint,['read']), full = await client(t,endpoint,['read','edit','execute']);
  const tools = (await read.listTools()).tools;
  assert.ok(tools.every(t => t.annotations.readOnlyHint));
  assert.ok(!tools.some(t => ['create_session','write_file','start_command'].includes(t.name)));
  const info = await call(read,'get_workspace'); assert.equal(info.project.training.framework,'pytorch'); assert.equal(info.execution.hostExecution,false);
  store.saveRun({id:'run',project:'fixture',name:'train',status:'completed',started:Date.now(),command:[],source:'test',environment:{},configuration:{api_key:'sensitive-value'}});
  for(let step=0;step<3;step++) store.event({runId:'run',kind:'metric',name:'loss',value:1/(step+1),step,timestamp:Date.now()});
  store.event({runId:'run',kind:'log',name:'stderr',value:'private text',timestamp:Date.now()});
  assert.equal((await call(read,'inspect_run',{runId:'run'})).run.configuration.api_key,'[REDACTED]');
  const first = await call(read,'inspect_events',{runId:'run',limit:2}); assert.equal(first.hasMore,true);
  const second = await call(read,'inspect_events',{runId:'run',after:first.nextAfter,limit:2}); assert.equal(second.hasMore,false); assert.equal(second.items[1].value,'[CONTENT DISABLED]');
  assert.equal((await call(read,'inspect_metrics',{runId:'run',name:'loss'})).items.length,3);
  const session = await call(full,'create_session');
  assert.ok(!(await call(full,'list_files',{session:session.id})).includes('.mcp.json'));
  assert.equal((await call(full,'list_sessions')).length,1); assert.equal((await call(read,'list_sessions')).length,0);
  assert.equal((await read.callTool({name:'read_file',arguments:{session:session.id,file:'main.py'}})).isError,true);
  await call(full,'write_file',{session:session.id,file:'main.py',text:'print("after")'});
  assert.equal(fs.readFileSync(path.join(root,'main.py'),'utf8'),'print("before")');
  assert.equal((await call(full,'review_changes',{session:session.id}))[0].after,'print("after")');
  assert.ok(!(await full.listTools()).tools.some(t=>['apply_changes','runs.start','training.start'].includes(t.name)));
  await call(full,'close_session',{session:session.id}); assert.equal(endpoint.sessions().length,0);
  await endpoint.revoke(); await assert.rejects(call(read,'get_workspace'));
});
