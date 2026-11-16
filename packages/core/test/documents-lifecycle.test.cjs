const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Documents } = require('../lib/documents');

test('closing documents cancels an active native helper instead of retaining extraction work', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-documents-close-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, 'resources'),
    helper = path.join(assets, 'python/aiide_documents');
  fs.mkdirSync(helper, { recursive: true });
  const pidFile = path.join(root, 'helper.pid');
  fs.writeFileSync(
    path.join(helper, '__main__.py'),
    `import os,time,json,sys\nfrom pathlib import Path\njson.load(sys.stdin)\nPath(${JSON.stringify(pidFile)}).write_text(str(os.getpid()))\ntime.sleep(60)\n`,
  );
  const documents = new Documents(root, assets),
    pending = documents.status();
  t.after(() => documents.close());
  const stopped = assert.rejects(pending, /cancelled/);
  for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(pidFile));
  await documents.close();
  await stopped;
  await assert.rejects(documents.status(), /closed/);
});
