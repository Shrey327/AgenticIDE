const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { VoiceAgents } = require('../lib/voice');
const { Connections } = require('../lib/models');
const { saveProject } = require('../lib/project');

async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-voice-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  saveProject(root, {
    version: 1,
    name: 'Voice tests',
    environment: { python: 'python3' },
  });
  const secrets = new Map();
  const connections = new Connections(path.join(root, '.aiide'), {
    get: async (key) => secrets.get(key),
    set: async (key, value) => {
      secrets.set(key, value);
    },
  });
  await connections.save(
    {
      id: 'chat',
      kind: 'model',
      model: 'fixture',
      url: 'http://127.0.0.1:4000/v1',
    },
    'provider-chat-secret',
  );
  await connections.save(
    { id: 'speech', kind: 'model', url: 'http://127.0.0.1:4001/v1' },
    'provider-speech-secret',
  );
  const started = [],
    records = new Map();
  const runs = {
    store: {
      runs: () => [...records.values()],
      run: (id) => records.get(id),
      saveRun: (run) => records.set(run.id, run),
    },
    start: async (...args) => {
      started.push(args);
      const run = { id: 'worker', status: 'running', configuration: {} };
      records.set(run.id, run);
      if (args[2].AIIDE_VOICE_HEALTH_PORT) {
        const server = http.createServer((_req, res) => res.end('OK'));
        await new Promise((resolve) =>
          server.listen(
            Number(args[2].AIIDE_VOICE_HEALTH_PORT),
            '127.0.0.1',
            resolve,
          ),
        );
        t.after(async () => {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
        });
      }
      return run;
    },
    cancel: (id) => {
      records.get(id).status = 'cancelled';
    },
  };
  const voice = new VoiceAgents(
    root,
    runs,
    connections,
    path.resolve(__dirname, '../../..'),
  );
  t.after(() => voice.close());
  const profile = {
    id: 'local',
    url: 'ws://127.0.0.1:7880',
    apiKey: 'devkey',
    chatConnection: 'chat',
    speechConnection: 'speech',
    instructions: 'Reply briefly.',
  };
  return { root, voice, profile, started, runs, secrets };
}

test('voice credentials stay in vault and changes never reuse another origin credential', async (t) => {
  const { root, voice, profile } = await setup(t);
  await voice.save({ profile, secret: 'livekit-secret' });
  const json = fs.readFileSync(
    path.join(root, '.aiide/voice/profiles.json'),
    'utf8',
  );
  assert.ok(!json.includes('livekit-secret'));
  assert.ok(!json.includes('provider-chat-secret'));
  assert.equal(voice.profiles()[0].credentialRef, undefined);
  await voice.save({ profile: { ...profile, instructions: 'Updated prompt' } });
  await assert.rejects(
    voice.save({ profile: { ...profile, url: 'wss://other.example' } }),
    /Provide/,
  );
  await assert.rejects(
    voice.save({
      profile: { ...profile, url: 'ws://unsafe.example' },
      secret: 'x',
    }),
    /wss/,
  );
  await assert.rejects(
    voice.save({
      profile: { ...profile, url: 'wss://user:password@example.org' },
      secret: 'x',
    }),
    /wss/,
  );
  assert.equal(voice.profiles()[0].instructions, 'Updated prompt');
});

test('read-only voice status cannot import a workspace-shadowed runtime module', async (t) => {
  const { root, voice } = await setup(t);
  const marker = path.join(root, 'workspace-module-executed');
  fs.mkdirSync(path.join(root, 'aiide_voice'));
  fs.writeFileSync(path.join(root, 'aiide_voice/__init__.py'), '');
  fs.writeFileSync(
    path.join(root, 'aiide_voice/__main__.py'),
    `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('untrusted workspace module')\nprint('{"ok":true,"result":{"shadowed":true}}')\n`,
  );
  const previous = process.cwd();
  try {
    process.chdir(root);
    const result = await voice.status();
    assert.equal(typeof result.ready, 'boolean');
    assert.equal(result.shadowed, undefined);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    process.chdir(previous);
  }
});

test('voice worker uses existing cancellable run lifecycle without persisting secrets in metadata', async (t) => {
  const { voice, profile, started, runs } = await setup(t);
  await voice.save({ profile, secret: 'livekit-secret' });
  await voice.start({ id: profile.id, mode: 'start' });
  const [name, training, environment, builtin] = started[0];
  assert.match(name, /Voice/);
  assert.equal(training.parameters.workflow, 'voice');
  assert.deepEqual(builtin.command, ['python', '-m', 'aiide_voice', 'start']);
  assert.equal(environment.LIVEKIT_API_SECRET, 'livekit-secret');
  assert.equal(environment.AIIDE_VOICE_CHAT_KEY, 'provider-chat-secret');
  assert.equal(environment.AIIDE_VOICE_SPEECH_KEY, 'provider-speech-secret');
  assert.ok(!JSON.stringify(training).includes('secret'));
  assert.ok(!environment.AIIDE_VOICE_CONFIG.includes('secret'));
  runs.store.runs = () => [
    { status: 'running', training: { parameters: { workflow: 'voice' } } },
  ];
  await assert.rejects(voice.start({ id: profile.id }), /already running/);
  await assert.rejects(voice.start({ id: profile.id, mode: 'shell' }));
});

