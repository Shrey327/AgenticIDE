import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { build } from 'esbuild';
import puppeteer from 'puppeteer';
import core from '../packages/core/lib/index.js';

const execute = promisify(execFile);
const python = process.env.AIIDE_VOICE_TEST_PYTHON;
const modelPath = process.env.AIIDE_VOICE_TEST_MODEL;
const whisperExecutable = process.env.AIIDE_VOICE_TEST_EXECUTABLE;
const faultScenarios =
  process.env.AIIDE_VOICE_TEST_FAULTS === '1' ||
  process.argv.includes('--faults');
assert.ok(
  !faultScenarios || !process.env.AIIDE_VOICE_TEST_CHAT_URL,
  'Fault injection requires the disposable local chat fixture',
);
const engine =
  process.env.AIIDE_VOICE_TEST_ENGINE ||
  (whisperExecutable ? 'whisper.cpp' : 'mlx');
assert.ok(
  python && modelPath,
  'Set AIIDE_VOICE_TEST_PYTHON (LiveKit environment), AIIDE_VOICE_TEST_MODEL and optionally AIIDE_VOICE_TEST_EXECUTABLE for whisper.cpp.',
);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-real-voice-'));
const container = 'aiide-voice-' + crypto.randomUUID().slice(0, 8);
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
const [port, tcp, udp] = await Promise.all([
  freePort(),
  freePort(),
  freePort(),
]);
let workspace, browser, modelServer, frontend;
const requests = [];
let injectedTransientFailure = false;
try {
  fs.writeFileSync(
    path.join(root, 'livekit.yaml'),
    `port: ${port}\nrtc:\n  tcp_port: ${tcp}\n  udp_port: ${udp}\n  use_external_ip: false\nkeys:\n  devkey: secret\nlogging:\n  level: warn\n`,
  );
  await execute(
    'docker',
    [
      'run',
      '--rm',
      '--pull=never',
      '-d',
      '--name',
      container,
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--memory=512m',
      '--cpus=2',
      '-p',
      `127.0.0.1:${port}:${port}`,
      '-p',
      `127.0.0.1:${tcp}:${tcp}`,
      '-p',
      `127.0.0.1:${udp}:${udp}/udp`,
      '-v',
      `${path.join(root, 'livekit.yaml')}:/etc/livekit.yaml:ro`,
      'livekit/livekit-server:v1.9.11',
      '--config',
      '/etc/livekit.yaml',
      '--bind',
      '0.0.0.0',
      '--node-ip',
      '127.0.0.1',
    ],
    { timeout: 30000 },
  );
  core.saveProject(root, {
    version: 1,
    name: 'Real voice acceptance',
    environment: { python },
    telemetry: { captureContent: true },
  });
  fs.cpSync(modelPath, path.join(root, 'model'), { recursive: true });
  if (engine === 'whisper.cpp') {
    assert.ok(
      whisperExecutable,
      'Set AIIDE_VOICE_TEST_EXECUTABLE to a standalone whisper-cli binary',
    );
    fs.copyFileSync(whisperExecutable, path.join(root, 'whisper-cli'));
    fs.chmodSync(path.join(root, 'whisper-cli'), 0o755);
  }
  workspace = await core.Workspace.open(root);
  const secrets = new Map();
  workspace.connections.vault = {
    get: async (key) => secrets.get(key),
    set: async (key, value) => {
      secrets.set(key, value);
    },
  };
  modelServer = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'fixture', object: 'model' }],
        }),
      );
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    let request;
    try {
      request = JSON.parse(body);
    } catch {
      res.writeHead(400).end('Invalid model request');
      return;
    }
    requests.push(request);
    const userMessages =
      request.messages
        ?.filter((message) => message.role === 'user')
        .map((message) => JSON.stringify(message.content).toLowerCase())
        .join(' ') || '';
    if (
      faultScenarios &&
      (userMessages.includes('force provider failure') ||
        (!injectedTransientFailure && userMessages.includes('weather')))
    ) {
      injectedTransientFailure = true;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: 'Simulated local provider outage' },
        }),
      );
      return;
    }
    const text = 'The weather is sunny today.';
    if (request.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'fixture',
            object: 'chat.completion.chunk',
            model: 'fixture',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: text },
                finish_reason: null,
              },
            ],
          }) +
          '\n\n',
      );
      res.end(
        'data: ' +
          JSON.stringify({
            id: 'fixture',
            object: 'chat.completion.chunk',
            model: 'fixture',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 6,
              total_tokens: 16,
            },
          }) +
          '\n\ndata: [DONE]\n\n',
      );
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: text } }],
        }),
      );
    }
  });
  await new Promise((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
  await workspace.connections.save({
    id: 'local-chat',
    kind: 'model',
    model: process.env.AIIDE_VOICE_TEST_CHAT_MODEL || 'fixture',
    url:
      process.env.AIIDE_VOICE_TEST_CHAT_URL ||
      `http://127.0.0.1:${modelServer.address().port}/v1`,
  });
  const local = await workspace.operation('voice.localStart', {
    engine,
    model: 'model',
    ...(engine === 'whisper.cpp' ? { executable: 'whisper-cli' } : {}),
  });
  console.log('Voice acceptance: local speech service ready');
  await workspace.operation('voice.save', {
    profile: {
      id: 'voice-agent',
      url: `ws://127.0.0.1:${port}`,
      apiKey: 'devkey',
      chatConnection: 'local-chat',
      speechConnection: local.connection.id,
      instructions: 'You are a helpful voice agent. Reply briefly and clearly.',
    },
    secret: 'secret',
  });
  const worker = await workspace.operation('voice.start', {
    id: 'voice-agent',
    mode: 'start',
  });
  console.log('Voice acceptance: production worker registered');
  await execute(
    python,
    [
      '-c',
      `import sys,wave,tempfile;sys.path.insert(0,${JSON.stringify(path.resolve('python'))});from aiide_voice.local_speech import speak
with tempfile.TemporaryDirectory() as directory: pcm=speak('The weather is sunny today.',directory)
with wave.open(${JSON.stringify(path.join(root, 'microphone.wav'))},'wb') as output:
 output.setnchannels(1);output.setsampwidth(2);output.setframerate(24000);output.writeframes(bytes(48000)+pcm+bytes(96000))`,
    ],
    { timeout: 30000 },
  );
  const bundle = await build({
    stdin: {
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {VoicePanel} from './packages/theia-extension/src/browser/voice-panel.tsx';createRoot(document.getElementById('root')).render(<VoicePanel connections={${JSON.stringify(workspace.connections.list())}} call={(operation,args)=>window.apiCall(operation,args)} />);`,
      resolveDir: process.cwd(),
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    platform: 'browser',
    alias: { '@theia/core/shared/react': 'react' },
  });
  frontend = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<main id="root"></main>');
  });
  await new Promise((resolve) => frontend.listen(0, '127.0.0.1', resolve));
  browser = await puppeteer.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: [
      '--no-sandbox',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${path.join(root, 'microphone.wav')}%noloop`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await browser.newPage();
  if (faultScenarios)
    await page.evaluateOnNewDocument(() => {
      const NativeWebSocket = window.WebSocket;
      window.voiceSockets = [];
      window.voiceTracks = [];
      window.WebSocket = class extends NativeWebSocket {
        constructor(url, protocols) {
          super(url, protocols);
          window.voiceSockets.push(this);
        }
      };
      const capture = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await capture(constraints);
        window.voiceTracks.push(...stream.getAudioTracks());
        return stream;
      };
    });
  page.on('pageerror', (error) =>
    console.error('Browser error:', error.message),
  );
  await page.exposeFunction('apiCall', (operation, args) =>
    workspace.operation(operation, args),
  );
  await page.goto(`http://127.0.0.1:${frontend.address().port}`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const saved = await page.waitForSelector('label select');
  // Select the realtime profile by its labeled control, not the turn-based playground model.
  await page.waitForFunction(() =>
    [...document.querySelectorAll('label')]
      .find((node) => node.textContent.startsWith('Saved voice profile'))
      ?.querySelector('option[value="voice-agent"]'),
  );
  const select = (
    await page.evaluateHandle(() =>
      [...document.querySelectorAll('label')]
        .find((node) => node.textContent.startsWith('Saved voice profile'))
        .querySelector('select'),
    )
  ).asElement();
  await select.select('voice-agent');
  const connect = (
    await page.evaluateHandle(() =>
      [...document.querySelectorAll('button')].find(
        (node) => node.textContent.trim() === 'Connect microphone',
      ),
    )
  ).asElement();
  await connect.click();
  await page.waitForFunction(
    () => document.body.textContent.includes('Connected · microphone live'),
    { timeout: 30000 },
  );
  console.log('Voice acceptance: real browser microphone connected');
  await page.waitForFunction(() => document.querySelector('audio')?.srcObject, {
    timeout: 60000,
  });
  console.log('Voice acceptance: remote RTC audio track subscribed');
  await page.evaluate(async () => {
    const context = new AudioContext();
    await context.resume();
    const source = context.createMediaStreamSource(
      document.querySelector('audio').srcObject,
    );
    const analyzer = context.createAnalyser();
    source.connect(analyzer);
    window.returnedAudioAt = 0;
    window.audioTimer = setInterval(() => {
      const data = new Float32Array(analyzer.fftSize);
      analyzer.getFloatTimeDomainData(data);
      if (data.some((value) => Math.abs(value) > 0.001))
        window.returnedAudioAt = Date.now();
    }, 20);
  });
  const deadline = Date.now() + 90000;
  let transcript;
  while (Date.now() < deadline) {
    transcript = workspace.store
      .spans(worker.id)
      .items.find(
        (span) =>
          span.name === 'voice.transcript' &&
          span.attributes.role === 'user' &&
          String(span.attributes.text).toLowerCase().includes('weather'),
      );
    if (transcript) break;
    if (workspace.store.run(worker.id).status !== 'running')
      throw new Error(
        'Voice worker failed: ' +
          JSON.stringify(workspace.store.events(worker.id)),
      );
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(
    transcript,
    'Actual local Whisper must transcribe the generated spoken microphone waveform',
  );
  console.log('Voice acceptance: actual Whisper recognized spoken user turn');
  await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .find((node) => node.textContent.trim() === 'Mute microphone')
      .click(),
  );
  await page.waitForFunction(() =>
    document.body.textContent.includes('Connected · microphone muted'),
  );
  await page.waitForFunction(
    (recognizedAt) => window.returnedAudioAt >= recognizedAt,
    { timeout: 90000 },
    transcript.start,
  );
  assert.ok(requests.length || process.env.AIIDE_VOICE_TEST_CHAT_URL);
  if (!process.env.AIIDE_VOICE_TEST_CHAT_URL)
    assert.ok(
      requests.some((request) =>
        request.messages?.some(
          (message) =>
            message.role === 'user' &&
            JSON.stringify(message.content).toLowerCase().includes('weather'),
        ),
      ),
      'The chat endpoint must receive the recognized user turn',
    );
  await page.evaluate(() => clearInterval(window.audioTimer));
  if (faultScenarios) {
    assert.ok(
      injectedTransientFailure,
      'The recognized spoken turn must exercise a transient provider failure',
    );
    await page.waitForFunction(() =>
      document.body.textContent.includes('Provider errors observed: 1'),
    );
    await page.evaluate(() =>
      [...document.querySelectorAll('button')]
        .find((node) => node.textContent.trim() === 'Unmute microphone')
        .click(),
    );
    await page.waitForFunction(() =>
      document.body.textContent.includes('Connected · microphone live'),
    );
    await page.evaluate(() => {
      const signal = [...window.voiceSockets]
        .reverse()
        .find((socket) => socket.readyState === WebSocket.OPEN);
      if (!signal)
        throw new Error('The real LiveKit signaling socket must be connected');
      window.socketsBeforeInterruption = window.voiceSockets.length;
      signal.close(4001, 'local reliability acceptance');
    });
    await page.waitForFunction(
      () =>
        window.voiceSockets.length > window.socketsBeforeInterruption &&
        document.body.textContent.includes('Connected · microphone muted'),
      { timeout: 20000 },
    );
    await page.waitForFunction(
      () =>
        window.voiceTracks.length > 0 &&
        window.voiceTracks.every((track) => track.readyState === 'ended'),
    );
    console.log(
      'Voice reliability: actual WebSocket interruption recovered with microphone capture stopped',
    );
    await page.type('input[maxlength="4000"]', 'Force provider failure');
    await page.evaluate(() =>
      [...document.querySelectorAll('button')]
        .find((node) => node.textContent.trim() === 'Send realtime message')
        .click(),
    );
    await page.waitForFunction(
      () =>
        document.body.textContent.includes('Room disconnected') &&
        document.body.textContent.includes('voice session stopped'),
      { timeout: 60000 },
    );
    const failedRequests = requests.filter((request) =>
      request.messages?.some(
        (message) =>
          message.role === 'user' &&
          JSON.stringify(message.content)
            .toLowerCase()
            .includes('force provider failure'),
      ),
    );
    assert.equal(
      failedRequests.length,
      3,
      'A permanent outage must exhaust exactly the initial request and two retries',
    );
    await page.waitForFunction(() =>
      window.voiceTracks.every((track) => track.readyState === 'ended'),
    );
    const deadline = Date.now() + 10000;
    while (
      Date.now() < deadline &&
      !workspace.store
        .spans(worker.id)
        .items.some(
          (span) =>
            span.name === 'voice.session_closed' &&
            span.attributes.reason === 'error',
        )
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(
      workspace.store
        .spans(worker.id)
        .items.some(
          (span) =>
            span.name === 'voice.session_closed' &&
            span.attributes.reason === 'error',
        ),
    );
    assert.ok(
      workspace.store
        .spans(worker.id)
        .items.some(
          (span) =>
            span.name === 'voice.provider_error' &&
            span.attributes.recoverable === true,
        ),
    );
    console.log(
      'PASS: actual transient503 retry, signal reconnect with capture stopped, permanent outage bounded to3 attempts, room teardown and persisted redacted failure evidence',
    );
  }
  console.log(
    `PASS: real browser microphone waveform → LiveKit WebRTC → Silero VAD → local ${engine} Whisper → chat endpoint → actual device TTS → returned WebRTC audio and persisted user transcript. ` +
      (process.env.AIIDE_VOICE_TEST_CHAT_URL
        ? 'User-provided local chat endpoint.'
        : 'Chat output uses a deterministic HTTP fixture; ASR/TTS/RTC are real.'),
  );
} catch (error) {
  if (workspace)
    console.error(
      'Recorded voice diagnostics:',
      JSON.stringify(
        workspace.store
          .runs()
          .map((run) => ({ run, events: workspace.store.events(run.id) })),
      ),
    );
  throw error;
} finally {
  await browser?.close();
  await workspace?.close();
  if (modelServer) {
    modelServer.closeAllConnections();
    await new Promise((resolve) => modelServer.close(resolve));
  }
  if (frontend) {
    frontend.closeAllConnections();
    await new Promise((resolve) => frontend.close(resolve));
  }
  await execute('docker', ['stop', container], { timeout: 10000 }).catch(
    () => {},
  );
  fs.rmSync(root, { recursive: true, force: true });
}
