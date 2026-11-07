import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer';
import { Entry } from '@napi-rs/keyring';
import core from '../packages/core/lib/index.js';
import { wandbFixture } from './fixtures/wandb-server.mjs';
import { sshFixture } from './fixtures/ssh-server.mjs';
const { Workspace, saveProject } = core;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-training-ui-')),
  project = path.join(root, 'project');
fs.mkdirSync(project);
let browser, backend, ssh, workspace, credential;
const fixture = await wandbFixture();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const python =
    process.env.AIIDE_TRAIN_TEST_PYTHON ||
    path.resolve('templates/finetune/.venv/bin/python');
  fs.copyFileSync('templates/pytorch/main.py', path.join(project, 'main.py'));
  saveProject(project, {
    version: 1,
    name: 'Training acceptance',
    environment: { python },
    commands: {
      train: ['python', 'main.py'],
      remote: ['python', 'remote-train.py'],
    },
    training: { framework: 'pytorch', resume: true },
  });
  ssh = sshFixture(root);
  workspace = await Workspace.open(project);
  workspace.training.ssh.save(ssh.profile);
  await workspace.wandb.install();
  await workspace.close();
  workspace = undefined;
  const log = fs.openSync('/tmp/aiide-training-ui-server.log', 'w');
  const electron = process.env.AIIDE_ELECTRON_EXECUTABLE;
  backend = spawn(
    electron || 'node',
    electron
      ? [project, '--remote-debugging-port=9225', '--hostname=127.0.0.1']
      : [
          'apps/browser/lib/backend/main.js',
          project,
          '--port=3092',
          '--hostname=127.0.0.1',
        ],
    {
      cwd: process.cwd(),
      env: { ...process.env, THEIA_CONFIG_DIR: path.join(root, 'theia') },
      stdio: ['ignore', log, log],
      detached: true,
    },
  );
  fs.closeSync(log);
  const endpoint = electron ? 'http://127.0.0.1:9225' : 'http://127.0.0.1:3092';
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(endpoint + (electron ? '/json/version' : ''))).ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(200);
  }
  assert.ok(ready, 'Theia did not start');
  browser = electron
    ? await puppeteer.connect({ browserURL: endpoint, defaultViewport: null })
    : await puppeteer.launch({
        headless: true,
        executablePath:
          process.env.CHROME_PATH ||
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        defaultViewport: { width: 1440, height: 1100 },
        args: ['--no-sandbox'],
      });
  let page;
  if (electron) {
    for (let i = 0; i < 100; i++) {
      page = (await browser.pages()).find((p) =>
        p.url().includes('index.html'),
      );
      if (page) break;
      await delay(200);
    }
    assert.ok(page, 'Electron frontend did not open');
  } else page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const click = async (text, selector = 'button') => {
    await page.waitForFunction(
      (text, selector) =>
        [...document.querySelectorAll(selector)].some(
          (e) => e.textContent.includes(text) && !e.disabled,
        ),
      {},
      text,
      selector,
    );
    await page.evaluate(
      (text, selector) =>
        [...document.querySelectorAll(selector)]
          .find((e) => e.textContent.includes(text) && !e.disabled)
          .click(),
      text,
      selector,
    );
  };
  const field = async (label, value) => {
    const element = (
      await page.evaluateHandle(
        (label) =>
          [...document.querySelectorAll('.aiide label')]
            .find(
              (e) =>
                [...e.childNodes]
                  .filter((n) => n.nodeType === Node.TEXT_NODE)
                  .map((n) => n.textContent)
                  .join('')
                  .trim() === label,
            )
            ?.querySelector('input,textarea,select') ||
          [...document.querySelectorAll('.aiide label')]
            .find((e) => e.textContent.trim().startsWith(label))
            ?.querySelector('input,textarea,select'),
        label,
      )
    ).asElement();
    assert.ok(element, 'Missing form label: ' + label);
    const tag = await element.evaluate((e) => e.tagName);
    if (tag === 'SELECT') await element.select(value);
    else {
      await element.evaluate((e, value) => {
        const prototype =
          e.tagName === 'TEXTAREA'
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(e, value);
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
      }, value);
    }
    await element.dispose();
  };
  if (!electron) await page.goto(endpoint, { waitUntil: 'networkidle2' });
  await page.waitForSelector('[id="shell-tab-aiide.workbench"]');
  await page.click('[id="shell-tab-aiide.workbench"]');
  await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .find((e) => e.textContent.includes('Yes, I trust'))
      ?.click(),
  );
  await page.waitForSelector('.aiide-welcome, .aiide-tabs');
  if (await page.$('.aiide-welcome')) await click('Open engineering workspace');
  await page.waitForSelector('.aiide-tabs');
  await page.evaluate(() =>
    document.querySelector('.aiide-tabs [data-tab="Training"]').click(),
  );
  await field('Training command', 'train');
  await field('Training parameters', '{"steps":10,"checkpoint_every":10}');
  await click('Start training');
  await page.waitForFunction(
    () =>
      document
        .querySelector('.aiide-main')
        ?.textContent.includes('Job status: completed'),
    { timeout: 60000 },
  );
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('button')].some((e) =>
        e.textContent.includes('Inspect checkpoint'),
      ),
    { timeout: 30000 },
  );
  const first = await page
    .$eval('.aiide label select', (e) => e.value)
    .catch(() => '');
  await click('Inspect checkpoint');
  await click('Use this checkpoint for resume');
  await field('Training parameters', '{"steps":14,"checkpoint_every":2}');
  await click('Launch resumed training');
  await page.waitForFunction(
    () =>
      document
        .querySelector('.aiide-main')
        ?.textContent.includes('Job status: completed'),
    { timeout: 60000 },
  );
  await page.waitForFunction(
    () =>
      document
        .querySelector('.aiide-main')
        ?.textContent.includes('checkpoints/step-14'),
    { timeout: 30000 },
  );
  await page.$eval('.aiide-metric-grid', (e) =>
    e.scrollIntoView({ block: 'center' }),
  );
  await page.screenshot({
    path: '/tmp/aiide-training-workspace.png',
    fullPage: true,
  });
  console.log(
    'PASS: Training UI → real PyTorch → metrics → checkpoint inspection → resumed run',
  );

  await field('Training command', 'remote');
  await field('Execution target', 'ssh');
  await field('SSH profile', 'fixture');
  await field('Training parameters', '{"steps":10,"delay":0.1}');
  await click('Start training');
  await page.waitForFunction(
    () =>
      document
        .querySelector('.aiide-main')
        ?.textContent.includes('SSH: connected'),
    { timeout: 30000 },
  );
  await page.waitForFunction(
    () =>
      document
        .querySelector('.aiide-main')
        ?.textContent.includes('remote: completed'),
    { timeout: 30000 },
  );
  await page.waitForFunction(
    () =>
      document
        .querySelector('.aiide-main')
        ?.textContent.includes('result.json') &&
      document
        .querySelector('.aiide-metric-grid')
        ?.textContent.includes('loss'),
    { timeout: 30000 },
  );
  console.log(
    'PASS: Training UI → SSH backend → Linux job → replayed metrics/status',
  );

  await click('Weights & Biases', 'summary');
  await click('Configure W&B access', 'summary');
  await field('W&B connection name', 'fixture-wandb');
  await field('W&B API URL', fixture.url);
  await field('W&B API key', fixture.secret);
  await click('Save W&B connection');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('option')].some(
      (e) => e.value === 'fixture-wandb',
    ),
  );
  credential = JSON.parse(
    fs.readFileSync(path.join(project, '.aiide/connections.json'), 'utf8'),
  ).find((c) => c.id === 'fixture-wandb').credentialRef;
  await field('W&B connection', 'fixture-wandb');
  await field('W&B entity/project', 'fixture/training');
  await click('Load W&B runs');
  await click('Inspect W&B run');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="wandb-panel"]')
        ?.textContent.includes('500 rows'),
    { timeout: 30000 },
  );
  await click('Browse W&B artifact');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="wandb-panel"]')
        ?.textContent.includes('checkpoint.json'),
    { timeout: 30000 },
  );
  await click('Next history window');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="wandb-panel"]')
        ?.textContent.includes('250 rows'),
    { timeout: 30000 },
  );
  assert.deepEqual(errors, []);
  assert.ok(
    !(await page.evaluate(() =>
      document.body.textContent.includes('do-not-display'),
    )),
  );
  console.log(
    'PASS: W&B UI → actual SDK → HTTP fixture → history charts and artifact file browser',
  );
} catch (error) {
  if (browser) {
    const page = (await browser.pages()).at(-1);
    console.error(await page.$eval('body', (e) => e.innerText));
    await page.screenshot({ path: '/tmp/aiide-training-ui-failure.png' });
  }
  throw error;
} finally {
  if (browser) await browser.close();
  if (backend) {
    try {
      process.kill(-backend.pid, 'SIGTERM');
    } catch {}
    await delay(1000);
  }
  if (workspace) await workspace.close();
  if (ssh) ssh.close();
  try {
    if (credential) {
      const electron = process.env.AIIDE_ELECTRON_EXECUTABLE;
      if (electron && process.platform === 'darwin') {
        // The backend helper owns its Keychain items; Node cannot delete them.
        const helper = path.join(
          path.dirname(path.dirname(electron)),
          'Frameworks/AI Engineering IDE Helper.app/Contents/MacOS/AI Engineering IDE Helper',
        );
        execFileSync(
          helper,
          [
            '-e',
            "new (require('@napi-rs/keyring').Entry)('aiide', process.argv[1]).deletePassword()",
            credential,
          ],
          {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            timeout: 10000,
          },
        );
      } else new Entry('aiide', credential).deletePassword();
    }
  } finally {
    await fixture.close();
  }
  if (process.env.AIIDE_KEEP_TEST_DATA) console.log('Test data:', root);
  else fs.rmSync(root, { recursive: true, force: true });
}
