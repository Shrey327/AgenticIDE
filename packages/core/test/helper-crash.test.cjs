const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

function running(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
  try {
    return !/^[ZX]/.test(
      execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    );
  } catch {
    return false;
  }
}
test(
  'abrupt IDE death terminates JSON helper and TERM-resistant grandchildren',
  { skip: process.platform === 'win32', timeout: 15000 },
  async (t) => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'aiide-json-helper-crash-'),
    );
    const ready = path.join(root, 'grandchild.ready'),
      pidsFile = path.join(root, 'pids.json');
    let ide, pids;
    t.after(() => {
      try {
        ide?.kill('SIGKILL');
      } catch {}
      for (const pid of Object.values(pids || {})) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
      fs.rmSync(root, { recursive: true, force: true });
    });
    const target = `const fs=require('node:fs'),cp=require('node:child_process');process.on('SIGTERM',()=>{});const child=cp.spawn(process.execPath,['-e',${JSON.stringify("process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(" + JSON.stringify(ready) + ",'ready');setInterval(()=>{},1000);")}],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidsFile)},JSON.stringify({target:process.pid,grandchild:child.pid}));setInterval(()=>{},1000);`;
    const launcher = path.join(root, 'mock-ide.cjs');
    fs.writeFileSync(
      launcher,
      `const {subprocess}=require(${JSON.stringify(path.resolve(__dirname, '../lib/ssh'))});subprocess(process.execPath,['-e',${JSON.stringify(target)}],{unicode:'hello 🌍'},120000).catch(()=>{});`,
    );
    ide = spawn(process.execPath, [launcher], { stdio: 'ignore' });
    for (let i = 0; i < 200 && !fs.existsSync(ready); i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(ready));
    pids = JSON.parse(fs.readFileSync(pidsFile));
    ide.kill('SIGKILL');
    const deadline = Date.now() + 8000;
    while (Object.values(pids).some(running) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(
      Object.values(pids).every((pid) => !running(pid)),
      'helpers must stop without reopening a workspace',
    );
  },
);
