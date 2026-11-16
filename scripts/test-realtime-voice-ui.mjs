import assert from 'node:assert/strict';
import { build } from 'esbuild';
import puppeteer from 'puppeteer';

const { outputFiles } = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {VoicePanel} from './packages/theia-extension/src/browser/voice-panel.tsx';
  const root=createRoot(document.getElementById('root'));
  const profile={id:'voice-agent',url:'ws://127.0.0.1:7880',apiKey:'devkey',chatConnection:'chat',speechConnection:'speech',sttModel:'whisper-1',ttsModel:'tts-1',voice:'alloy',instructions:'You are a helpful voice agent. Reply briefly and clearly.',agentName:'aiide-voice'};
  const call=async(operation,args)=>operation==='voice.profiles'?[profile]:operation==='voice.status'?{ready:true}:operation==='voice.token'?(window.delayToken?new Promise(resolve=>window.releaseToken=()=>resolve({url:profile.url,token:'fixture'})):{url:profile.url,token:'fixture'}):operation==='drafts.get'?null:{};
  root.render(<VoicePanel call={call} connections={[]} />);window.unmount=()=>root.render(<p>Closed</p>);`,
    loader: 'tsx',
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  alias: { '@theia/core/shared/react': 'react' },
  plugins: [
    {
      name: 'room-fixture',
      setup(build) {
        build.onResolve({ filter: /^livekit-client$/ }, () => ({
          path: 'room',
          namespace: 'fixture',
        }));
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents: `export const Track={Kind:{Audio:'audio'}};export const RoomEvent={TrackSubscribed:'track',TrackUnsubscribed:'untrack',TranscriptionReceived:'transcript',Disconnected:'disconnected',ParticipantDisconnected:'participantLeft',Reconnecting:'reconnecting',SignalReconnecting:'signalReconnecting',Reconnected:'reconnected',DataReceived:'data'};
    export class Room{constructor(options){window.fixtureRoom=this;this.options=options;this.events={};this.localParticipant={setMicrophoneEnabled:async(value)=>{window.microphoneEnabled=value;},sendText:async()=>{}};}on(name,callback){this.events[name]=callback;return this;}registerTextStreamHandler(topic,callback){this.stream=callback;}async connect(){}async startAudio(){}async disconnect(){window.disconnected=(window.disconnected||0)+1;this.events.disconnected?.();}}`,
        }));
      },
    },
  ],
});
const browser = await puppeteer.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<main id="root"></main>');
  await page.addScriptTag({ content: outputFiles[0].text });
  await page.waitForFunction(() =>
    [...document.querySelectorAll('label')]
      .find((node) => node.textContent.startsWith('Saved voice profile'))
      ?.querySelector('option[value="voice-agent"]'),
  );
  const selector = (
    await page.evaluateHandle(() =>
      [...document.querySelectorAll('label')]
        .find((node) => node.textContent.startsWith('Saved voice profile'))
        .querySelector('select'),
    )
  ).asElement();
  await selector.select('voice-agent');
  await page.evaluate(() => {
    window.delayToken = true;
  });
  const clickButton = (label) =>
    page.evaluate(
      (label) =>
        [...document.querySelectorAll('button')]
          .find((node) => node.textContent.trim() === label)
          .click(),
      label,
    );
  await clickButton('Connect microphone');
  await page.waitForFunction(() =>
    document.body.textContent.includes('Connecting voice room'),
  );
  await clickButton('Cancel connection');
  await page.waitForFunction(() =>
    document.body.textContent.includes('Voice connection cancelled'),
  );
  await page.evaluate(() => {
    window.releaseToken();
    window.delayToken = false;
  });
  assert.equal(
    await page.evaluate(() => !!window.fixtureRoom),
    false,
    'a late token cannot resurrect a cancelled join',
  );
  await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .find((node) => node.textContent.trim() === 'Connect microphone')
      .click(),
  );
  await page.waitForFunction(() =>
    document.body.textContent.includes('Connected · microphone live'),
  );
  assert.equal(
    await page.evaluate(
      () => window.fixtureRoom.options.publishDefaults.stopMicTrackOnMute,
    ),
    true,
  );
  assert.equal(
    await page.evaluate(() =>
      window.fixtureRoom.options.reconnectPolicy.nextRetryDelayInMs({
        retryCount: 4,
        elapsedMs: 100,
      }),
    ),
    null,
  );
  await page.evaluate(() => window.fixtureRoom.events.signalReconnecting());
  await page.waitForFunction(() =>
    document.body.textContent.includes('Reconnecting · microphone paused'),
  );
  assert.equal(await page.evaluate(() => window.microphoneEnabled), false);
  await page.evaluate(() => window.fixtureRoom.events.reconnected());
  await page.waitForFunction(() =>
    document.body.textContent.includes('Connected · microphone muted'),
  );
  assert.equal(await page.evaluate(() => window.microphoneEnabled), false);
  await clickButton('Unmute microphone');
  await page.waitForFunction(() => window.microphoneEnabled === true);
  await page.evaluate(() => {
    const packet = new TextEncoder().encode(
      JSON.stringify({
        state: 'retrying',
        component: 'llm_error',
        message: 'secret-must-not-display',
      }),
    );
    window.fixtureRoom.events.data(
      packet,
      { isAgent: false },
      undefined,
      'aiide.voice.health',
    );
  });
  assert.equal(
    await page.evaluate(() =>
      document.body.textContent.includes('Provider errors observed'),
    ),
    false,
  );
  await page.evaluate(() =>
    window.fixtureRoom.events.data(
      new TextEncoder().encode(
        JSON.stringify({
          state: 'retrying',
          component: 'llm_error',
          message: 'secret-must-not-display',
        }),
      ),
      { isAgent: true },
      undefined,
      'aiide.voice.health',
    ),
  );
  await page.waitForFunction(() =>
    document.body.textContent.includes('Provider errors observed: 1'),
  );
  assert.equal(
    await page.evaluate(() =>
      document.body.textContent.includes('secret-must-not-display'),
    ),
    false,
  );
  await page.evaluate(async () => {
    const reader = {
      withAbortSignal(signal) {
        this.signal = signal;
        return this;
      },
      async *[Symbol.asyncIterator]() {
        try {
          yield 'ह'.repeat(3000);
          yield 'must not read';
        } finally {
          window.cancelledOversized = true;
        }
      },
    };
    await window.fixtureRoom.stream(reader, { identity: 'remote' });
  });
  assert.equal(await page.evaluate(() => window.cancelledOversized), true);
  await page.waitForFunction(() =>
    document.body.textContent.includes('exceeded 8 KB'),
  );
  assert.equal(
    await page.$eval(
      '[aria-label="Realtime voice transcript"]',
      (node) => node.textContent,
    ),
    '',
  );
  await page.evaluate(() =>
    window.fixtureRoom.events.transcript(
      Array.from({ length: 200 }, () => ({
        final: true,
        text: 'x'.repeat(7900),
      })),
      { identity: 'remote' },
    ),
  );
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Realtime voice transcript"]')
        .textContent.length > 0,
  );
  assert.ok(
    await page.$eval(
      '[aria-label="Realtime voice transcript"]',
      (node) => new TextEncoder().encode(node.textContent).length <= 60000,
    ),
  );
  await page.evaluate(() =>
    window.fixtureRoom.events.transcript(
      [{ final: true, text: 'x'.repeat(1000000) }],
      { identity: 'remote' },
    ),
  );
  assert.ok(
    await page.$eval(
      '[aria-label="Realtime voice transcript"]',
      (node) => new TextEncoder().encode(node.textContent).length <= 60000,
    ),
  );
  await page.evaluate(() =>
    window.fixtureRoom.events.data(
      new TextEncoder().encode(
        JSON.stringify({ state: 'failed', component: 'tts_error' }),
      ),
      { isAgent: true },
      undefined,
      'aiide.voice.health',
    ),
  );
  await page.waitForFunction(() =>
    document.body.textContent.includes('Room disconnected'),
  );
  await page.evaluate(() => window.unmount());
  await page.waitForFunction(() => document.body.textContent === 'Closed');
  assert.ok(await page.evaluate(() => window.disconnected >= 1));
  assert.deepEqual(errors, []);
  console.log(
    'PASS: cancelled joins reject late tokens, bounded reconnect pauses capture until explicit unmute, agent-only provider health, remote stream limits and navigation teardown (SDK protocol fixture).',
  );
} finally {
  await browser.close();
}
