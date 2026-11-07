import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import core from '../packages/core/lib/index.js';
const { Workspace, saveProject } = core;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-training-'));
const remoteRoot = path.join(root, 'remote');
const localRoot = path.join(root, 'local');
const container = 'aiide-training-' + process.pid;
let workspace, remoteWorkspace;
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const waitRun = async (workspace, id, terminal = true) => {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const record = workspace.store.run(id);
    if (record.training?.profile) await workspace.training.sync(id);
    if (!terminal || workspace.store.run(id).status !== 'running')
      return workspace.store.run(id);
    await delay(200);
  }
  throw new Error('Training did not finish in 60 seconds');
};
const waitEvents = async (workspace, id, name) => {
  for (let i = 0; i < 100; i++) {
    if (workspace.store.events(id).some((e) => e.name === name)) return;
    await delay(100);
  }
  throw new Error('Missing event: ' + name);
};
try {
  fs.mkdirSync(localRoot);
  fs.mkdirSync(remoteRoot, { mode: 0o777 });
  fs.chmodSync(remoteRoot, 0o777);
  const python =
    process.env.AIIDE_TRAIN_TEST_PYTHON ||
    path.resolve('templates/finetune/.venv/bin/python');
  assert.ok(
    fs.existsSync(python),
    'Install locked finetune dependencies first, or set AIIDE_TRAIN_TEST_PYTHON',
  );
  fs.copyFileSync('templates/pytorch/main.py', path.join(localRoot, 'main.py'));
  saveProject(localRoot, {
    version: 1,
    name: 'CPU training validation',
    environment: { python },
    commands: { train: ['python', 'main.py'] },
    training: { framework: 'pytorch', resume: true },
  });
  workspace = await Workspace.open(localRoot);
  const first = await workspace.operation('training.start', {
    name: 'train',
    target: 'local',
    parameters: { steps: 10, checkpoint_every: 10 },
  });
  assert.equal((await waitRun(workspace, first.id)).status, 'completed');
  await waitEvents(workspace, first.id, 'checkpoint');
  const losses = workspace.store
    .metricSeries(first.id)
    .filter((m) => m.name === 'loss');
  assert.equal(losses.length, 10);
  assert.ok(losses.at(-1).value < losses[0].value);
  const checkpoint = await workspace.operation('training.artifact', {
    id: first.id,
    path: 'checkpoints/step-10',
  });
  assert.equal(checkpoint.resumable, true);
  assert.equal(checkpoint.step, 10);
  const resumed = await workspace.operation('training.start', {
    name: 'train',
    target: 'local',
    parameters: { steps: 14, checkpoint_every: 2 },
    resumeFrom: { runId: first.id, path: 'checkpoints/step-10' },
  });
  assert.equal((await waitRun(workspace, resumed.id)).status, 'completed');
  await waitEvents(workspace, resumed.id, 'checkpoint');
  assert.equal(
    workspace.store.metricSeries(resumed.id).filter((m) => m.name === 'loss')[0]
      .step,
    11,
  );
  assert.equal(
    (
      await workspace.operation('training.artifact', {
        id: resumed.id,
        path: 'checkpoints/step-14',
      })
    ).resumable,
    true,
  );
  console.log(
    'PASS: real PyTorch loss/gradient metrics, artifact inspection, and model/optimizer checkpoint resume',
  );
  fs.copyFileSync(
    'scripts/fixtures/trainer-test.py',
    path.join(localRoot, 'trainer.py'),
  );
  saveProject(localRoot, {
    version: 1,
    name: 'Trainer validation',
    environment: { python },
    commands: { trainer: ['python', 'trainer.py'] },
    training: { framework: 'transformers', resume: true },
  });
  const hf = await workspace.operation('training.start', {
    name: 'trainer',
    target: 'local',
    parameters: { steps: 2 },
  });
  assert.equal((await waitRun(workspace, hf.id)).status, 'completed');
  await waitEvents(workspace, hf.id, 'checkpoint');
  assert.equal(
    (
      await workspace.operation('training.artifact', {
        id: hf.id,
        path: 'hf-checkpoints/checkpoint-2',
      })
    ).resumable,
    true,
  );
  const hfResume = await workspace.operation('training.start', {
    name: 'trainer',
    target: 'local',
    parameters: { steps: 4 },
    resumeFrom: { runId: hf.id, path: 'hf-checkpoints/checkpoint-2' },
  });
  assert.equal((await waitRun(workspace, hfResume.id)).status, 'completed');
  await waitEvents(workspace, hfResume.id, 'checkpoint');
  assert.equal(
    (
      await workspace.operation('training.artifact', {
        id: hfResume.id,
        path: 'hf-checkpoints/checkpoint-4',
      })
    ).step,
    4,
  );
  console.log(
    'PASS: real Transformers Trainer callback, checkpoint validation, and resumed training',
  );

  const modelPath = path.join(localRoot, 'tiny-model');
  run(python, ['scripts/fixtures/make-tiny-model.py', modelPath]);
  fs.copyFileSync(
    'templates/finetune/main.py',
    path.join(localRoot, 'finetune.py'),
  );
  saveProject(localRoot, {
    version: 1,
    name: 'PEFT validation',
    environment: { python },
    commands: { finetune: ['python', 'finetune.py'] },
    training: { framework: 'transformers', resume: true },
    telemetry: { captureContent: true },
  });
  const peft = await workspace.operation('training.start', {
    name: 'finetune',
    target: 'local',
    modelPath,
    datasetPath: path.join(modelPath, 'data.jsonl'),
    parameters: { steps: 2, save_steps: 2 },
  });
  assert.equal((await waitRun(workspace, peft.id)).status, 'completed');
  await waitEvents(workspace, peft.id, 'checkpoint');
  assert.equal(
    (
      await workspace.operation('training.artifact', {
        id: peft.id,
        path: 'checkpoints/checkpoint-2',
      })
    ).resumable,
    true,
  );
  const peftResume = await workspace.operation('training.start', {
    name: 'finetune',
    target: 'local',
    modelPath,
    datasetPath: path.join(modelPath, 'data.jsonl'),
    parameters: { steps: 4, save_steps: 2 },
    resumeFrom: { runId: peft.id, path: 'checkpoints/checkpoint-2' },
  });
  assert.equal((await waitRun(workspace, peftResume.id)).status, 'completed');
  await waitEvents(workspace, peftResume.id, 'checkpoint');
  assert.equal(
    (
      await workspace.operation('training.artifact', {
        id: peftResume.id,
        path: 'checkpoints/checkpoint-4',
      })
    ).step,
    4,
  );
  console.log(
    'PASS: actual PEFT template with local model/data, adapter checkpoint, and resumed fine-tuning',
  );

  run('ssh-keygen', [
    '-t',
    'ed25519',
    '-N',
    '',
    '-f',
    path.join(root, 'id_ed25519'),
  ]);
  fs.copyFileSync(
    path.join(root, 'id_ed25519.pub'),
    path.join(root, 'authorized_keys'),
  );
  fs.copyFileSync(
    'scripts/fixtures/ssh.Dockerfile',
    path.join(root, 'Dockerfile'),
  );
  run('docker', ['build', '-t', container, root], { timeout: 180000 });
  run('docker', [
    'run',
    '-d',
    '--name',
    container,
    '-p',
    '127.0.0.1::22',
    '--mount',
    `type=bind,src=${remoteRoot},dst=/project`,
    container,
  ]);
  const port = Number(
    run('docker', ['port', container, '22/tcp']).trim().split(':').pop(),
  );
  const hostKey = run('docker', [
    'exec',
    container,
    'cat',
    '/etc/ssh/ssh_host_ed25519_key.pub',
  ]).trim();
  fs.writeFileSync(
    path.join(root, 'known_hosts'),
    `[127.0.0.1]:${port} ${hostKey}\n`,
  );
  fs.copyFileSync(
    'scripts/fixtures/remote-train.py',
    path.join(remoteRoot, 'train.py'),
  );
  const controlRoot = path.join(root, 'control');
  fs.mkdirSync(controlRoot);
  saveProject(controlRoot, {
    version: 1,
    name: 'Remote training validation',
    commands: { train: ['python', 'train.py'] },
    training: { framework: 'custom' },
  });
  remoteWorkspace = await Workspace.open(controlRoot);
  const profile = {
    id: 'fixture',
    host: '127.0.0.1',
    user: 'trainer',
    port,
    root: '/project',
    python: '/usr/local/bin/python',
    identityFile: path.join(root, 'id_ed25519'),
    knownHostsFile: path.join(root, 'known_hosts'),
  };
  remoteWorkspace.training.ssh.save(profile);
  const probe = await remoteWorkspace.operation('ssh.probe', { id: 'fixture' });
  assert.equal(probe.platform, 'linux');
  assert.equal(probe.gpuStatus, 'unavailable');
  assert.equal(probe.writable, true);
  const job = await remoteWorkspace.operation('training.start', {
    name: 'train',
    target: 'ssh',
    profile: 'fixture',
    parameters: { steps: 40, delay: 0.2 },
  });
  assert.equal(job.training.connection, 'connected');
  // Stop only the SSH listener. The independently supervised training process keeps running.
  run('docker', [
    'exec',
    container,
    'sh',
    '-c',
    'kill -STOP "$(cat /run/sshd.pid)"',
  ]);
  await remoteWorkspace.training.sync(job.id);
  assert.equal(
    remoteWorkspace.store.run(job.id).training.connection,
    'disconnected',
  );
  await remoteWorkspace.close();
  remoteWorkspace = undefined;
  await delay(1500);
  run('docker', [
    'exec',
    container,
    'sh',
    '-c',
    'kill -CONT "$(cat /run/sshd.pid)"',
  ]);
  remoteWorkspace = await Workspace.open(controlRoot);
  assert.equal(
    remoteWorkspace.store.run(job.id).status,
    'running',
    'Restart must not mark remote jobs interrupted',
  );
  assert.equal((await waitRun(remoteWorkspace, job.id)).status, 'completed');
  const history = remoteWorkspace.store
    .metricSeries(job.id)
    .filter((m) => m.name === 'loss');
  assert.equal(history.length, 40);
  assert.equal(new Set(history.map((m) => m.step)).size, 40);
  await remoteWorkspace.training.sync(job.id);
  assert.equal(
    remoteWorkspace.store.metricSeries(job.id).filter((m) => m.name === 'loss')
      .length,
    40,
    'Replay must be idempotent',
  );
  const downloaded = await remoteWorkspace.operation('training.download', {
    id: job.id,
    path: 'result.json',
  });
  assert.ok(JSON.parse(fs.readFileSync(downloaded.path, 'utf8')).weight > 2.9);
  const long = await remoteWorkspace.operation('training.start', {
    name: 'train',
    target: 'ssh',
    profile: 'fixture',
    parameters: { steps: 1000, delay: 0.2 },
  });
  await delay(500);
  await remoteWorkspace.operation('training.cancel', { id: long.id });
  assert.equal((await waitRun(remoteWorkspace, long.id)).status, 'cancelled');
  console.log(
    'PASS: actual Linux SSH job, connection loss, IDE restart, exactly-once metric replay, artifact download, and cancellation',
  );
} catch (error) {
  if (workspace)
    console.error(
      workspace.store.runs().map((r) => ({
        id: r.id,
        status: r.status,
        logs: workspace.store.events(r.id, 'log'),
      })),
    );
  throw error;
} finally {
  if (remoteWorkspace) await remoteWorkspace.close();
  if (workspace) await workspace.close();
  try {
    run('docker', ['rm', '-f', container]);
  } catch {}
  try {
    run('docker', ['image', 'rm', container]);
  } catch {}
  if (process.env.AIIDE_KEEP_TEST_DATA) console.log('Test data:', root);
  else fs.rmSync(root, { recursive: true, force: true });
}
