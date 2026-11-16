const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ReinforcementLearning } = require('../lib/rl');
const { saveProject } = require('../lib/project');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-rl-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  saveProject(root, {
    version: 1,
    name: 'RL',
    environment: { python: 'python3' },
  });
  const started = [];
  const runs = {
    start: async (...args) => (started.push(args), { id: 'run' }),
  };
  return {
    root,
    started,
    rl: new ReinforcementLearning(
      root,
      runs,
      path.resolve(__dirname, '../../..'),
    ),
  };
}

test('RL validates bounded jobs and records cancellable run configuration', async (t) => {
  const { rl, started } = setup(t);
  await rl.train({ episodes: 1000 });
  const [name, training, env, builtin] = started[0];
  assert.equal(name, 'RL · gridworld');
  assert.equal(training.target, 'local');
  assert.equal(training.parameters.workflow, 'rl');
  assert.equal(training.parameters.episodes, 1000);
  assert.deepEqual(builtin.command,['python','-m','aiide_rl','train']);
  assert.match(env.AIIDE_RL_OUTPUT, /^rl-policies\/[a-f0-9-]+$/);
  assert.equal(JSON.parse(env.AIIDE_RL_CONFIG).seed, 42);
  assert.throws(
    () => rl.train({ episodes: 20000, maxSteps: 500 }),
    /two million/,
  );
  assert.throws(() => rl.train({ learningRate: NaN }));
  assert.throws(() => rl.train({ command: 'execute' }));
  await rl.train({ environment: 'FrozenLake-v1' });
  assert.equal(started[1][1].parameters.environment, 'FrozenLake-v1');
});

test('advanced RL validates continuous actions, seed budgets and resume paths', async (t) => {
  const { rl, started } = setup(t);
  await rl.train({
    algorithm: 'ppo',
    environment: 'CartPole-v1',
    timesteps: 256,
    workers: 2,
    seeds: [42, 43],
  });
  assert.equal(started[0][1].parameters.algorithm, 'ppo');
  assert.equal(started[0][1].parameters.workers, 2);
  assert.throws(
    () => rl.train({ algorithm: 'sac', environment: 'CartPole-v1' }),
    /continuous/,
  );
  assert.throws(
    () =>
      rl.train({ algorithm: 'ppo', environment: 'CartPole-v1', seeds: [1, 1] }),
    /distinct/,
  );
  assert.throws(
    () =>
      rl.train({
        algorithm: 'ppo',
        environment: 'CartPole-v1',
        timesteps: 2000000,
        seeds: [1, 2],
      }),
    /two million/,
  );
  assert.throws(() =>
    rl.train({
      algorithm: 'ppo',
      environment: 'CartPole-v1',
      resume: '../model.zip',
    }),
  );
});

test('RL rejects path escapes and symlinked policies and output directories', (t) => {
  const { root, rl } = setup(t);
  assert.throws(() => rl.rollout({ policy: '../etc/passwd' }));
  fs.symlinkSync(os.tmpdir(), path.join(root, 'rl-policies'));
  assert.throws(() => rl.train({}), /Symbolic links/);
  assert.throws(() => rl.policies(), /Symbolic links/);
});

test('RL lists only bounded validated summaries, excluding Q tables', (t) => {
  const { root, rl } = setup(t);
  const directory = path.join(root, 'rl-policies', 'trained');
  fs.mkdirSync(directory, { recursive: true });
  const policy = {
    format: 'aiide-rl-v1',
    environment: 'gridworld',
    created: 5,
    config: rl.catalog().defaults,
    q: [[1, 2, 3, 4]],
    baseline: {
      meanReward: -1,
      successRate: 0.1,
      meanSteps: 100,
      episodes: 100,
    },
    evaluation: {
      meanReward: 0.9,
      successRate: 1,
      meanSteps: 8,
      episodes: 100,
    },
  };
  fs.writeFileSync(path.join(directory, 'policy.json'), JSON.stringify(policy));
  fs.mkdirSync(path.join(root, 'rl-policies', 'broken'));
  fs.writeFileSync(
    path.join(root, 'rl-policies', 'broken', 'policy.json'),
    '{',
  );
  const summaries = rl.policies();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].path, 'rl-policies/trained');
  assert.equal(summaries[0].q, undefined);
  fs.unlinkSync(path.join(directory, 'policy.json'));
  fs.symlinkSync('/etc/hosts', path.join(directory, 'policy.json'));
  assert.deepEqual(rl.policies(), []);
  assert.throws(
    () => rl.rollout({ policy: 'rl-policies/trained' }),
    /Symbolic links/,
  );
});
