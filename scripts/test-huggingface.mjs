import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import core from '../packages/core/lib/index.js';

// Explicit opt-in acceptance: downloads ~1.2 GB once, then runs one real Qwen LoRA step.
const root = path.resolve(
  process.env.AIIDE_HF_TEST_ROOT || 'artifacts/qwen-smoke/workspace',
);
const python = path.resolve(
  process.env.AIIDE_HF_TEST_PYTHON || 'templates/finetune/.venv/bin/python',
);
fs.mkdirSync(root, { recursive: true });
assert.ok(
  fs.existsSync(python),
  'Install the locked finetune template environment first',
);
core.saveProject(root, {
  version: 1,
  name: 'Qwen 0.6B smoke test',
  environment: { python },
  telemetry: { captureContent: false },
});
fs.writeFileSync(
  path.join(root, 'smoke.jsonl'),
  [
    'A classification model predicts categories.',
    'Use validation data to compare model hyperparameters.',
    'Separate training and test examples to avoid leakage.',
    'An SVM finds a decision boundary between classes.',
  ]
    .map((text) => JSON.stringify({ text }))
    .join('\n'),
);
const workspace = await core.Workspace.open(root);
const wait = async (run) => {
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const current = workspace.store.run(run.id);
    if (current.status !== 'running') {
      assert.equal(
        current.status,
        'completed',
        JSON.stringify(workspace.store.events(run.id)),
      );
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  workspace.runs.cancel(run.id);
  throw new Error('Qwen smoke job exceeded 15 minutes');
};
try {
  const status = await workspace.operation('hf.status');
  assert.ok(status.ready, `Missing packages: ${status.missing.join(', ')}`);
  let model = (await workspace.operation('hf.models')).find(
    (model) => model.repo === 'Qwen/Qwen3-0.6B' && model.kind === 'base',
  );
  if (!model) {
    await wait(
      await workspace.operation('hf.download', { repo: 'Qwen/Qwen3-0.6B' }),
    );
    model = (await workspace.operation('hf.models')).find(
      (model) => model.kind === 'base',
    );
  }
  const device = process.env.AIIDE_HF_TEST_DEVICE || 'auto';
  const trained = await wait(
    await workspace.operation('hf.train', {
      model: model.path,
      dataset: 'smoke.jsonl',
      steps: 1,
      maxLength: 64,
      rank: 4,
      device,
    }),
  );
  const adapter = (await workspace.operation('hf.models')).find(
    (model) => model.path === trained.configuration.huggingface.output,
  );
  assert.ok(adapter && Number.isFinite(adapter.loss));
  const inference = await workspace.operation('hf.generate', {
    model: adapter.path,
    prompt: 'What does a classification model predict? Answer in one sentence.',
    maxNewTokens: 32,
    device,
  });
  await wait(inference);
  const result = await workspace.operation('hf.result', {
    file: inference.output,
  });
  assert.ok(result.text.trim() && result.tokens > 0);
  const summary = {
    repo: model.repo,
    revision: model.revision,
    device: adapter.device,
    loss: adapter.loss,
    steps: 1,
    tokens: result.tokens,
    generationSeconds: result.seconds,
    text: result.text,
    runIds: [trained.id, inference.id],
  };
  fs.writeFileSync(
    path.join(root, 'smoke-result.json'),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await workspace.close();
}
