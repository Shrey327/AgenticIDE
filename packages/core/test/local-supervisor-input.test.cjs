const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

test(
  'trusted helper forwarding preserves stdin JSON and never forwards liveness/diagnostic descriptors',
  { skip: process.platform === 'win32', timeout: 10000 },
  async (t) => {
    for (const forward of [true, false]) {
      const script =
        "import json,os,sys\npayload=sys.stdin.read()\nclosed=[]\nfor descriptor in (3,4):\n try:os.fstat(descriptor)\n except OSError:closed.append(descriptor)\nprint(json.dumps({'payload':json.loads(payload) if payload else None,'closed':closed}))\n";
      const args = [
        '-I',
        path.resolve(__dirname, '../../../python/aiide_runtime/local.py'),
        ...(forward ? ['--forward-stdin'] : []),
        'python3',
        '-I',
        '-c',
        script,
      ];
      const child = spawn('python3', args, {
        stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      });
      t.after(() => {
        child.stdio[3].destroy();
        if (child.exitCode === null) child.kill('SIGTERM');
      });
      const output = [],
        diagnostics = [];
      child.stdout.on('data', (chunk) => output.push(chunk));
      child.stdio[4].on('data', (chunk) => diagnostics.push(chunk));
      child.stdin.on('error', () => {});
      const result = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => resolve(code));
      });
      const payload = {
        message: 'literal $() `quotes` and Unicode λ',
        items: [1, 2, 3],
      };
      child.stdin.end(JSON.stringify(payload));
      assert.equal(await result, 0);
      assert.deepEqual(JSON.parse(Buffer.concat(output).toString()), {
        payload: forward ? payload : null,
        closed: [3, 4],
      });
      assert.equal(Buffer.concat(diagnostics).length, 0);
    }
  },
);
