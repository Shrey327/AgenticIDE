import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import core from '../packages/core/lib/index.js';

const python =
  process.env.AIIDE_RL_TEST_PYTHON ||
  path.resolve('templates/rl/.venv/bin/python');
assert.ok(
  fs.existsSync(python),
  'Install the RL template advanced extra, or set AIIDE_RL_TEST_PYTHON to an environment with the pinned advanced dependencies',
);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-neural-rl-'));
let workspace;
try {
  core.saveProject(root, {
    version: 1,
    name: 'Advanced RL acceptance',
    environment: { python },
  });
  workspace = await core.Workspace.open(root);
  assert.equal((await workspace.rl.status()).available, true);
  const request = {
    algorithm: 'ppo',
    environment: 'CartPole-v1',
    timesteps: 256,
    workers: 2,
    seeds: [42],
    evalEpisodes: 2,
    maxSteps: 100,
  };
  const wait = async (run) => {
    const deadline = Date.now() + 60000;
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
  await wait(await workspace.rl.train(request));
  const policy = workspace.rl.policies()[0];
  assert.equal(policy.format, 'aiide-sb3-v1');
  const rollout = await workspace.rl.rollout({
    policy: policy.path,
    seed: 12345,
  });
  assert.equal(rollout.environment, 'CartPole-v1');
  assert.equal(rollout.observations.length, rollout.actions.length + 1);
  await wait(await workspace.rl.train({ ...request, resume: policy.path }));
  assert.equal(workspace.rl.policies().length, 2);
  console.log(
    'PASS: actual workspace → subprocess PPO workers → telemetry/checkpoint → rollout → resume',
  );
} finally {
  await workspace?.close();
  fs.rmSync(root, { force: true, recursive: true });
}
const result = await promisify(execFile)(
  python,
  [
    '-m',
    'unittest',
    'discover',
    '-s',
    'python/tests',
    '-p',
    'test_rl*.py',
    '-v',
  ],
  {
    env: { ...process.env, AIIDE_REAL_RL: '1' },
    timeout: 600000,
    maxBuffer: 4 * 1024 * 1024,
  },
);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
