import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import core from '../packages/core/lib/index.js';

assert.equal(
  process.platform,
  'darwin',
  'Actual VM acceptance requires Apple Silicon macOS 26 and Apple Container 1.7.1+',
);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-vm-acceptance-'));
const kernel = process.env.AIIDE_APPLE_TEST_KERNEL;
const configureKernel = (sandbox) => {
  if (!kernel) return;
  assert.ok(path.isAbsolute(kernel) && fs.statSync(kernel).isFile());
  const original = sandbox.apple.args.bind(sandbox.apple);
  sandbox.apple.args = (...args) => {
    const command = original(...args);
    return [command[0], '--kernel', kernel, ...command.slice(1)];
  };
};
const store = new core.Store(path.join(root, 'runs.sqlite'));
const sandbox = new core.Sandbox(
  root,
  path.join(root, '.aiide/sessions'),
  store,
);
configureKernel(sandbox);
let ide;
const wait = async (check, seconds = 30) => {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.ok(await check(), 'Timed out waiting for actual VM lifecycle');
};
try {
  assert.equal(
    (await sandbox.capabilities()).apple.available,
    true,
    'Start the installed runtime before running this test',
  );
  await sandbox.apple.call(['image', 'inspect', sandbox.image]);
  fs.writeFileSync(path.join(root, '.env'), 'test-only-host-secret');
  fs.writeFileSync(
    path.join(root, 'main.py'),
    `import os,json,socket,resource\nfrom pathlib import Path\nassert os.geteuid()!=0\nassert not any((Path('/sys/class/net')/name/'device').exists() for _,name in socket.if_nameindex())\nassert len(Path('/proc/net/route').read_text().strip().splitlines())<=1\nassert not Path('/workspace/.env').exists()\nassert not Path('/var/run/docker.sock').exists()\nassert not os.environ.get('AIIDE_VM_HOST_SECRET')\nassert os.statvfs('/').f_flag & os.ST_RDONLY\nstatus=Path('/proc/self/status').read_text()\nassert 'NoNewPrivs:\\t1' in status\nassert 'CapEff:\\t0000000000000000' in status\nquota,period=Path('/sys/fs/cgroup/cpu.max').read_text().split()\nassert quota!='max' and int(quota)/int(period)==2\nassert int(Path('/sys/fs/cgroup/memory.max').read_text())==1073741824\nassert resource.getrlimit(resource.RLIMIT_NOFILE)==(1024,1024)\nassert resource.getrlimit(resource.RLIMIT_NPROC)==(128,128)\nassert resource.getrlimit(resource.RLIMIT_FSIZE)==(1073741824,1073741824)\nassert os.statvfs('/tmp').f_blocks*os.statvfs('/tmp').f_frsize<=512*1024*1024\ntry:\n Path('/root-write-must-fail').write_text('no')\n raise AssertionError('Root filesystem writable')\nexcept OSError:pass\ntry:\n socket.create_connection(('1.1.1.1',443),timeout=2)\n raise AssertionError('Network available')\nexcept OSError:pass\nresult={'uid':os.geteuid(),'cpus':os.cpu_count(),'boot':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'kernel':os.uname().release}\nPath('vm-result.json').write_text(json.dumps(result))\nprint(json.dumps(result),flush=True)\n`,
  );
  sandbox.configure({ engine: 'apple-vm' });
  process.env.AIIDE_VM_HOST_SECRET = 'must-not-enter-guest';
  const session = await sandbox.create();
  const first = await sandbox.run(session.id, 'python main.py');
  assert.equal(first.exitCode, 0, first.output);
  const stage = path.join(root, '.aiide/sessions', session.id);
  const before = JSON.parse(
    fs.readFileSync(path.join(stage, 'vm-result.json')),
  );
  const second = await sandbox.run(session.id, 'python main.py');
  assert.equal(second.exitCode, 0, second.output);
  const after = JSON.parse(fs.readFileSync(path.join(stage, 'vm-result.json')));
  assert.notEqual(
    before.boot,
    after.boot,
    'Each command must receive a separate kernel boot',
  );
  assert.equal(fs.existsSync(path.join(root, 'vm-result.json')), false);
  const diff = sandbox.diff(session.id);
  sandbox.apply(session.id, core.hash(JSON.stringify(diff)));
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(root, 'vm-result.json'))),
    after,
  );
  const running = sandbox.run(
    session.id,
    `python -u -c "import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);print('sleeping',flush=True);time.sleep(90)"`,
  );
  await wait(() => sandbox.status(session.id).output.includes('sleeping'));
  const configuration = await sandbox.apple.owned(
    sandbox.sessions.get(session.id).container,
    core.hash(fs.realpathSync(root)),
  );
  assert.deepEqual(configuration.networks, []);
  assert.equal(configuration.readOnly, true);
  await sandbox.cancel(session.id);
  await running;
  assert.equal(sandbox.status(session.id).status, 'cancelled');
  const childRecord = path.join(root, '.aiide/mock-ide.json');
  const fixture = path.join(root, '.aiide/mock-ide.cjs');
  fs.writeFileSync(
    fixture,
    `const fs=require('node:fs'),path=require('node:path'),core=require(${JSON.stringify(path.resolve('packages/core/lib'))});const root=${JSON.stringify(root)},store=new core.Store(path.join(root,'child.sqlite')),sandbox=new core.Sandbox(root,path.join(root,'.aiide/sessions'),store);${kernel ? `const original=sandbox.apple.args.bind(sandbox.apple);sandbox.apple.args=(...args)=>{const command=original(...args);return [command[0],'--kernel',${JSON.stringify(kernel)},...command.slice(1)];};` : ''}(async()=>{const s=await sandbox.create();void sandbox.run(s.id,'python -u -c "import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);print(123456,flush=True);time.sleep(90)"');const poll=setInterval(()=>{if(sandbox.status(s.id).output.includes('123456')){fs.writeFileSync(${JSON.stringify(childRecord)},JSON.stringify({name:sandbox.sessions.get(s.id).container}));clearInterval(poll);}},100);})();`,
  );
  ide = spawn(process.execPath, [fixture], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  ide.stderr.on('data', (part) => {
    diagnostics = (diagnostics + part).slice(-8000);
  });
  await wait(() => {
    assert.equal(ide.exitCode, null, diagnostics);
    return fs.existsSync(childRecord);
  });
  const { name } = JSON.parse(fs.readFileSync(childRecord));
  ide.kill('SIGKILL');
  await wait(async () => {
    const inventory = JSON.parse(
      await sandbox.apple.call(['list', '--all', '--format', 'json']),
    );
    return !inventory.some((record) => record.configuration.id === name);
  });
  console.log(
    'PASS: actual separate Linux VMs, non-root/no-new-privileges, no NIC or host credentials, readonly root, resource limits, distinct kernel boots, cancellation, IDE SIGKILL cleanup and reviewed host application',
  );
  if (kernel)
    console.log(
      'Test-only per-command kernel:',
      path.basename(kernel),
      crypto.createHash('sha256').update(fs.readFileSync(kernel)).digest('hex'),
      '(no runtime default changed)',
    );
} finally {
  delete process.env.AIIDE_VM_HOST_SECRET;
  if (ide?.exitCode === null) ide.kill('SIGKILL');
  await sandbox.stop();
  await sandbox.apple.recover(core.hash(fs.realpathSync(root))).catch(() => {});
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
