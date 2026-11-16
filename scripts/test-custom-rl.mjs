import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import core from '../packages/core/lib/index.js';

const python =
  process.env.AIIDE_RL_TEST_PYTHON ||
  path.resolve('templates/rl/.venv/bin/python');
assert.ok(
  fs.existsSync(python),
  'Set AIIDE_RL_TEST_PYTHON to the pinned advanced RL environment',
);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-real-custom-rl-'));
let workspace;
try {
  core.saveProject(root, {
    version: 1,
    name: 'Actual custom RL',
    environment: { python },
  });
  fs.copyFileSync(
    'templates/rl/custom_target.py',
    path.join(root, 'custom_target.py'),
  );
  fs.mkdirSync(path.join(root, 'aiide_rl'));
  fs.writeFileSync(
    path.join(root, 'aiide_rl/__init__.py'),
    "from pathlib import Path\nPath('shadow-executed').write_text('bad')\nraise RuntimeError('workspace runtime shadow must never execute')\n",
  );
  workspace = await core.Workspace.open(root);
  const rl = workspace.rl;
  const wait = async (run) => {
    const deadline = Date.now() + 180000;
    while (
      workspace.store.run(run.id).status === 'running' &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      workspace.store.run(run.id).status,
      'completed',
      JSON.stringify(workspace.store.events(run.id)),
    );
  };
  for (const algorithm of ['ppo', 'sac']) {
    const definition = {
      id: algorithm,
      title: 'Target ' + algorithm,
      entrypoint: 'custom_target.py',
      factory: 'make_env',
      files: ['custom_target.py'],
      parameters: { continuous: algorithm === 'sac', target: 0.7 },
    };
    const preview = rl.previewEnvironment(definition);
    rl.registerEnvironment({
      ...definition,
      reviewHash: preview.reviewHash,
      confirmed: true,
    });
    const checked = await rl.checkEnvironment({ id: algorithm });
    assert.ok(checked.valid);
    assert.ok(checked.algorithms.includes(algorithm));
    const request = {
      algorithm,
      environment: 'custom:' + algorithm,
      timesteps: algorithm === 'ppo' ? 2048 : 1024,
      workers: algorithm === 'ppo' ? 2 : 1,
      seeds: algorithm === 'ppo' ? [42, 43] : [42],
      evalEpisodes: 3,
      maxSteps: 10,
    };
    await wait(await rl.train(request));
    const policy = rl
      .policies()
      .find((policy) => policy.config.environment === request.environment);
    assert.ok(policy);
    assert.ok(
      policy.evaluation.meanReward > policy.baseline.meanReward + 2,
      JSON.stringify(policy),
    );
    const rollout = await rl.rollout({ policy: policy.path, seed: 12345 });
    assert.equal(rollout.environment, request.environment);
    assert.equal(rollout.observations.length, rollout.actions.length + 1);
    assert.ok(rollout.observationNames[0].startsWith('observation'));
    await wait(
      await rl.train({ ...request, timesteps: 128, resume: policy.path }),
    );
    const resumed = rl
      .policies()
      .find((next) => next.config.resume === policy.path);
    assert.ok(
      resumed.checkpoints.every(
        (checkpoint, index) =>
          checkpoint.timesteps > policy.checkpoints[index].timesteps,
      ),
    );
    assert.ok(
      workspace.store
        .events(
          workspace.store
            .runs()
            .find((run) => run.name === `RL · ${request.environment}`).id,
        )
        .some((event) => event.name.startsWith('rl.')),
    );
    console.log(
      'REAL CUSTOM',
      algorithm,
      JSON.stringify({
        baseline: policy.baseline,
        evaluation: policy.evaluation,
        revision: preview.reviewHash,
        workers: request.workers,
      }),
    );
  }
  const last = rl
    .policies()
    .find((policy) => policy.config.environment === 'custom:ppo');
  fs.appendFileSync(
    path.join(root, 'custom_target.py'),
    '\n# revision changed\n',
  );
  await assert.rejects(
    async () => rl.rollout({ policy: last.path }),
    /changed/,
  );
  assert.throws(
    () => rl.train({ algorithm: 'ppo', environment: 'custom:ppo' }),
    /changed/,
  );
  assert.equal(
    fs.existsSync(path.join(root, 'shadow-executed')),
    false,
    'project package must not replace the bundled runtime',
  );
  fs.writeFileSync(
    path.join(root, 'blocking_env.py'),
    "def make_env(parameters):\n import os,time\n from pathlib import Path\n Path('blocking-helper.pid').write_text(str(os.getpid()))\n time.sleep(60)\n",
  );
  const blocking = {
    id: 'blocking',
    title: 'Shutdown regression',
    entrypoint: 'blocking_env.py',
    factory: 'make_env',
    files: ['blocking_env.py'],
    parameters: {},
  };
  const reviewed = rl.previewEnvironment(blocking);
  rl.registerEnvironment({
    ...blocking,
    reviewHash: reviewed.reviewHash,
    confirmed: true,
  });
  const helper = assert.rejects(
    rl.checkEnvironment({ id: 'blocking' }),
    /cancelled|closed/,
  );
  const pidFile = path.join(root, 'blocking-helper.pid');
  for (let attempt = 0; attempt < 200 && !fs.existsSync(pidFile); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(
    fs.existsSync(pidFile),
    'actual reviewed factory must be running before shutdown',
  );
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  await workspace.close();
  await helper;
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  console.log(
    'PASS: actual reviewed custom PPO/SAC → Gym checker → spawned workers → held-out improvement → telemetry → checkpoint/resume → rollout; changed source denied; workspace close kills blocked factory helper',
  );
} finally {
  await workspace?.rl.close();
  await workspace?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
