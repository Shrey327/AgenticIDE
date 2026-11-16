const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { Store, saveProject } = require('../lib');
const { Runs } = require('../lib/runs');
const sdk = path.resolve(__dirname, '../../../python');
const telemetry = { url: 'http://127.0.0.1:1/events', token: 'fixture-token', exporterUrl: 'http://127.0.0.1:1/otel' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await pause(25);
  }
  assert.ok(check(), 'Condition did not become true before the deadline');
}
function running(pid) {
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  try {
    return !/^[ZX]/.test(execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch { return false; }
}
function fixture(t, project = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-local-run-'));
  saveProject(root, { version: 1, name: 'local jobs', environment: { python: 'python3' }, ...project });
  const store = new Store(path.join(root, '.aiide/workspace.sqlite'));
  const connections = { get() { throw new Error('No fixture service'); }, vault: {} };
  const runs = new Runs(root, store, telemetry, sdk, connections);
  t.after(async () => { await runs.stop(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, runs, store, connections };
}
function treeScript() {
  return `const fs=require('node:fs'),cp=require('node:child_process');
const child=cp.spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});require('node:fs').writeFileSync('grandchild.ready','ready');setInterval(()=>{},1000)"],{stdio:'ignore'});
process.on('SIGTERM',()=>fs.writeFileSync('checkpoint','saved'));
fs.writeFileSync('pids.json',JSON.stringify({target:process.pid,grandchild:child.pid}));
setInterval(()=>{},1000);`;
}

test('local supervisor preserves argv, environment, telemetry and content privacy', { skip: process.platform === 'win32' }, async t => {
  const { root, runs, store } = fixture(t);
  fs.writeFileSync(path.join(root, 'subprocess.py'), 'raise RuntimeError("Untrusted workspace import")');
  const argument = 'literal $(touch unexpected) ; "quoted"';
  const script = `require('node:fs').writeFileSync('result.json',JSON.stringify({args:process.argv.slice(1),value:process.env.CUSTOM_VALUE,run:process.env.AIIDE_RUN_ID,token:process.env.AIIDE_TOKEN,endpoint:process.env.AIIDE_EVENTS_ENDPOINT,pythonpath:process.env.PYTHONPATH}));console.log('private job output');`;
  const command = [process.execPath, '-e', script, argument];
  const run = await runs.start('fixture', undefined, { CUSTOM_VALUE: 'unchanged' }, { command });
  await until(() => store.run(run.id).status !== 'running');
  assert.equal(store.run(run.id).status, 'completed');
  assert.deepEqual(store.run(run.id).command, command);
  const result = JSON.parse(fs.readFileSync(path.join(root, 'result.json')));
  assert.deepEqual(result.args, [argument]);
  assert.equal(result.value, 'unchanged');
  assert.equal(result.run, run.id);
  assert.equal(result.token, telemetry.token);
  assert.equal(result.endpoint, telemetry.url);
  assert.equal(result.pythonpath.split(path.delimiter)[0], sdk);
  assert.ok(!fs.existsSync(path.join(root, 'unexpected')));
  assert.equal(store.events(run.id, 'log')[0].value, '[CONTENT DISABLED]');
});

test('local target launch failures remain visible when content capture is disabled', { skip: process.platform === 'win32' }, async t => {
  const { runs, store } = fixture(t);
  const run = await runs.start('missing', undefined, {}, { command: ['aiide-command-does-not-exist-ec4cfbf3'] });
  await until(() => store.run(run.id).status !== 'running');
  assert.equal(store.run(run.id).status, 'failed');
  assert.match(store.events(run.id, 'diagnostic')[0].value, /No such file|not found/i);
  assert.equal(store.events(run.id, 'diagnostic')[0].name, 'Launch failed');
});

test('cancellation allows checkpoints then kills target and stubborn grandchildren', { skip: process.platform === 'win32' }, async t => {
  const { root, runs, store } = fixture(t);
  const run = await runs.start('tree', undefined, {}, { command: [process.execPath, '-e', treeScript()] });
  await until(() => fs.existsSync(path.join(root, 'pids.json')));
  const pids = JSON.parse(fs.readFileSync(path.join(root, 'pids.json')));
  await until(() => fs.existsSync(path.join(root, 'grandchild.ready')));
  const started = Date.now();
  runs.cancel(run.id);
  assert.equal(store.run(run.id).status, 'cancelled');
  await until(() => !running(pids.target) && !running(pids.grandchild));
  assert.ok(Date.now() - started >= 2700, 'The checkpoint grace period must run before SIGKILL');
  assert.equal(fs.readFileSync(path.join(root, 'checkpoint'), 'utf8'), 'saved');
  await runs.stop();
});

test('a completed command also cleans up leftover descendants', { skip: process.platform === 'win32' }, async t => {
  const { root, runs, store } = fixture(t);
  const script = `const cp=require('node:child_process'),fs=require('node:fs');const child=cp.spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});fs.writeFileSync('grandchild.pid',String(child.pid));setTimeout(()=>process.exit(0),150);`;
  const run = await runs.start('daemon', undefined, {}, { command: [process.execPath, '-e', script] });
  await until(() => store.run(run.id).status !== 'running');
  assert.equal(store.run(run.id).status, 'completed');
  assert.equal(running(Number(fs.readFileSync(path.join(root, 'grandchild.pid'), 'utf8'))), false);
});

test('IDE SIGKILL closes the parent sentinel and terminates the entire local job group', { skip: process.platform === 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-parent-death-'));
  const parentScript = `const {Store,saveProject}=require(process.argv[2]);const {Runs}=require(require('node:path').join(process.argv[2],'runs'));
const root=process.argv[1];saveProject(root,{version:1,name:'parent death'});
const store=new Store(require('node:path').join(root,'workspace.sqlite'));
const runs=new Runs(root,store,${JSON.stringify(telemetry)},process.argv[3],{});
runs.start('tree',undefined,{}, {command:[process.execPath,'-e',${JSON.stringify(treeScript())}]}).then(run=>process.send({run:run.id}));
setInterval(()=>{},1000);`;
  const parent = spawn(process.execPath, ['-e', parentScript, root, path.resolve(__dirname, '../lib'), sdk], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let pids;
  t.after(async () => {
    parent.kill('SIGKILL');
    if (pids) { try { process.kill(-pids.target, 'SIGKILL'); } catch {} }
    fs.rmSync(root, { recursive: true, force: true });
  });
  let errors = '';
  parent.stderr.on('data', data => { errors = (errors + String(data)).slice(-3000); });
  await until(() => fs.existsSync(path.join(root, 'pids.json')) || parent.exitCode !== null);
  assert.ok(fs.existsSync(path.join(root, 'pids.json')), errors);
  pids = JSON.parse(fs.readFileSync(path.join(root, 'pids.json')));
  await until(() => fs.existsSync(path.join(root, 'grandchild.ready')));
  parent.kill('SIGKILL');
  await until(() => !running(pids.target) && !running(pids.grandchild));
  assert.equal(fs.readFileSync(path.join(root, 'checkpoint'), 'utf8'), 'saved');
  const reopened = new Store(path.join(root, 'workspace.sqlite'));
  assert.equal(reopened.runs()[0].status, 'interrupted');
  reopened.close();
});

test('closed runs refuse new launches, including a launch awaiting service credentials', async t => {
  const { root, runs, store, connections } = fixture(t, { services: { chat: 'fixture' } });
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  connections.get = () => ({ kind: 'model', url: 'http://127.0.0.1:1', credentialRef: 'vault-reference' });
  connections.vault.get = async () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const launch = runs.start('late', undefined, {}, { command: [process.execPath, '-e', "require('node:fs').writeFileSync('late','unsafe')"] });
  await waiting;
  await runs.stop();
  release('fixture-secret');
  await assert.rejects(launch, /closed/);
  await assert.rejects(runs.start('late', undefined, {}, { command: [process.execPath, '-e', ''] }), /closed/);
  assert.equal(store.runs().length, 0);
  assert.ok(!fs.existsSync(path.join(root, 'late')));
});