test('voice room tokens have verifiable signature, expiry and only one participant room grant', async (t) => {
  const { voice, profile } = await setup(t);
  await voice.save({ profile, secret: 'livekit-secret' });
  const grant = await voice.token({
    id: profile.id,
    room: 'project-room',
    identity: 'developer',
  });
  const [header, payload, signature] = grant.token.split('.');
  assert.equal(
    signature,
    crypto
      .createHmac('sha256', 'livekit-secret')
      .update(`${header}.${payload}`)
      .digest('base64url'),
  );
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(claims.sub, 'developer');
  assert.equal(claims.video.room, 'project-room');
  assert.equal(claims.video.roomAdmin, undefined);
  assert.equal(claims.video.roomCreate, undefined);
  assert.equal(claims.roomConfig.agents[0].agentName, 'aiide-voice');
  assert.ok(claims.exp - Math.floor(Date.now() / 1000) <= 900);
  await assert.rejects(
    voice.token({ id: profile.id, room: '../other', identity: 'developer' }),
  );
});

test('voice profile storage rejects a symlink before reading or writing', async (t) => {
  const { root, voice, profile } = await setup(t);
  fs.mkdirSync(path.join(root, '.aiide/voice'));
  fs.symlinkSync(os.tmpdir(), path.join(root, '.aiide/voice/profiles.json'));
  assert.throws(() => voice.profiles(), /Symbolic/);
  await assert.rejects(voice.save({ profile, secret: 'x' }), /Symbolic/);
});

test('voice cleanup removes only owned stopped local services and preserves user connections', async (t) => {
  const { voice, runs, root } = await setup(t);
  const connections = voice.connections;
  const owned = await connections.save(
    {
      id: 'local-speech-owned',
      kind: 'model',
      url: 'http://127.0.0.1:54321/v1',
    },
    'service-token',
  );
  await connections.save(
    { id: 'local-speech', kind: 'model', url: 'http://127.0.0.1:54322/v1' },
    'user-token',
  );
  let recorded = {
    id: 'service',
    status: 'cancelled',
    configuration: {
      localSpeech: {
        connection: owned.id,
        url: owned.url,
        credentialRef: owned.credentialRef,
      },
    },
  };
  runs.store.runs = () => [recorded];
  runs.store.saveRun = (value) => {
    recorded = value;
  };
  voice.cleanup();
  assert.ok(
    !connections.list().some((connection) => connection.id === owned.id),
  );
  assert.ok(
    connections.list().some((connection) => connection.id === 'local-speech'),
  );
  assert.equal(recorded.configuration.localSpeech.removed, true);
  const changed = await connections.save(
    { id: owned.id, kind: 'model', url: 'http://127.0.0.1:54323/v1' },
    'new-owner-token',
  );
  recorded.configuration.localSpeech.removed = false;
  voice.cleanup();
  assert.equal(connections.get(changed.id).url, changed.url);
});

test('cancelling local speech during vault registration cannot resurrect a run or retain its endpoint', async (t) => {
  const { root, voice, runs } = await setup(t);
  fs.writeFileSync(path.join(root, 'model.bin'), 'model fixture');
  fs.writeFileSync(path.join(root, 'whisper-cli'), 'executable fixture');
  let record, release, registering;
  const registered = new Promise((resolve) => {
    registering = resolve;
  });
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  voice.connections.vault.set = async () => {
    registering();
    await barrier;
  };
  runs.store.runs = () => (record ? [record] : []);
  runs.store.run = () => record;
  runs.store.saveRun = (next) => {
    record = next;
  };
  runs.start = async (_name, _training, _env, builtin) => {
    const port = Number(builtin.command[builtin.command.indexOf('--port') + 1]);
    const server = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end('{"ready":true}');
    });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    record = { id: 'service-fixture', status: 'running', configuration: {} };
    return record;
  };
  const launch = voice.localStart({
    engine: 'whisper.cpp',
    model: 'model.bin',
    executable: 'whisper-cli',
  });
  await registered;
  record = { ...record, status: 'cancelled' };
  release();
  await assert.rejects(launch, /stopped during connection registration/);
  assert.equal(record.status, 'cancelled');
  assert.ok(
    !voice.connections
      .list()
      .some((connection) => connection.id.startsWith('local-speech-')),
  );
});
