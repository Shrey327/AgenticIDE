import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import puppeteer from 'puppeteer';
import core from '../packages/core/lib/index.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-wiki-graph-ui-'));
fs.writeFileSync(path.join(root, 'decision.md'), 'Original decision');
const memory = new core.Knowledge(root, {});
const target = memory.save({
  title: 'API <contract>',
  body: 'Saved contract body',
  sources: [{ file: 'decision.md', hash: core.hash('Original decision') }],
});
const selected = memory.save({
  title: 'Design',
  body: `[[${target.id}]] [[missing-page]]`,
});
memory.save({ title: 'Runbook', body: `[[${selected.id}]]` });
fs.writeFileSync(path.join(root, 'decision.md'), 'Changed decision');
const bundle = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'tsx',
    contents: `
 import React from'react';import{createRoot}from'react-dom/client';
 import{KnowledgePanel}from'./packages/theia-extension/src/browser/knowledge-panel.tsx';
 const call=async(operation,args={})=>{const response=await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,args})});const data=await response.json();if(!response.ok)throw new Error(data.error);return data;};
 const perform=async action=>{try{await action();}catch(error){window.failure=String(error);}};
 function App(){const[initial,setInitial]=React.useState(${JSON.stringify(selected.id)});window.navigateInitial=setInitial;return <KnowledgePanel call={call} perform={perform} connections={[]} attach={()=>{}} initialId={initial}/>;} createRoot(document.getElementById('root')).render(<App/>);
 `,
  },
  bundle: true,
  write: false,
  platform: 'browser',
  alias: { '@theia/core/shared/react': 'react' },
});
const requests = [];
let heldGet;
const holdGet = (id) => {
  let release, arrived;
  const pending = new Promise((resolve) => {
      release = resolve;
    }),
    started = new Promise((resolve) => {
      arrived = resolve;
    });
  heldGet = { id, pending, arrived };
  return { release, started };
};
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<style>body{font:13px sans-serif}button{font:inherit}</style><main class="aiide" id="root"></main><script>' +
          bundle.outputFiles[0].text +
          '</script>',
      );
      return;
    }
    let text = '';
    for await (const chunk of req) text += chunk;
    const { operation, args } = JSON.parse(text);
    requests.push(operation);
    if (operation === 'knowledge.get' && heldGet?.id === args.id) {
      const held = heldGet;
      heldGet = undefined;
      held.arrived();
      await held.pending;
    }
    const routes = {
      'knowledge.list': () => memory.list(args.query),
      'knowledge.get': () => memory.get(args.id),
      'knowledge.graph': () => memory.graph(args.id),
      'knowledge.maintenance': () => memory.maintenanceStatus(),
    };
    if (!routes[operation])
      throw new Error('Unexpected operation ' + operation);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(await routes[operation]()));
  } catch (error) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: String(error) }));
  }
});
let browser;
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
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
  await page.setViewport({ width: 1100, height: 900 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const label = async (text, tag) =>
    (
      await page.evaluateHandle(
        (text, tag) =>
          [...document.querySelectorAll('label')]
            .find((node) => node.textContent.trim().startsWith(text))
            .querySelector(tag),
        text,
        tag,
      )
    ).asElement();
  const node = (id) => `[data-note-node="${id}"]`;
  await page.waitForSelector(node(target.id));
  assert.equal(
    await page.$eval(node('missing-page'), (button) => button.disabled),
    true,
  );
  assert.match(
    await page.$eval(node(target.id), (button) =>
      button.getAttribute('aria-label'),
    ),
    /Source changed/,
  );
  assert.equal(
    await page.$('section[aria-label="Saved memory link map"] img'),
    null,
    'titles must be rendered as text',
  );
  assert.equal(
    await page.$$eval('svg path[marker-end]', (paths) => paths.length),
    3,
  );
  await page.$eval('section[aria-label="Saved memory link map"]', (element) =>
    element.scrollIntoView(),
  );
  await (
    await page.$('section[aria-label="Saved memory link map"]')
  ).screenshot({ path: '/private/tmp/aiide-wiki-graph.png' });
  await page.focus(node(target.id));
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    (title) =>
      [...document.querySelectorAll('label')]
        .find((node) => node.textContent.trim().startsWith('Page title'))
        .querySelector('input').value === title,
    {},
    target.title,
  );
  await page.waitForSelector(`${node(target.id)}[aria-current="page"]`);
  const textarea = await label('Markdown', 'textarea');
  await textarea.evaluate((node) => node.select());
  await textarea.type('Unsaved graph navigation draft');
  await page.waitForFunction(
    (id) => document.querySelector(`[data-note-node="${id}"]`)?.disabled,
    {},
    selected.id,
  );
  await page.$eval(node(selected.id), (button) => button.click());
  assert.equal(
    await (await label('Markdown', 'textarea')).evaluate((node) => node.value),
    'Unsaved graph navigation draft',
  );
  assert.equal(
    await (await label('Page title', 'input')).evaluate((node) => node.value),
    target.title,
  );
  await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === 'Refresh link map')
      .click(),
  );
  await page.waitForNetworkIdle({ idleTime: 100, timeout: 5000 });
  await page.waitForSelector(node(selected.id));
  assert.equal(
    await (await label('Markdown', 'textarea')).evaluate((node) => node.value),
    'Unsaved graph navigation draft',
  );
  assert.equal(memory.get(target.id).body, 'Saved contract body');
  await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === 'Discard edits')
      .click(),
  );
  await page.waitForFunction(
    (id) => {
      const node = document.querySelector(`[data-note-node="${id}"]`);
      return Boolean(node && !node.disabled);
    },
    {},
    selected.id,
  );
  await page.focus(node(selected.id));
  await page.keyboard.press('Space');
  await page.waitForSelector(`${node(selected.id)}[aria-current="page"]`);
  assert.equal(
    await (await label('Page title', 'input')).evaluate((node) => node.value),
    selected.title,
  );
  const delayed = holdGet(target.id);
  await page.evaluate((id) => window.navigateInitial(id), target.id);
  await delayed.started;
  await (await label('Markdown', 'textarea')).evaluate((node) => node.select());
  await (
    await label('Markdown', 'textarea')
  ).type('Editing the loaded page while navigation waits');
  delayed.release();
  await page.waitForNetworkIdle({ idleTime: 100, timeout: 5000 });
  assert.equal(
    await (await label('Page title', 'input')).evaluate((node) => node.value),
    selected.title,
  );
  assert.equal(
    await (await label('Markdown', 'textarea')).evaluate((node) => node.value),
    'Editing the loaded page while navigation waits',
  );
  await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === 'Discard edits')
      .click(),
  );
  const initial = holdGet(selected.id);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await initial.started;
  await (await label('Page title', 'input')).type('New draft before loading');
  await (
    await label('Markdown', 'textarea')
  ).type('A late initial response must not replace this draft');
  initial.release();
  await page.waitForNetworkIdle({ idleTime: 100, timeout: 5000 });
  assert.equal(
    await (await label('Page title', 'input')).evaluate((node) => node.value),
    'New draft before loading',
  );
  assert.equal(
    await (await label('Markdown', 'textarea')).evaluate((node) => node.value),
    'A late initial response must not replace this draft',
  );
  assert.equal(await page.evaluate(() => window.failure), undefined);
  assert.deepEqual(errors, []);
  assert.ok(requests.includes('knowledge.graph'));
  assert.ok(requests.every((operation) => operation.startsWith('knowledge.')));
  console.log(
    'PASS: actual saved-note graph API → SVG/native keyboard nodes → missing/stale markers → Enter/Space navigation; dirty draft and persisted note survive blocked navigation, map refresh, and delayed initial/current-page navigation responses.',
  );
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await memory.close();
  fs.rmSync(root, { recursive: true, force: true });
}
