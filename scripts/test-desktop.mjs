import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import electron from 'electron';
import puppeteer from 'puppeteer';
import core from '../packages/core/lib/index.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-desktop-test-'));
const root = path.join(directory, 'project');
fs.mkdirSync(root);
core.saveProject(root, {
  version: 1,
  name: 'Desktop acceptance',
  environment: { python: 'python3' },
  commands: { example: ['python', 'main.py'] },
});
fs.writeFileSync(
  path.join(root, 'main.py'),
  'from aiide_sdk import span, metric, flush\nwith span("example.pipeline"):\n    with span("example.child"):\n        metric("result", 1)\nflush()\n',
);
const profile = path.join(directory, 'electron');
fs.mkdirSync(profile);
const launcher = path.join(directory, 'launch.cjs');
fs.writeFileSync(
  launcher,
  `require('electron').app.setPath('userData', ${JSON.stringify(profile)}); import(${JSON.stringify(pathToFileURL(path.resolve('apps/desktop/lib/backend/electron-main.js')).href)});\n`,
);
const listener = net.createServer();
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const logPath = path.join(directory, 'electron.log');
const log = fs.openSync(logPath, 'w');
const env = { ...process.env, THEIA_CONFIG_DIR: path.join(directory, 'theia') };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  electron,
  [
    launcher,
    root,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
  ],
  { env, detached: true, stdio: ['ignore', log, log] },
);
fs.closeSync(log);
let browser;
try {
  const endpoint = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try {
      const targets = await (await fetch(endpoint + '/json/list')).json();
      if (
        targets.some(
          (target) =>
            target.type === 'page' && /^(https?|file):/.test(target.url),
        )
      ) {
        ready = true;
        break;
      }
    } catch {}
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(ready, fs.readFileSync(logPath, 'utf8').slice(-4000));
  const result = await promisify(execFile)(
    process.execPath,
    ['scripts/test-ui.mjs'],
    {
      env: { ...env, AIIDE_ELECTRON_URL: endpoint },
      timeout: 90000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  browser = await puppeteer.connect({ browserURL: endpoint });
  const page = (await browser.pages()).find((page) =>
    /^(https?|file):/.test(page.url()),
  );
  assert.ok(page);
  for (const tab of [
    'Knowledge',
    'Voice',
    'RL',
    'Sandboxes',
    'Share',
    'Documents',
    'Evidence',
  ]) {
    await page.focus(`.aiide-tabs [data-tab="${tab}"]`);
    await page.keyboard.press('Enter');
    await page.waitForSelector(`[data-page="${tab}"]`);
    assert.equal(await page.$('.aiide-error'), null);
  }
  console.log(
    'PASS: isolated native Electron launch, local Python→Collector→SQLite→trace, and new desktop panels',
  );
} catch (error) {
  console.error(fs.readFileSync(logPath, 'utf8').slice(-5000));
  throw error;
} finally {
  browser?.disconnect();
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
  if (child.exitCode === null)
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  fs.rmSync(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
