// Drives a disposable copy of the demo project in the real IDE and screen-records each UI scene.
// Usage: node record.mjs [scene-id ...]   (IDE must be running at DEMO_URL)
import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'assets');
const timelineFile = path.join(assets, 'timeline.json');
const timeline = JSON.parse(fs.readFileSync(timelineFile));
const only = process.argv.slice(2);
const url = process.env.DEMO_URL || 'http://127.0.0.1:3112';
const ffmpegPath = process.env.FFMPEG || '/opt/zerobrew/prefix/bin/ffmpeg';

const browser = await puppeteer.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox', '--window-size=1440,900'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const find = (text, selector = 'button') =>
  page.waitForFunction(
    (text, selector) =>
      [...document.querySelectorAll(selector)].find(
        (e) => e.textContent.includes(text) && !e.disabled && e.offsetParent,
      ),
    { timeout: 60000 },
    text,
    selector,
  );
const point = async (el) => {
  await el.evaluate((e) => e.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  await delay(500);
  const box = await el.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 });
  await delay(250);
};
const click = async (text, selector = 'button') => {
  const el = (await find(text, selector)).asElement();
  await point(el);
  await el.click();
  await delay(600);
};
const nav = (id) => click('', `.aiide-tabs [data-tab="${id}"]`);
const field = async (label, value) => {
  const handle = await page.evaluateHandle(
    (label) =>
      [...document.querySelectorAll('.aiide label')]
        .find((e) => e.textContent.trim().startsWith(label))
        ?.querySelector('input,textarea,select'),
    label,
  );
  const el = handle.asElement();
  assert.ok(el, 'Missing field: ' + label);
  await point(el);
  if ((await el.evaluate((e) => e.tagName)) === 'SELECT') await el.select(value);
  else {
    await el.click();
    await el.evaluate((e) => {
      const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, '');
      e.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await delay(150);
    await el.type(value, { delay: 28 });
  }
  await delay(500);
};
const scrollTo = async (selector, block = 'start') => {
  await page.waitForSelector(selector, { timeout: 60000 });
  await page.$eval(selector, (e, block) => e.scrollIntoView({ block, behavior: 'smooth' }), block);
  await delay(900);
};
const top = async () => {
  await page.$eval('.aiide-content', (e) => e.scrollTo({ top: 0, behavior: 'smooth' }));
  await delay(700);
};
const jobDone = () =>
  page.waitForFunction(
    () => [...document.querySelectorAll('h3')].some((h) => /Job status: (completed|failed)/.test(h.textContent)),
    { timeout: 180000, polling: 500 },
  );
const runOption = (label, filter) =>
  page.evaluate(
    (label, filter) => {
      const select = [...document.querySelectorAll('.aiide label')]
        .find((e) => e.textContent.trim().startsWith(label))
        .querySelector('select');
      return [...select.options].filter((o) => o.value && o.textContent.startsWith('train'))[filter]?.value;
    },
    label,
    filter,
  );
const installCursor = () =>
  page.evaluate(() => {
    if (document.getElementById('demo-cursor')) return;
    const cursor = document.createElement('div');
    cursor.id = 'demo-cursor';
    cursor.style = 'position:fixed;z-index:999999;left:720px;top:450px;width:22px;height:28px;pointer-events:none;filter:drop-shadow(0 2px 2px #0009)';
    cursor.innerHTML = '<svg viewBox="0 0 22 28"><path d="M2 2 L2 23 L7 18 L12 26 L16 24 L11 16 L19 16 Z" fill="white" stroke="#111" stroke-width="1.5"/></svg>';
    document.body.append(cursor);
    document.addEventListener('mousemove', (e) => {
      cursor.style.left = e.clientX + 'px';
      cursor.style.top = e.clientY + 'px';
    });
  });

// Scroll the Nth JSON block containing `needle` so that line is visible.
const showText = (needle, which = 0) =>
  page.evaluate(
    (needle, which) => {
      const pre = [...document.querySelectorAll('.aiide-json')].filter((p) => p.textContent.includes(needle))[which];
      if (!pre) return;
      pre.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const lines = pre.textContent.split('\n');
      const at = lines.findIndex((l) => l.includes(needle));
      pre.scrollTo({ top: (at / lines.length) * pre.scrollHeight - 20, behavior: 'smooth' });
    },
    needle,
    which,
  );
const ids = {};
const scenes = {
  '03-home': async () => {
    await nav('Overview');
    await top();
    const card = (await find('Train a model', '.aiide-workflow')).asElement();
    await point(card);
    await delay(4000);
    await page.mouse.move(400, 330, { steps: 25 });
    await delay(3500);
    await click('Open training');
  },
  '04-baseline': async () => {
    await top();
    await field('Training command', 'train');
    await field('Training parameters', '{"n_estimators": 200, "learning_rate": 0.1, "max_depth": 3}');
    await click('Start training');
    await scrollTo('.aiide-metric-grid');
    await jobDone();
    ids.baseline = await runOption('Run', 0);
    await delay(1500);
  },
  '05-bigger': async () => {
    await top();
    await field('Training parameters', '{"n_estimators": 300, "learning_rate": 0.2, "max_depth": 8}');
    await click('Start training');
    await delay(1200);
    const baseline = ids.baseline || (await runOption('Compare training run', 0));
    await field('Compare training run', baseline);
    await scrollTo('.aiide-metric-grid');
    await jobDone();
    await delay(2500);
    // Final metrics row (validation R², MAE) below the curves.
    await page.evaluate(() =>
      [...document.querySelectorAll('.aiide-metric-grid .aiide-card')]
        .find((c) => c.textContent.startsWith('validation.r2'))
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
    );
    await delay(2000);
  },
  '06-runs': async () => {
    await nav('Runs');
    await top();
    await delay(1200);
    // Newest first: bigger model, baseline, setup.
    const rows = await page.$$('.aiide-table-wrap tbody tr td:first-child button');
    await point(rows[0]);
    await rows[0].click();
    await delay(1500);
    await click('Environment & configuration', 'summary');
    await showText('"parameters"');
    await delay(3500);
    const other = await page.evaluate(() => {
      const select = [...document.querySelectorAll('.aiide label')]
        .filter((e) => e.textContent.trim().startsWith('Run'))
        .at(-1)
        .querySelector('select');
      return [...select.options].find((o) => o.value && o.textContent.startsWith('train'))?.value;
    });
    await field('Run', other);
    await click('Compare');
    await delay(800);
    await showText('"evaluations"', 0);
    await showText('"evaluations"', 1);
    await delay(3000);
  },
  '07-trace': async () => {
    await top();
    await click('Trace ↗');
    await page.waitForSelector('.aiide-span');
    await delay(1500);
    await click('model.fit', '.aiide-span');
    await delay(3000);
    await click('Open source');
    await page.waitForSelector('.monaco-editor');
    await delay(3000);
  },
  '08-artifact': async () => {
    await page.click('[id="shell-tab-aiide.workbench"]');
    await delay(800);
    await nav('Training');
    await top();
    const baseline = ids.baseline || (await runOption('Run', 1));
    await field('Run', baseline);
    await delay(1500);
    await scrollTo('.aiide-metric-grid ~ section.aiide-card, .aiide-main section.aiide-card:has(> h3)', 'center');
    await page.evaluate(() =>
      [...document.querySelectorAll('.aiide-card h3')].find((h) => h.textContent.startsWith('Artifacts'))?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
    );
    await delay(1200);
    await click('Inspect checkpoint');
    await delay(1500);
    await click('Locate file');
    await delay(2500);
  },
};

const record = async (scene) => {
  await installCursor();
  const file = path.join(assets, `${scene.id}.webm`);
  const started = Date.now();
  const recorder = await page.screencast({ path: file, fps: 24, quality: 18, ffmpegPath });
  try {
    await delay(700);
    await scenes[scene.id]();
    await delay(Math.max(700, scene.duration * 1000 - (Date.now() - started)));
  } finally {
    await recorder.stop();
  }
  const seconds = (Date.now() - started) / 1000;
  scene.duration = Math.max(scene.duration, Math.round(seconds * 1000) / 1000);
  await page.screenshot({ path: path.join(assets, `${scene.id}.png`) });
  console.log('Recorded', scene.id, seconds.toFixed(1) + 's', 'scene', scene.duration + 's');
};

try {
  await page.goto(url, { waitUntil: 'networkidle2' });
  await page.waitForSelector('[id="shell-tab-aiide.workbench"]', { timeout: 60000 });
  await delay(2000);
  await page.evaluate(() =>
    [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Yes, I trust'))?.click(),
  );
  await page.click('[id="shell-tab-aiide.workbench"]');
  await page.waitForSelector('.aiide-welcome, .aiide-tabs', { timeout: 60000 });
  if (await page.$('.aiide-welcome')) await click('Open engineering workspace');
  await page.waitForSelector('.aiide-tabs');
  // Off camera: install the locked environment so Home reflects a ready project.
  if (!only.length || only.includes('03-home')) {
    await nav('Runs');
    await field('Configured command', 'setup');
    await click('Run locally');
    await page.waitForFunction(() => document.querySelector('tr.selected .aiide-badge.completed'), { timeout: 120000 });
  }
  for (const scene of timeline) {
    if (!scenes[scene.id] || (only.length && !only.includes(scene.id))) continue;
    await record(scene);
  }
  fs.writeFileSync(timelineFile, JSON.stringify(timeline, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(assets, 'record-failure.png') });
  throw error;
} finally {
  await browser.close();
}
