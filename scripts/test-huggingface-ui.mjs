import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

// Uses weights already downloaded by test-huggingface; never downloads a second copy.
const workspace = path.resolve(
  process.env.AIIDE_HF_UI_WORKSPACE || 'artifacts/qwen-smoke/workspace',
);
assert.ok(
  fs.existsSync(path.join(workspace, '.aiide/project.yaml')),
  'Run the Qwen backend smoke test first or set AIIDE_HF_UI_WORKSPACE',
);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-hf-ui-'));
const logPath = path.join(temporary, 'server.log');
const log = fs.openSync(logPath, 'w');
const endpoint = 'http://127.0.0.1:3095';
const backend = spawn(
  'node',
  [
    'apps/browser/lib/backend/main.js',
    workspace,
    '--port=3095',
    '--hostname=127.0.0.1',
  ],
  {
    cwd: process.cwd(),
    env: { ...process.env, THEIA_CONFIG_DIR: path.join(temporary, 'theia') },
    stdio: ['ignore', log, log],
    detached: true,
  },
);
fs.closeSync(log);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser, page;
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(endpoint)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(200);
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
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(endpoint, { waitUntil: 'networkidle2' });
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
  await page.waitForSelector('.aiide-tabs');
  const navigate = async (tab) => {
    await page.focus(`.aiide-tabs [data-tab="${tab}"]`);
    await page.keyboard.press('Enter');
    await page.waitForSelector(
      `.aiide-tabs [data-tab="${tab}"][aria-current="page"]`,
    );
  };
  await navigate('Finetune');
  await page.waitForFunction(
    () =>
      document
        .querySelector('.aiide-main')
        ?.textContent.includes('Ready · available hardware:'),
    { timeout: 30000 },
  );
  const select = (
    await page.evaluateHandle(() =>
      [...document.querySelectorAll('.aiide label')]
        .find((node) =>
          node.textContent.trim().startsWith('Downloaded model or adapter'),
        )
        ?.querySelector('select'),
    )
  ).asElement();
  const adapter = await select.evaluate(
    (node) =>
      [...node.options].find((option) => option.textContent.includes('LoRA'))
        ?.value,
  );
  assert.ok(adapter, 'Smoke-test workspace must contain a fine-tuned adapter');
  await select.select(adapter);
  await select.dispose();
  await page.evaluate(() => {
    const input = [...document.querySelectorAll('.aiide label')]
      .find((node) => node.textContent.trim().startsWith('Maximum new tokens'))
      .querySelector('input');
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    ).set.call(input, '16');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const outputs = path.join(workspace, '.aiide/hf-results');
  const before = new Set(fs.existsSync(outputs) ? fs.readdirSync(outputs) : []);
  const generate = (
    await page.evaluateHandle(() =>
      [...document.querySelectorAll('.aiide button')].find(
        (node) => node.textContent.trim() === 'Generate locally',
      ),
    )
  ).asElement();
  assert.equal(await generate.evaluate((node) => node.disabled), false);
  await generate.click();
  await generate.dispose();
  let newFiles = [];
  for (let attempt = 0; attempt < 600; attempt++) {
    newFiles = (fs.existsSync(outputs) ? fs.readdirSync(outputs) : []).filter(
      (file) => !before.has(file),
    );
    if (newFiles.length) break;
    await delay(200);
  }
  assert.equal(
    newFiles.length,
    1,
    'UI generation must persist exactly one new result',
  );
  const result = JSON.parse(
    fs.readFileSync(path.join(outputs, newFiles[0]), 'utf8'),
  );
  await page.waitForFunction(
    (text) =>
      document.querySelector('.aiide-main [role="status"] pre')?.textContent ===
      text,
    { timeout: 30000 },
    result.text,
  );
  const response = await page.$eval(
    '.aiide-main [role="status"] pre',
    (node) => node.textContent,
  );
  assert.ok(response.trim(), 'Real adapter inference must produce text');
  assert.equal(result.text, response);
  assert.ok(result.tokens > 0);
  await navigate('Runs');
  await navigate('Finetune');
  await page.waitForFunction(
    (response) =>
      document.querySelector('.aiide-main [role="status"] pre')?.textContent ===
      response,
    { timeout: 30000 },
    response,
  );
  await page.$eval('.aiide-main [role="status"] pre', (node) =>
    node.scrollIntoView({ block: 'center' }),
  );
  fs.mkdirSync('artifacts/usability', { recursive: true });
  await page.screenshot({
    path: 'artifacts/usability/qwen-inference.png',
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    `PASS: real Qwen LoRA UI inference, ${result.tokens} tokens on ${result.device}; response persists across navigation`,
  );
} catch (error) {
  if (page) {
    console.error(await page.$eval('body', (node) => node.innerText));
    await page.screenshot({
      path: '/tmp/aiide-hf-ui-failure.png',
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
  fs.rmSync(temporary, { recursive: true, force: true });
}
