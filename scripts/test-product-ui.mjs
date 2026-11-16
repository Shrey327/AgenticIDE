import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
import core from '../packages/core/lib/index.js';

// Exercise the real Theia bridge, workspace storage, model HTTP, Python and telemetry.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-product-ui-'));
const root = path.join(directory, 'project');
fs.mkdirSync(root);
core.saveProject(root, {
  version: 1,
  name: 'Product acceptance',
  environment: { python: process.env.AIIDE_RL_TEST_PYTHON || 'python3' },
});
const model = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      choices: [
        {
          message: {
            content: `Fixture reply: ${request.messages.at(-1).content}`,
          },
        },
      ],
    }),
  );
});
await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
await new core.Connections(path.join(root, '.aiide')).save({
  id: 'voice-fixture',
  kind: 'model',
  model: 'fixture',
  url: `http://127.0.0.1:${model.address().port}/v1`,
});
const port = Number(process.env.AIIDE_PRODUCT_TEST_PORT || 3097);
const url = `http://127.0.0.1:${port}`;
const logPath = path.join(directory, 'server.log');
const log = fs.openSync(logPath, 'w');
const backend = spawn(
  'node',
  [
    'apps/browser/lib/backend/main.js',
    root,
    `--port=${port}`,
    '--hostname=127.0.0.1',
  ],
  {
    env: { ...process.env, THEIA_CONFIG_DIR: path.join(directory, 'theia') },
    detached: true,
    stdio: ['ignore', log, log],
  },
);
fs.closeSync(log);
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
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(ready, fs.readFileSync(logPath, 'utf8'));
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
  page.on('pageerror', (error) => console.error('PAGE ERROR:', error.message));
  const click = async (text) => {
    await page.waitForFunction(
      (text) =>
        [...document.querySelectorAll('.aiide button')].some(
          (node) => node.textContent.trim() === text && !node.disabled,
        ),
      {},
      text,
    );
    await page.evaluate(
      (text) =>
        [...document.querySelectorAll('.aiide button')]
          .find((node) => node.textContent.trim() === text && !node.disabled)
          .click(),
      text,
    );
  };
  const field = async (label, value) => {
    await page.waitForFunction(
      (label) =>
        [...document.querySelectorAll('.aiide label')].some(
          (node) =>
            node.textContent.trim().startsWith(label) &&
            node.querySelector('input,select,textarea'),
        ),
      {},
      label,
    );
    await page.evaluate(
      (label, value) => {
        const node = [...document.querySelectorAll('.aiide label')]
          .find((node) => node.textContent.trim().startsWith(label))
          ?.querySelector('input,select,textarea');
        if (!node) throw new Error('Missing field: ' + label);
        const prototype =
          node.tagName === 'TEXTAREA'
            ? HTMLTextAreaElement.prototype
            : node.tagName === 'SELECT'
              ? HTMLSelectElement.prototype
              : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(
          node,
          value,
        );
        node.dispatchEvent(
          new Event(node.tagName === 'SELECT' ? 'change' : 'input', {
            bubbles: true,
          }),
        );
      },
      label,
      value,
    );
  };
  const navigate = async (tab) => {
    await page.focus(`.aiide-tabs [data-tab="${tab}"]`);
    await page.keyboard.press('Enter');
    await page.waitForSelector(`[data-page="${tab}"]`);
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
  if (await page.$('.aiide-welcome'))
    await click('Open engineering workspace →');
  await page.waitForSelector('.aiide-tabs [data-tab="Knowledge"]');
  await navigate('Knowledge');
  await field('Page title', 'Acceptance decision');
  await field('Markdown', 'Keep independent evaluation seeds.');
  // Leaving a dirty editor requires a real decision; rejecting preserves the draft.
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.click('.aiide-tabs [data-tab="Voice"]');
  assert.ok(await page.$('[data-page="Knowledge"]'));
  await click('Save page');
  await page.waitForFunction(() => document.body.textContent.includes('ID:'));
  assert.equal(
    fs
      .readdirSync(path.join(root, '.aiide-memory'))
      .filter((file) => file.endsWith('.md')).length,
    1,
  );
  await click('Attach to assistant');
  await page.waitForSelector('[data-page="Assistant"]');
  assert.match(
    await page.$eval('[data-page="Assistant"]', (node) => node.textContent),
    /Acceptance decision/,
  );
  await field('What would you like to do?', 'Preserve my unsent request');
  await navigate('Voice');
  await field('Voice agent model', 'voice-fixture');
  await field('Your turn', 'How should I evaluate this policy?');
  await click('Send turn →');
  await page.waitForFunction(() =>
    document
      .querySelector('[aria-label="Voice transcript"]')
      ?.textContent.includes('Fixture reply:'),
  );
  await click('Save to project memory');
  await page.waitForFunction(() =>
    document.body.textContent.includes('Saved a snapshot'),
  );
  assert.equal(
    fs
      .readdirSync(path.join(root, '.aiide-memory'))
      .filter((file) => file.endsWith('.md')).length,
    2,
  );
  await navigate('Assistant');
  await page.waitForFunction(
    () =>
      document.querySelector(
        '[placeholder="Explain this trace, fix a failing test, or build a feature…"]',
      )?.value === 'Preserve my unsent request',
  );
  await field('Coding model', 'voice-fixture');
  await click('Send request →');
  await page.waitForFunction(() =>
    document
      .querySelector('[aria-label="Assistant response"]')
      ?.textContent.includes('Fixture reply:'),
  );
  await navigate('Models');
  await navigate('Assistant');
  await page.waitForFunction(() =>
    document
      .querySelector('[aria-label="Assistant response"]')
      ?.textContent.includes('Fixture reply:'),
  );
  assert.equal(
    fs
      .readdirSync(path.join(root, '.aiide/assistant'))
      .filter((file) => file.endsWith('.json')).length,
    1,
  );
  await navigate('Sandboxes');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(
      (button) =>
        button.textContent.trim() === 'Create sandbox' && !button.disabled,
    ),
  );
  await click('Create sandbox');
  await field(
    'Container command',
    "python -c \"open('sandbox-check.txt','w').write('reviewed')\"",
  );
  await click('Run in sandbox');
  await page.waitForFunction(() =>
    document
      .querySelector(
        '[data-page="Sandboxes"] [aria-label="Sandbox command status"]',
      )
      ?.textContent.includes('completed'),
  );
  assert.equal(fs.existsSync(path.join(root, 'sandbox-check.txt')), false);
  await click('Review diff');
  await click('Apply reviewed changes');
  await page.waitForFunction(
    () => !document.querySelector('[data-page="Sandboxes"] .aiide-diff'),
  );
  assert.equal(
    fs.readFileSync(path.join(root, 'sandbox-check.txt'), 'utf8'),
    'reviewed',
  );
  await navigate('RL');
  await field('Training episodes', '1000');
  await click('Train policy');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-page="RL"] table')
        ?.textContent.includes('gridworld'),
    { timeout: 30000 },
  );
  await click('Inspect policy');
  await click('Run policy');
  await page.waitForSelector('[aria-label^="Policy rollout at step"]');
  assert.equal(
    await page.$$eval(
      '.aiide-rl-grid [data-state="agent"]',
      (nodes) => nodes.length,
    ),
    1,
  );
  await page.focus('[data-page="RL"] input[type="range"]');
  await page.keyboard.press('End');
  await page.waitForFunction(() => {
    const slider = document.querySelector(
      '[data-page="RL"] input[type="range"]',
    );
    return slider.value === slider.max;
  });
  assert.equal(
    await page.$$eval(
      '.aiide-rl-grid span',
      (nodes) => nodes.at(-1).dataset.state,
    ),
    'agent',
  );
  await page.$eval('[aria-label^="Policy rollout at step"]', (node) =>
    node.scrollIntoView({ block: 'center' }),
  );
  await page.screenshot({
    path: path.join(os.tmpdir(), 'aiide-product-rl.png'),
    fullPage: true,
  });
  assert.ok(fs.readdirSync(path.join(root, 'rl-policies')).length);
  assert.equal(await page.$('.aiide-error'), null);
  await navigate('Knowledge');
  await page.waitForFunction(() =>
    document
      .querySelector('[data-page="Knowledge"]')
      ?.textContent.includes('Acceptance decision'),
  );
  assert.match(
    await page.$eval('[data-page="Knowledge"]', (node) => node.textContent),
    /Acceptance decision/,
  );
  await click('Acceptance decision');
  assert.equal(
    await page.$eval('textarea[rows="16"]', (node) => node.value),
    'Keep independent evaluation seeds.',
  );
  await navigate('Models');
  await field('Search workspace', 'Acceptance decision');
  await page.waitForSelector('[aria-label="Search results"] button');
  await page.focus('[aria-label="Search results"] button');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-page="Knowledge"] label')]
        .find((node) => node.textContent.trim().startsWith('Page title'))
        ?.querySelector('input')?.value === 'Acceptance decision',
  );
  await navigate('Share');
  await field('Additional files or model artifacts', 'sandbox-check.txt');
  await click('Preview export');
  await click('Export reviewed ZIP');
  await page.waitForFunction(() =>
    document
      .querySelector('[data-page="Share"]')
      ?.textContent.includes('Created .aiide/bundles/'),
  );
  const bundle = fs
    .readdirSync(path.join(root, '.aiide/bundles'))
    .find((file) => file.endsWith('.zip'));
  assert.ok(bundle);
  await field('Bundle ZIP path', '.aiide/bundles/' + bundle);
  await field('New project folder', 'imported-artifacts');
  await click('Inspect bundle');
  await click('Import as new project');
  await page.waitForFunction(() =>
    document
      .querySelector('[data-page="Share"]')
      ?.textContent.includes('Imported to'),
  );
  assert.equal(
    fs.readFileSync(
      path.join(root, 'imported-artifacts/sandbox-check.txt'),
      'utf8',
    ),
    'reviewed',
  );
  assert.deepEqual(
    core.loadProject(path.join(root, 'imported-artifacts')).commands,
    {},
  );
  console.log(
    'PASS: actual Theia UI/RPC, memory, voice-to-memory, assistant history/drafts, Docker sandbox review/apply, RL training/rollout, global search, reviewed ZIP sharing and dirty-edit guard',
  );
} catch (error) {
  if (page)
    console.error(
      'Visible UI:',
      await page
        .$eval('.aiide', (node) => node.textContent)
        .catch(() => 'unavailable'),
    );
  console.error(
    'Browser backend log:',
    fs.readFileSync(logPath, 'utf8').slice(-5000),
  );
  throw error;
} finally {
  await browser?.close();
  try {
    process.kill(-backend.pid, 'SIGTERM');
  } catch {}
  if (backend.exitCode === null)
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          process.kill(-backend.pid, 'SIGKILL');
        } catch {}
        resolve();
      }, 5000);
      backend.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  await new Promise((resolve) => model.close(resolve));
  fs.rmSync(directory, {
    force: true,
    recursive: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
