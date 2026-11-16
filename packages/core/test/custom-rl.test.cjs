const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ReinforcementLearning } = require('../lib/rl');
const { saveProject } = require('../lib/project');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-custom-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  saveProject(root, {
    version: 1,
    name: 'custom environment',
    environment: { python: 'python3' },
  });
  const source =
    "from pathlib import Path\nPath('must-not-run').write_text('executed')\ndef make_env(parameters):\n return None\n";
  fs.writeFileSync(path.join(root, 'custom.py'), source);
  const started = [];
  const rl = new ReinforcementLearning(
    root,
    {
      start: async (...args) => {
        started.push(args);
        return { id: 'run' };
      },
    },
    path.resolve(__dirname, '../../..'),
  );
  const definition = {
    id: 'custom',
    title: 'Reviewed custom',
    entrypoint: 'custom.py',
    factory: 'make_env',
    files: ['custom.py'],
    parameters: { target: 0.5 },
  };
  return { root, source, definition, rl, started };
}

test('custom environment review/registration never imports Python and training uses only the reviewed revision', async (t) => {
  const { root, source, definition, rl, started } = setup(t);
  const preview = rl.previewEnvironment(definition);
  assert.equal(preview.sources[0].content, source);
  assert.equal(fs.existsSync(path.join(root, 'must-not-run')), false);
  assert.throws(() =>
    rl.registerEnvironment({
      ...definition,
      reviewHash: preview.reviewHash,
      confirmed: false,
    }),
  );
  rl.registerEnvironment({
    ...definition,
    reviewHash: preview.reviewHash,
    confirmed: true,
  });
  assert.equal(rl.environments()[0].ready, true);
  await rl.train({
    algorithm: 'ppo',
    environment: 'custom:custom',
    timesteps: 64,
  });
  const config = JSON.parse(started[0][2].AIIDE_RL_CONFIG);
  assert.equal(config.customEnvironment.revision, preview.reviewHash);
  assert.equal(fs.existsSync(path.join(root, 'must-not-run')), false);
  assert.throws(
    () =>
      rl.train({
        algorithm: 'ppo',
        environment: 'CartPole-v1',
        customEnvironment: preview.definition,
      }),
    /descriptors/,
  );
  fs.appendFileSync(path.join(root, 'custom.py'), '# changed\n');
  assert.equal(rl.environments()[0].ready, false);
  assert.throws(
    () => rl.train({ algorithm: 'ppo', environment: 'custom:custom' }),
    /changed/,
  );
  assert.throws(
    () =>
      rl.registerEnvironment({
        ...definition,
        reviewHash: preview.reviewHash,
        confirmed: true,
      }),
    /changed/,
  );
});

test('custom source review rejects symlinks, FIFOs, escapes and unsafe parameter data', (t) => {
  const { root, definition, rl } = setup(t);
  fs.symlinkSync(path.join(root, 'custom.py'), path.join(root, 'link.py'));
  assert.throws(
    () =>
      rl.previewEnvironment({
        ...definition,
        entrypoint: 'link.py',
        files: ['link.py'],
      }),
    /Symbolic/,
  );
  assert.throws(() =>
    rl.previewEnvironment({
      ...definition,
      entrypoint: '../escape.py',
      files: ['../escape.py'],
    }),
  );
  assert.throws(
    () => rl.previewEnvironment({ ...definition, parameters: { target: NaN } }),
    /finite JSON/,
  );
  assert.throws(
    () =>
      rl.previewEnvironment({
        ...definition,
        parameters: { target: undefined },
      }),
    /finite JSON/,
  );
  if (process.platform !== 'win32') {
    execFileSync('mkfifo', [path.join(root, 'pipe.py')]);
    execFileSync(
      process.execPath,
      [
        '-e',
        `const assert=require('node:assert/strict');const{RLEnvironments}=require(process.argv[1]);const environment=new RLEnvironments(process.argv[2]);assert.throws(()=>environment.preview(JSON.parse(process.argv[3])),/regular/);`,
        require.resolve('../lib/rl-environments'),
        root,
        JSON.stringify({
          ...definition,
          entrypoint: 'pipe.py',
          files: ['pipe.py'],
        }),
      ],
      { timeout: 3000 },
    );
  }
});

test('custom policy inspection cannot substitute an unreviewed factory descriptor', (t) => {
  const { root, definition, rl } = setup(t);
  const preview = rl.previewEnvironment(definition);
  rl.registerEnvironment({
    ...definition,
    reviewHash: preview.reviewHash,
    confirmed: true,
  });
  const folder = path.join(root, 'rl-policies/policy');
  fs.mkdirSync(folder, { recursive: true });
  const policy = {
    config: {
      environment: 'custom:custom',
      customEnvironment: { ...preview.definition, factory: 'other' },
    },
  };
  fs.writeFileSync(path.join(folder, 'policy.json'), JSON.stringify(policy));
  assert.equal(rl.isCustomPolicy('rl-policies/policy'), true);
  assert.throws(
    () => rl.train({ algorithm: 'ppo', environment: 'custom:custom' }, false),
    /explicitly/,
  );
  assert.throws(
    () => rl.rollout({ policy: 'rl-policies/policy' }, false),
    /explicitly/,
  );
  assert.throws(() => rl.rollout({ policy: 'rl-policies/policy' }), /differs/);
});

test(
  'closing RL aborts and awaits active checker/rollout helpers',
  { skip: process.platform === 'win32', timeout: 10000 },
  async (t) => {
    const { root, definition, rl } = setup(t);
    const preview = rl.previewEnvironment(definition);
    rl.registerEnvironment({
      ...definition,
      reviewHash: preview.reviewHash,
      confirmed: true,
    });
    const assets = path.join(root, 'resources'),
      helper = path.join(assets, 'python/aiide_rl');
    fs.mkdirSync(helper, { recursive: true });
    fs.writeFileSync(path.join(helper, '__init__.py'), '');
    fs.mkdirSync(path.join(assets, 'python/aiide_runtime'), {
      recursive: true,
    });
    fs.copyFileSync(
      path.resolve(__dirname, '../../../python/aiide_runtime/launch.py'),
      path.join(assets, 'python/aiide_runtime/launch.py'),
    );
    fs.writeFileSync(
      path.join(helper, '__main__.py'),
      "import os,json,sys,time\nfrom pathlib import Path\nr=json.load(sys.stdin)\nPath(r['root'],sys.argv[1]+'.pid').write_text(str(os.getpid()))\ntime.sleep(60)\n",
    );
    const service = new ReinforcementLearning(root, {}, assets);
    t.after(() => service.close());
    const folder = path.join(root, 'rl-policies/policy');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, 'policy.json'),
      JSON.stringify({ config: { environment: 'gridworld' } }),
    );
    const checker = assert.rejects(
      service.checkEnvironment({ id: 'custom' }),
      /cancelled/,
    );
    const rollout = assert.rejects(
      service.rollout({ policy: 'rl-policies/policy' }),
      /cancelled/,
    );
    for (
      let i = 0;
      i < 100 &&
      !['check-environment', 'rollout'].every((mode) =>
        fs.existsSync(path.join(root, mode + '.pid')),
      );
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    const pids = ['check-environment', 'rollout'].map((mode) =>
      Number(fs.readFileSync(path.join(root, mode + '.pid'), 'utf8')),
    );
    await service.close();
    await Promise.all([checker, rollout]);
    for (const pid of pids)
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    await assert.rejects(service.status(), /closed/);
    assert.throws(
      () => service.train({ algorithm: 'ppo', environment: 'CartPole-v1' }),
      /closed/,
    );
  },
);
