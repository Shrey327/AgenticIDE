const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HuggingFace } = require('../lib/huggingface');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-hf-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'models/hf-base'), { recursive: true });
  fs.writeFileSync(path.join(root, 'models/hf-base/aiide-model.json'), JSON.stringify({ format: 'aiide-hf-v1', kind: 'base', repo: 'test/model' }));
  fs.writeFileSync(path.join(root, 'data.jsonl'), '{"text":"training sample"}\n');
  const calls = [];
  const hub = new HuggingFace(root, { store: { runs: () => [], saveRun: () => {} }, start: async (...args) => { calls.push(args); return { id: 'run' }; } }, '/assets');
  return { root, calls, hub };
}
test('Hub jobs validate input and use recorded, cancellable Python runs', async t => {
  const { hub, calls } = fixture(t);
  assert.deepEqual(hub.files(), ['data.jsonl']);
  assert.equal(hub.models().length, 1);
  await hub.download({ repo: 'Qwen/Qwen3-0.6B' });
  assert.deepEqual(calls[0][3].command, ['python', '-m', 'aiide_hf', 'download']);
  assert.equal(JSON.parse(calls[0][2].AIIDE_HF_CONFIG).revision, 'main');
  await hub.train({ model: 'models/hf-base', dataset: 'data.jsonl' });
  assert.equal(calls[1][1].framework, 'transformers');
  const generated = await hub.generate({ model: 'models/hf-base', prompt: 'Hello' });
  assert.match(generated.output, /^\.aiide\/hf-results\//);
  assert.equal(hub.result(generated.output), null);
  assert.throws(() => hub.download({ repo: '../escape' }));
  assert.throws(() => hub.train({ model: 'models/hf-base', dataset: '../outside.jsonl' }), /escapes/);
  assert.throws(() => hub.train({ model: 'models/hf-base', dataset: 'data.jsonl', steps: 0 }));
  assert.throws(() => hub.generate({ model: 'models/hf-missing', prompt: 'Hello' }), /completed/);
  assert.throws(() => hub.result('../../private.json'), /Invalid/);
});
