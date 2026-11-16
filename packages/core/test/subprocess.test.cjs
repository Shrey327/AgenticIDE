const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { subprocess } = require('../lib/ssh');

test(
  'bounded helper timeout terminates native/helper descendants on POSIX',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-process-tree-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const pidFile = path.join(root, 'child.pid');
    const script = `const cp=require('node:child_process');const fs=require('node:fs');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(child.pid));setInterval(()=>{},1000);`;
    await assert.rejects(
      subprocess(process.execPath, ['-e', script, pidFile], {}, 1000),
      /timed out/,
    );
    assert.ok(fs.existsSync(pidFile));
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    let alive = true;
    for (let i = 0; i < 30; i++) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') {
          alive = false;
          break;
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (alive) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    assert.equal(
      alive,
      false,
      'Timed-out helper descendants must not keep running',
    );
  },
);

test(
  'helper cancellation waits for exit before reporting completion',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-helper-cancel-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const pidFile = path.join(root, 'helper.pid');
    const script = `require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);`;
    const controller = new AbortController();
    const pending = subprocess(
      process.execPath,
      ['-e', script, pidFile],
      {},
      30000,
      process.env,
      controller.signal,
    );
    const rejected = assert.rejects(pending, /cancelled/);
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(pidFile));
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    controller.abort();
    await rejected;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  },
);
