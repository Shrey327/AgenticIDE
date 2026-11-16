import assert from 'node:assert/strict';
import { build } from 'esbuild';
import puppeteer from 'puppeteer';

const { outputFiles } = await build({
  stdin: {
    contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {VoicePanel} from './packages/theia-extension/src/browser/voice-panel.tsx';
      import {VoiceInput} from './packages/theia-extension/src/browser/voice-input.tsx';
      const root = createRoot(document.getElementById('root'));
      window.requests = [];
      window.speech = [];
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { cancel: () => window.cancellations = (window.cancellations || 0) + 1, speak: (utterance) => window.speech.push(utterance.text) } });
      window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
      window.installRecognition = () => {
        window.SpeechRecognition = class {
          constructor() { window.recognition = this; }
          start() { window.starts = (window.starts || 0) + 1; }
          stop() { window.stops = (window.stops || 0) + 1; this.onend?.(); }
          abort() { window.aborts = (window.aborts || 0) + 1; this.onend?.(); }
        };
      };
      const call = async (operation, args) => {
        if (operation === 'drafts.get') return null;
        if (operation === 'drafts.save') return args.data;
        if (operation === 'voice.profiles') return [];
        if (operation === 'voice.status') return {ready:false, setup:'Install the locked voice runtime to use realtime audio.'};
        if (operation === 'runs.list' || operation === 'connections.list') return [];
        window.requests.push({operation, args});
        if (operation === 'knowledge.save') return {id:'voice-session',file:'knowledge/wiki/voice-session.md'};
        return new Promise((resolve, reject) => { window.complete = resolve; window.fail = reject; });
      };
      window.show = () => root.render(<VoicePanel connections={[{id:'local',kind:'model'}]} call={call} />);
      window.unmount = () => root.render(<p>Another page</p>);
      window.emit = (text, final) => window.recognition.onresult({resultIndex:0,results:[{0:{transcript:text},isFinal:final}]});
      window.show();
    `,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  alias: { '@theia/core/shared/react': 'react' },
});
const browser = await puppeteer.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH ||
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined),
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<main id="root"></main>');
  await page.addScriptTag({ content: outputFiles[0].text });
  await page.waitForSelector('[aria-label="Voice message"]');
  const button = async (label) => {
    const handles = await page.$$('button');
    for (const handle of handles) {
      if ((await handle.evaluate((node) => node.textContent)).trim() === label)
        return handle;
      await handle.dispose();
    }
    throw new Error(`Button not found: ${label}`);
  };
  // Unsupported Web Speech environments retain a fully usable text flow.
  await page.evaluate(() => {
    delete window.SpeechRecognition;
    delete window.webkitSpeechRecognition;
    window.show();
  });
  await page.waitForFunction(() =>
    document.body.textContent.includes('Speech recognition is unavailable'),
  );
  assert.equal(
    await (await button('Dictate')).evaluate((node) => node.disabled),
    true,
  );
  await page.select('select', 'local');
  await page.type('[aria-label="Voice message"]', 'Hello');
  await page.click('input[type="checkbox"]');
  await page.focus('[aria-label="Voice message"]');
  await page.keyboard.down('Control');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Control');
  await page.waitForSelector('[aria-busy="true"]');
  assert.equal(
    await (await button('Send turn →')).evaluate((node) => node.disabled),
    true,
  );
  assert.equal(await page.evaluate(() => window.requests.length), 1);
  await page.evaluate(() => window.complete({ text: 'Hello back' }));
  await page.waitForSelector('[aria-busy="false"]');
  assert.equal(await page.evaluate(() => window.speech[0]), 'Hello back');
  assert.match(
    await page.$eval('[role="log"]', (node) => node.textContent),
    /Hello back/,
  );
  await (await button('Save to project memory')).click();
  await page.waitForFunction(() =>
    document.body.textContent.includes('Saved a snapshot'),
  );
  assert.match(
    await page.evaluate(() => window.requests[1].args.body),
    /## You\n\nHello\n\n## Agent\n\nHello back/,
  );
  // Confirm the downloadable evaluation keeps conversation context and warns about generated references.
  await page.evaluate(() => {
    window.downloads = [];
    URL.createObjectURL = (blob) => {
      window.blob = blob;
      return 'blob:test';
    };
    HTMLAnchorElement.prototype.click = function () {
      window.downloads.push(this.download);
    };
  });
  await (await button('Export evaluation draft')).click();
  const exported = JSON.parse(await page.evaluate(() => window.blob.text()));
  assert.equal(exported.expected, 'Hello back');
  assert.equal(exported.messages.at(-1).content, 'Hello');
  assert.match(
    await page.$eval('main', (node) => node.textContent),
    /provisional references/,
  );

  await page.evaluate(() => window.installRecognition());
  await (await button('New session')).click();
  await (await button('Dictate')).click();
  await page.evaluate(() => window.emit('unfinished thought', false));
  assert.equal(
    await page.$eval('[aria-label="Voice message"]', (node) => node.value),
    '',
  );
  await page.evaluate(() => window.emit('Final thought', true));
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Voice message"]').value ===
      'Final thought',
  );
  assert.equal(
    await page.evaluate(() => window.requests.length),
    2,
    'dictation must never auto-send',
  );
  await (await button('Stop dictation')).click();
  assert.equal(await page.evaluate(() => window.stops), 1);
  await (await button('Dictate')).click();
  await page.evaluate(() =>
    window.recognition.onerror({ error: 'not-allowed' }),
  );
  await page.waitForSelector('[role="alert"]');
  assert.match(
    await page.$eval('[role="alert"]', (node) => node.textContent),
    /Microphone permission was denied/,
  );
  await (await button('Dictate')).click();
  await (await button('Send turn →')).click();
  await page.waitForSelector('[aria-busy="true"]');
  assert.ok(
    await page.evaluate(() => window.aborts >= 1),
    'sending must release active mic',
  );
  await page.evaluate(() => window.fail(new Error('Model unavailable')));
  await page.waitForSelector('[aria-busy="false"]');
  assert.equal(
    await page.$eval('[aria-label="Voice message"]', (node) => node.value),
    'Final thought',
    'failure retains input',
  );
  await (await button('Dictate')).click();
  await page.evaluate(() => {
    window.previousRecognition = window.recognition;
    window.unmount();
  });
  await page.waitForFunction(
    () => document.body.textContent === 'Another page',
  );
  assert.equal(
    await page.evaluate(() => window.previousRecognition.onresult),
    null,
    'unmount detaches callbacks',
  );
  assert.ok(await page.evaluate(() => window.aborts >= 2));
  await page.evaluate(() => window.show());
  await page.waitForSelector('[aria-label="Voice message"]');
  await page.select('select', 'local');
  await page.type('[aria-label="Voice message"]', 'A late response');
  await page.click('input[type="checkbox"]');
  await (await button('Send turn →')).click();
  await page.waitForSelector('[aria-busy="true"]');
  const spoken = await page.evaluate(() => window.speech.length);
  await page.evaluate(() => window.unmount());
  await page.waitForFunction(
    () => document.body.textContent === 'Another page',
  );
  await page.evaluate(() =>
    window.complete({ text: 'Do not play on another page' }),
  );
  assert.equal(
    await page.evaluate(() => window.speech.length),
    spoken,
    'late inference after navigation cannot start speech',
  );
  await page.evaluate(() => window.show());
  await page.waitForSelector('[aria-label="Voice message"]');
  await page.select('select', 'local');
  await page.type(
    '[aria-label="Voice message"]',
    'A large multilingual response',
  );
  await (await button('Send turn →')).click();
  await page.waitForSelector('[aria-busy="true"]');
  await page.evaluate(() => window.complete({ text: 'ह'.repeat(22000) }));
  await page.waitForSelector('[aria-busy="false"]');
  assert.equal(
    await (
      await button('Save to project memory')
    ).evaluate((node) => node.disabled),
    true,
    'memory limit is UTF-8 bytes, not characters',
  );
  assert.equal(
    await (await button('Export transcript')).evaluate((node) => node.disabled),
    false,
    'large transcripts remain exportable',
  );
  assert.match(
    await page.$eval('main', (node) => node.textContent),
    /64 KB page limit/,
  );
  await (await button('Export transcript')).click();
  const fullTranscript = JSON.parse(
    await page.evaluate(() => window.blob.text()),
  );
  assert.equal(
    fullTranscript.turns[1].content.length,
    22000,
    'export never truncates oversized memory',
  );
  await page.type('[aria-label="Voice message"]', 'Unsent draft');
  await (await button('New session')).click();
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Voice message"]').value === '',
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS: unsupported fallback, manual turns, speech opt-in, session export, memory save, evaluation draft, final-only dictation, permission errors, input preservation and mic teardown',
  );
} finally {
  await browser.close();
}
