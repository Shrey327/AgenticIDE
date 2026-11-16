import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import puppeteer from 'puppeteer';
import core from '../packages/core/lib/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-eval-ui-'));
core.saveProject(root, {
  version: 1,
  name: 'Regression UI',
  telemetry: { captureContent: true },
});
const store = new core.Store(path.join(root, '.aiide/test.sqlite'), true);
fs.writeFileSync(
  path.join(root, 'cases.jsonl'),
  '{"input":"Capital of France?","expected":"Paris"}\n',
);
let evals, data, run;
const { outputFiles } = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'tsx',
    contents: `
import React from 'react';import{createRoot}from'react-dom/client';
import{EvalRegressionPanel}from'./packages/theia-extension/src/browser/eval-regression-panel.tsx';
import{TracePanel}from'./packages/theia-extension/src/browser/trace-panel.tsx';
const root=createRoot(document.getElementById('root'));
const call=async(operation,args={})=>{const r=await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,args})});const value=await r.json();if(!r.ok)throw new Error(value.error);return value;};
const perform=async action=>{try{await action();}catch(error){window.failure=String(error);}};
window.showTrace=()=>root.render(<TracePanel run={window.run} runs={[window.run]} select={()=>{}} call={call} perform={perform} source={()=>{}} attach={()=>{}}/>);
root.render(<EvalRegressionPanel detail={window.data} current={window.data.cases[0]} experiments={[window.data]} dataset="cases.jsonl" call={call} perform={perform} useDataset={file=>{window.dataset=file;}} exported={async()=>{}}/>);
`,
  },
  bundle: true,
  write: false,
  platform: 'browser',
  alias: { '@theia/core/shared/react': 'react' },
});
const server = http.createServer(async (request, response) => {
  try {
    if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        '<main class="aiide" id="root"></main><script>window.data=' +
          JSON.stringify(data) +
          ';window.run=' +
          JSON.stringify(run) +
          ';</script><script>' +
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
          choices: [{ message: { role: 'assistant', content: 'Paris' } }],
        }),
      );
      return;
    }
    const a = body.args;
    const methods = {
      'evals.snapshot': () => evals.snapshot(a.dataset),
      'evals.datasets': () => evals.datasets(),
      'evals.exportCase': () => evals.exportCase(a),
      'evals.exportTrace': () => evals.exportTrace(a),
      'evals.gate': () => evals.gate(a),
      'spans.list': () => store.spans(a.runId, a.offset),
    };
    if (!methods[body.operation])
      throw new Error('Unsupported fixture operation');
    response.end(JSON.stringify(await methods[body.operation]()));
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
evals = new core.Evals(root, store, connections, {});
run = await evals.run({
  dataset: 'cases.jsonl',
  target: 'local',
  system: 'Answer briefly.',
  scorers: [{ type: 'exact' }],
});
while (store.run(run.id).status === 'running')
  await new Promise((resolve) => setTimeout(resolve, 10));
run = store.run(run.id);
data = evals.get(run.id);
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
  const checkbox = async (label) =>
    page.evaluate(
      (label) =>
        [...document.querySelectorAll('label')]
          .find((node) => node.textContent.trim().startsWith(label))
          .querySelector('input')
          .click(),
      label,
    );
  const details = async (text) =>
    page.evaluate(
      (text) =>
        [...document.querySelectorAll('summary')]
          .find((node) => node.textContent.trim() === text)
          .click(),
      text,
    );
  await page.goto(url);
  await page.waitForSelector('h3');
  await click('Snapshot selected dataset');
  await page.waitForSelector('select');
  await field('Immutable dataset version', data.datasetVersion.file);
  await click('Use this dataset version');
  assert.equal(
    await page.evaluate(() => window.dataset),
    data.datasetVersion.file,
  );
  await details('Turn selected case into a regression test');
  await field('Reviewed reference answer', 'The verified answer is Paris.');
  await checkbox('I checked the input');
  await click('Export reviewed case');
  await page.waitForFunction(() =>
    document.body.textContent.includes('Saved data/regression-case.jsonl'),
  );
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(root, 'data/regression-case.jsonl'), 'utf8'),
    ).expected,
    'The verified answer is Paris.',
  );
  await details('Check a release gate');
  await click('Check regression gate');
  await page.waitForFunction(() =>
    document.body.textContent.includes('Gate passed'),
  );
  await page.evaluate(() => window.showTrace());
  await page.waitForSelector('.aiide-tt-row');
  await page.evaluate(() =>
    [...document.querySelectorAll('.aiide-tt-row')]
      .find((node) => node.textContent.includes('fixture'))
      .click(),
  );
  await click('Create regression case');
  await field('Verified trace reference', 'Paris');
  await checkbox('I verified this reference');
  await click('Export trace regression case');
  await page.waitForFunction(() =>
    document.body.textContent.includes('Saved data/trace-regression.jsonl'),
  );
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(root, 'data/trace-regression.jsonl'), 'utf8'),
    ).messages[0].content,
    'Answer briefly.',
  );
  assert.equal(await page.evaluate(() => window.failure), undefined);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: actual evaluation UI → dataset snapshot → reviewed case export → release gate → general trace-to-case export',
  );
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
