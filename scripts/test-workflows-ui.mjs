import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
import core from '../packages/core/lib/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-workflow-ui-'));
const project = path.join(root, 'project');
fs.mkdirSync(project);
core.saveProject(project, {
  version: 1,
  name: 'No-code workflow acceptance',
  environment: {
    python:
      process.env.AIIDE_LAB_TEST_PYTHON ||
      path.resolve('templates/sklearn/.venv/bin/python'),
  },
  commands: {},
});
const port = Number(process.env.AIIDE_WORKFLOW_TEST_PORT || 3094);
const url = `http://127.0.0.1:${port}`;
const logPath = path.join(root, 'server.log');
const log = fs.openSync(logPath, 'w');
const backend = spawn(
  'node',
  [
    'apps/browser/lib/backend/main.js',
    project,
    `--port=${port}`,
    '--hostname=127.0.0.1',
  ],
  {
    cwd: process.cwd(),
    env: { ...process.env, THEIA_CONFIG_DIR: path.join(root, 'theia') },
    detached: true,
    stdio: ['ignore', log, log],
  },
);
fs.closeSync(log);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser, page;
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(url)).ok) {
        ready = true;
        break;
      }
    } catch {}
    if (backend.exitCode !== null) break;
    await delay(200);
  }
  assert.ok(
    ready,
    `Browser backend did not start: ${fs.readFileSync(logPath, 'utf8')}`,
  );
  browser = await puppeteer.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      (process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : undefined),
    defaultViewport: { width: 1440, height: 1000 },
    args: ['--no-sandbox'],
  });
  page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const click = async (text, selector = '.aiide button') => {
    await page.waitForFunction(
      (text, selector) =>
        [...document.querySelectorAll(selector)].some(
          (node) => node.textContent.includes(text) && !node.disabled,
        ),
      {},
      text,
      selector,
    );
    const element = (
      await page.evaluateHandle(
        (text, selector) =>
          [...document.querySelectorAll(selector)].find(
            (node) => node.textContent.includes(text) && !node.disabled,
          ),
        text,
        selector,
      )
    ).asElement();
    await element.click();
    await element.dispose();
  };
  const field = async (label, value) => {
    const element = (
      await page.evaluateHandle(
        (label) =>
          [...document.querySelectorAll('.aiide label')]
            .find((node) => node.textContent.trim().startsWith(label))
            ?.querySelector('input,select,textarea'),
        label,
      )
    ).asElement();
    assert.ok(element, `Missing field: ${label}`);
    if (await element.evaluate((node) => node.tagName === 'SELECT'))
      await element.select(value);
    else
      await element.evaluate((node, value) => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        ).set.call(node, value);
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
      }, value);
    await element.dispose();
  };
  await page.goto(url, { waitUntil: 'networkidle2' });
  await page.waitForSelector('[id="shell-tab-aiide.workbench"]');
  await page.click('[id="shell-tab-aiide.workbench"]');
  await page.waitForFunction(
    () =>
      document.querySelector('.aiide') ||
      [...document.querySelectorAll('button')].some((node) =>
        node.textContent.includes('Yes, I trust'),
      ),
  );
  await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .find((node) => node.textContent.includes('Yes, I trust'))
      ?.click(),
  );
  await page.waitForSelector('.aiide-tabs, .aiide-welcome');
  if (await page.$('.aiide-welcome')) await click('Open engineering workspace');
  await page.waitForSelector('.aiide-tabs [data-tab="Lab"]');
  await page.focus('.aiide-tabs [data-tab="Lab"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector(
    '.aiide-tabs [data-tab="Lab"][aria-current="page"]',
  );
  await click('Try Iris classification sample');
  await page.waitForSelector('.aiide-model-card input[type="checkbox"]');
  assert.equal(
    await page.$eval(
      '[aria-label="Task"] [aria-pressed="true"]',
      (node) => node.textContent,
    ),
    'classification',
  );
  await page.evaluate(() => {
    const forest = [...document.querySelectorAll('.aiide-model-card')].find(
      (node) => node.querySelector('strong')?.textContent === 'Random forest',
    );
    if (forest?.querySelector('input[type="checkbox"]').checked)
      forest.querySelector('input[type="checkbox"]').click();
  });
  await field('Folds', '2');
  const chosen = await page.$$eval('.aiide-model-card', (nodes) =>
    nodes
      .filter((node) => node.querySelector('input[type="checkbox"]').checked)
      .map((node) => node.querySelector('strong').textContent),
  );
  assert.deepEqual(chosen.sort(), [
    'Logistic regression',
    'Support vector machine',
  ]);
  await click('Run sweep');
  await page.waitForSelector('.aiide-leaderboard .aiide-badge.completed', {
    timeout: 120000,
  });
  await page.waitForFunction(
    () => document.querySelectorAll('.aiide-leader tbody tr').length === 5,
    { timeout: 30000 },
  );
  assert.match(
    await page.$eval('.aiide-leader', (node) => node.textContent),
    /Support vector machine/,
  );
  assert.match(
    await page.$eval('.aiide-leader', (node) => node.textContent),
    /Logistic regression/,
  );
  assert.equal(
    await page.$eval('.aiide-leader', (node) =>
      node.getAttribute('aria-label'),
    ),
    'Model comparison leaderboard',
  );
  await click('Train final');
  await page.waitForSelector('.aiide-inference', { timeout: 60000 });
  await click('Predict', '.aiide-inference button');
  await page.waitForSelector('.aiide-prediction[role="status"]', {
    timeout: 30000,
  });
  assert.match(
    await page.$eval('.aiide-prediction strong', (node) => node.textContent),
    /setosa|versicolor|virginica/,
  );
  await click('Batch predict a CSV', '.aiide-inference summary');
  const sample = fs.readdirSync(project).find((file) => file.endsWith('.csv'));
  assert.ok(sample);
  await field('File with the same feature columns', sample);
  await click('Predict file');
  await page.waitForFunction(
    () =>
      document
        .querySelector('.aiide-inference')
        ?.textContent.includes('150 predictions'),
    { timeout: 30000 },
  );
  assert.equal(fs.readdirSync(path.join(project, 'predictions')).length, 1);
  const contrast = await page.$eval('.aiide-inference', (section) => {
    const style = getComputedStyle(section.querySelector('.aiide-primary'));
    const note = getComputedStyle(section.querySelector('p.aiide-note'));
    const background = getComputedStyle(section).backgroundColor;
    const rgb = (color) =>
      color
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map(Number);
    const effectiveNote = rgb(note.color).map(
      (value, i) =>
        value * Number(note.opacity) +
        rgb(background)[i] * (1 - Number(note.opacity)),
    );
    const luminance = (color) => {
      const [r, g, b] = color
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map(Number)
        .map((value) => {
          const n = value / 255;
          return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
        });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    return {
      primary: ratio(luminance(style.color), luminance(style.backgroundColor)),
      note: ratio(
        luminance(`rgb(${effectiveNote.join(',')})`),
        luminance(background),
      ),
    };
  });
  assert.ok(
    contrast.primary >= 4.5,
    `Primary action text contrast: ${contrast.primary}`,
  );
  assert.ok(contrast.note >= 4.5, `Help text contrast: ${contrast.note}`);
  fs.mkdirSync('artifacts/usability', { recursive: true });
  await page.screenshot({
    path: 'artifacts/usability/lab-inference.png',
    fullPage: true,
  });
  console.log(
    'PASS: real browser → Iris dataset → SVM + logistic 5-trial sweep → final fit → single and batch predictions',
  );

  await page.focus('.aiide-tabs [data-tab="Finetune"]');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () =>
      document
        .querySelector('.aiide-main')
        ?.textContent.includes('Missing packages:'),
    { timeout: 30000 },
  );
  assert.ok(await page.$('#hf-environment'));
  const disabled = await page.$$eval(
    '.aiide-main button',
    (nodes) =>
      nodes.find((node) => node.textContent.trim() === 'Download model')
        ?.disabled,
  );
  assert.equal(
    disabled,
    true,
    'Downloads must be blocked until the project environment is ready',
  );
  const unnamed = await page.$$eval(
    '.aiide-main input,.aiide-main select,.aiide-main textarea',
    (nodes) =>
      nodes
        .filter(
          (node) =>
            !node.labels?.length &&
            !node.getAttribute('aria-label') &&
            !node.getAttribute('aria-labelledby'),
        )
        .map((node) => node.outerHTML),
  );
  assert.deepEqual(unnamed, []);
  await page.emulateMediaFeatures([
    { name: 'prefers-reduced-motion', value: 'reduce' },
  ]);
  await page.setViewport({ width: 760, height: 1000 });
  await page.focus('.aiide-main input');
  const outline = await page.$eval(
    '.aiide-main input',
    (node) => getComputedStyle(node).outlineWidth,
  );
  assert.notEqual(outline, '0px', 'Keyboard focus must be visible');
  assert.equal(
    await page.$eval(
      '.aiide-tabs [data-tab="Finetune"]',
      (node) =>
        !!node.getAttribute('title') || !!node.getAttribute('aria-label'),
    ),
    true,
    'Collapsed navigation needs an accessible name',
  );
  await page.screenshot({
    path: 'artifacts/usability/model-hub.png',
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    'PASS: Hugging Face environment prerequisite, labeled fields, responsive navigation and keyboard focus',
  );
} catch (error) {
  if (page) {
    console.error(await page.$eval('body', (node) => node.innerText));
    await page.screenshot({
      path: '/tmp/aiide-workflow-failure.png',
      fullPage: true,
    });
  }
  throw error;
} finally {
  if (browser) await browser.close();
  try {
    process.kill(-backend.pid, 'SIGTERM');
  } catch {}
  await delay(500);
  if (process.env.AIIDE_KEEP_TEST_DATA) console.log('Test data:', root);
  else fs.rmSync(root, { recursive: true, force: true });
}
