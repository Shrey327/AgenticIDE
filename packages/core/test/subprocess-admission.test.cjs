const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { subprocess } = require('../lib/ssh');

test(
  'eight real helpers admit no ninth child and cancelled slots become reusable',
  { timeout: 15000 },
  async (t) => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'aiide-helper-admission-'),
    );
    const controllers = Array.from({ length: 8 }, () => new AbortController());
    const script =
      "const fs=require('node:fs');fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);";
    const jobs = controllers.map((controller, index) =>
      subprocess(
        process.execPath,
        ['-e', script, path.join(root, String(index))],
        {},
        30000,
        process.env,
        controller.signal,
      ),
    );
    const outcomes = jobs.map((job) =>
      job.then(
        (value) => ({ value }),
        (error) => ({ error }),
      ),
    );
    t.after(async () => {
      controllers.forEach((controller) => controller.abort());
      await Promise.all(outcomes);
      fs.rmSync(root, { recursive: true, force: true });
    });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && fs.readdirSync(root).length < 8)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      fs.readdirSync(root).length,
      8,
      'all eight admitted targets must actually be running',
    );
    const ninth = path.join(root, 'ninth');
    await assert.rejects(
      subprocess(process.execPath, ['-e', script, ninth], {}),
      /eight|8|busy|active|limit/i,
    );
    assert.equal(
      fs.existsSync(ninth),
      false,
      'rejected work must never spawn its target',
    );
    controllers.forEach((controller) => controller.abort());
    for (const outcome of await Promise.all(outcomes))
      assert.match(String(outcome.error), /cancelled/);
    const value = await subprocess(
      process.execPath,
      [
        '-e',
        'process.stdout.write(JSON.stringify({ok:true,result:"slot reused"}))',
      ],
      {},
    );
    assert.equal(value, 'slot reused');
  },
);

test(
  'circular, oversized and invalid arguments cannot spawn work or leak admission slots',
  { timeout: 10000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-helper-input-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const marker = path.join(root, 'must-not-start');
    const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');process.stdout.write('{"ok":true,"result":1}');`;
    const circular = {};
    circular.self = circular;
    for (let i = 0; i < 9; i++)
      await assert.rejects(
        subprocess(process.execPath, ['-e', script], circular),
        /circular|JSON|serializ/i,
      );
    await assert.rejects(
      subprocess(process.execPath, ['-e', script], {
        text: 'x'.repeat(24 * 1024 * 1024),
      }),
      /24|MB|large|exceed|budget/i,
    );
    await assert.rejects(
      subprocess(process.execPath, ['-e', script], {
        text: '🐍'.repeat(6 * 1024 * 1024),
      }),
      /24|MB|large|exceed|budget/i,
    );
    for (let i = 0; i < 9; i++)
      await assert.rejects(subprocess('invalid\0command', [], {}));
    assert.equal(fs.existsSync(marker), false);
    assert.equal(
      await subprocess(
        process.execPath,
        ['-e', 'process.stdout.write(JSON.stringify({ok:true,result:7}))'],
        {},
      ),
      7,
    );
  },
);

test('valid larger reward-style requests retain streaming stdin compatibility', async () => {
  const value = await subprocess(
    process.execPath,
    [
      '-e',
      "let body='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>body+=chunk);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({ok:true,result:JSON.parse(body).text.length})));",
    ],
    { text: 'x'.repeat(3 * 1024 * 1024) },
  );
  assert.equal(value, 3 * 1024 * 1024);
});
