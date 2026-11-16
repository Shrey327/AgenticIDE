import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import puppeteer from 'puppeteer';
import core from '../packages/core/lib/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-memory-ui-'));
fs.mkdirSync(path.join(root, '.aiide'));
fs.writeFileSync(path.join(root, 'design.md'), 'Use local storage.');
const { outputFiles } = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'tsx',
    contents: `
  import React from 'react'; import { createRoot } from 'react-dom/client';
  import { KnowledgePanel } from './packages/theia-extension/src/browser/knowledge-panel.tsx';
  const call = async (operation,args={}) => { const response = await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,args})}); const result=await response.json(); if(!response.ok) throw new Error(result.error); return result; };
  const perform = async action => { try {await action();} catch(error){window.failure=String(error);} };
  createRoot(document.getElementById('root')).render(<KnowledgePanel call={call} perform={perform} connections={[{id:'local',kind:'model',model:'fixture'}]} attach={()=>{}} />);
`,
  },
  bundle: true,
  write: false,
  platform: 'browser',
  alias: { '@theia/core/shared/react': 'react' },
});
let memory;
const server = http.createServer(async (request, response) => {
  try {
    if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        '<main class="aiide" id="root"></main><script>' +
          outputFiles[0].text +
          '</script>',
      );
      return;
    }
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/chat/completions') {
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  body: 'Use remote storage (design.md).',
                  summary: 'Storage changed.',
                  conflicts: [
                    {
                      existing: 'Use local storage.',
                      proposed: 'Use remote storage.',
                      source: 'design.md',
                    },
                  ],
                }),
              },
            },
          ],
        }),
      );
      return;
    }
    const a = body.args;
    const routes = {
      'knowledge.list': () => memory.list(a.query),
      'knowledge.get': () => memory.get(a.id),
      'knowledge.graph': () => memory.graph(a.id),
      'knowledge.import': () => memory.importSources(a),
      'knowledge.save': () => memory.save(a),
      'knowledge.refresh': () => memory.refresh(a),
      'knowledge.maintenance': () => memory.maintenanceStatus(),
      'knowledge.proposals': () => memory.proposals(),
      'knowledge.configureMaintenance': () => memory.configureMaintenance(a),
      'knowledge.scan': () => memory.scan(),
      'knowledge.applyProposal': () => memory.applyProposal(a),
      'knowledge.discardProposal': () => memory.discardProposal(a.id),
      'knowledge.history': () => memory.history(a.id),
      'knowledge.restore': () => memory.restore(a),
      'knowledge.delete': () => memory.delete(a.id, a.revision),
    };
    if (!routes[body.operation]) throw new Error('Unsupported test operation');
    response.end(JSON.stringify(await routes[body.operation]()));
  } catch (error) {
    response.statusCode = 400;
    response.end(JSON.stringify({ error: String(error) }));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const connections = new core.Connections(path.join(root, '.aiide'));
await connections.save({
  id: 'local',
  kind: 'model',
  model: 'fixture',
  url: url + '/v1',
});
memory = new core.Knowledge(root, connections);
let browser;
try {
  browser = await puppeteer.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      (process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : undefined),
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const click = async (text) => {
    await page.waitForFunction(
      (text) =>
        [...document.querySelectorAll('button')].some(
          (node) =>
            node.textContent.trim() === text && !node.matches(':disabled'),
        ),
      {},
      text,
    );
    await page.evaluate(
      (text) =>
        [...document.querySelectorAll('button')]
          .find(
            (node) =>
              node.textContent.trim() === text && !node.matches(':disabled'),
          )
          .click(),
      text,
    );
  };
  const field = async (label, value) =>
    page.evaluate(
      (label, value) => {
        const node = [...document.querySelectorAll('label')]
          .find((node) => node.textContent.trim().startsWith(label))
          ?.querySelector('input,textarea,select');
        if (!node) throw new Error('Missing ' + label);
        const proto =
          node.tagName === 'TEXTAREA'
            ? HTMLTextAreaElement.prototype
            : node.tagName === 'SELECT'
              ? HTMLSelectElement.prototype
              : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, value);
        node.dispatchEvent(
          new Event(node.tagName === 'SELECT' ? 'change' : 'input', {
            bubbles: true,
          }),
        );
      },
      label,
      value,
    );
  const checkbox = async (label) => {
    await page.waitForFunction(
      (label) => {
        const node = [...document.querySelectorAll('label')]
          .find((node) => node.textContent.trim().startsWith(label))
          ?.querySelector('input');
        return node && !node.matches(':disabled');
      },
      {},
      label,
    );
    await page.evaluate(
      (label) =>
        [...document.querySelectorAll('label')]
          .find((node) => node.textContent.trim().startsWith(label))
          .querySelector('input')
          .click(),
      label,
    );
  };
  await page.goto(url);
  await page.waitForSelector('textarea[rows="16"]');
  await field('Draft title', 'Storage decision');
  await field('Workspace text files', 'design.md');
  await click('Import sources without a model');
  await page.waitForFunction(() =>
    document
      .querySelector('textarea[rows="16"]')
      ?.value.includes('Use local storage.'),
  );
  const note = memory.list()[0];
  fs.writeFileSync(path.join(root, 'design.md'), 'Use remote storage.');
  await field('Maintenance model', 'local');
  await checkbox('Scan linked sources automatically');
  await checkbox('Generate review proposals automatically');
  await click('Save maintenance settings');
  await click('Scan now');
  await page.waitForFunction(() =>
    document.body.textContent.includes('1 flagged conflict(s)'),
  );
  assert.match(memory.get(note.id).body, /Use local storage/);
  await page.evaluate(() =>
    [...document.querySelectorAll('summary')]
      .find((node) => node.textContent.includes('flagged conflict'))
      .click(),
  );
  await checkbox('I reviewed the draft');
  await click('Apply reviewed revision');
  await page.waitForFunction(
    () =>
      document.querySelector('textarea[rows="16"]')?.value ===
      'Use remote storage (design.md).',
  );
  assert.equal(memory.get(note.id).sources[0].status, 'current');
  await page.evaluate(() =>
    [...document.querySelectorAll('summary')]
      .find((node) => node.textContent === 'Recover a previous or deleted page')
      .click(),
  );
  await click('Load revision history');
  await page.waitForFunction(
    () => document.querySelectorAll('select option').length > 5,
  );
  await field('Saved version', note.revision);
  await click('Restore selected version');
  await page.waitForFunction(() =>
    document
      .querySelector('textarea[rows="16"]')
      ?.value.includes('Use local storage.'),
  );
  assert.match(memory.get(note.id).body, /Use local storage/);
  assert.equal(await page.evaluate(() => window.failure), undefined);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: real memory UI → source import → automatic scan → HTTP model proposal → conflict review/apply → revision restore',
  );
} finally {
  await browser?.close();
  await memory.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
