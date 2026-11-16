import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import puppeteer from 'puppeteer';
import core from '../packages/core/lib/index.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-evidence-ui-')),
  root = path.join(directory, 'project'),
  downloads = path.join(directory, 'downloads');
fs.mkdirSync(root);
fs.mkdirSync(downloads);
let workspace, browser, page, server, latestExport;
const state = { answer: 'Wrong' };
try {
  core.saveProject(root, {
    version: 1,
    name: 'Task evidence UI',
    environment: { python: 'python3' },
    commands: { verify: ['python', '-m', 'unittest', 'test_behavior', '-v'] },
  });
  fs.writeFileSync(path.join(root, 'main.py'), 'def answer():\n return 42\n');
  fs.writeFileSync(
    path.join(root, 'test_behavior.py'),
    'import unittest\nfrom main import answer\nclass Behavior(unittest.TestCase):\n def test_answer(self):self.assertEqual(answer(),42)\n',
  );
  fs.writeFileSync(
    path.join(root, 'cases.jsonl'),
    JSON.stringify({ input: 'Capital?', expected: 'Paris' }) + '\n',
  );
  server = http.createServer(async (req, res) => {
    for await (const chunk of req) {
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: state.answer } }],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  workspace = await core.Workspace.open(root);
  await workspace.connections.save({
    id: 'fixture',
    kind: 'model',
    model: 'fixture',
    url: `http://127.0.0.1:${server.address().port}/v1`,
  });
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
    import React from 'react';import{createRoot}from'react-dom/client';import{TaskEvidencePanel}from'./packages/theia-extension/src/browser/task-evidence-panel.tsx';
    const call=(operation,args={})=>window.apiCall(operation,args);
    function App(){const[runs,setRuns]=React.useState([]),[error,setError]=React.useState('');React.useEffect(()=>{let active=true;const refresh=async()=>{const values=await call('runs.list');if(active)setRuns(values);};void refresh();const timer=setInterval(()=>void refresh(),300);return()=>{active=false;clearInterval(timer);};},[]);return<><p role="alert">{error}</p><TaskEvidencePanel runs={runs} call={call} perform={async action=>{try{await action();setError('');}catch(error){setError(String(error));window.failure=String(error);}}}/></>;}
    createRoot(document.getElementById('root')).render(<App/>);
  `,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    alias: { '@theia/core/shared/react': 'react' },
  });
  browser = await puppeteer.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      (process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : undefined),
    args: ['--no-sandbox'],
  });
  page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.exposeFunction('apiCall', async (operation, args) => {
    const result = await workspace.operation(operation, args);
    if (operation === 'evidence.exportPreview') latestExport = result;
    return result;
  });
  await (
    await page.createCDPSession()
  ).send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloads,
  });
  await page.setContent('<main id="root"></main>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const button = async (text) => {
    const element = (
      await page.evaluateHandle(
        (text) =>
          [...document.querySelectorAll('button')].find(
            (node) => node.textContent.trim() === text,
          ),
        text,
      )
    ).asElement();
    assert.ok(element, text);
    return element;
  };
  const control = async (text) => {
    const element = (
      await page.evaluateHandle(
        (text) =>
          [...document.querySelectorAll('label')]
            .find((node) => node.textContent.trim().startsWith(text))
            ?.querySelector('input,select,textarea'),
        text,
      )
    ).asElement();
    assert.ok(element, text);
    return element;
  };
  const fill = async (label, value) => {
    await (
      await control(label)
    ).evaluate((node, value) => {
      const prototype =
        node instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
  };
  const enabled = async (text) =>
    page.waitForFunction(
      (text) =>
        ![...document.querySelectorAll('button')].find(
          (node) => node.textContent.trim() === text,
        )?.disabled,
      {},
      text,
    );
  const save = async () => {
    await (await button('Preview task checkpoint')).click();
    await page.waitForFunction(() =>
      document.body.textContent.includes('Launch checkpoint:'),
    );
    await (await control('I reviewed this record')).click();
    await enabled('Save task checkpoint');
    await (await button('Save task checkpoint')).click();
    await page.waitForFunction(
      () =>
        document.body.textContent.includes('Task status:') &&
        !document.body.textContent.includes('Unsaved form changes:'),
    );
  };
  const wait = async (run) => {
    const deadline = Date.now() + 10000;
    while (
      workspace.store.run(run.id).status === 'running' &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(workspace.store.run(run.id).status, 'completed');
    return run;
  };
  const evaluate = async () =>
    wait(
      await workspace.evals.run({
        dataset: 'cases.jsonl',
        target: 'fixture',
        scorers: [{ type: 'exact' }],
      }),
    );
  await page.waitForFunction(() =>
    document.body.textContent.includes('Plan and completion criteria'),
  );
  const plan =
    'Run actual unittest checks, compare the evaluation, then review the evidence.';
  await fill('Task title', 'Repair a response regression');
  await fill('Plan', plan);
  await (await control('I reviewed this plan')).click();
  await fill(
    'Completion criteria',
    'Local behavior tests complete\nExact evaluation meets the threshold',
  );
  await fill('Reviewed source files', 'main.py\ntest_behavior.py\ncases.jsonl');
  await fill(
    'Review findings',
    JSON.stringify([
      {
        id: 'regression',
        level: 'blocking',
        text: 'Investigate wrong answer',
        resolved: false,
        resolution: '',
      },
    ]),
  );
  await save();
  const id = workspace.evidence.list()[0].id;
  await (await button('New task')).click();
  await fill('Plan', 'Unsaved new plan must survive navigation');
  page.once('dialog', (dialog) => dialog.dismiss());
  await (await control('Saved task')).select(id);
  assert.equal(
    await (await control('Plan')).evaluate((node) => node.value),
    'Unsaved new plan must survive navigation',
  );
  page.once('dialog', (dialog) => dialog.dismiss());
  await (await button('New task')).click();
  assert.equal(
    await (await control('Plan')).evaluate((node) => node.value),
    'Unsaved new plan must survive navigation',
  );
  page.once('dialog', (dialog) => dialog.accept());
  await (await control('Saved task')).select(id);
  await page.waitForFunction(
    (plan) =>
      [...document.querySelectorAll('label')]
        .find((node) => node.textContent.trim().startsWith('Plan'))
        ?.querySelector('textarea')?.value === plan,
    {},
    plan,
  );
  const run = await wait(await workspace.runs.start('verify')),
    bad = await evaluate();
  await page.waitForFunction(
    (id) =>
      [...document.querySelectorAll('option')].some(
        (node) => node.value === id,
      ),
    {},
    run.id,
  );
  await (await control('Recorded run to link')).select(run.id);
  await (await button('Link recorded run')).click();
  await page.waitForFunction(
    (id) =>
      [...document.querySelectorAll('option')].some(
        (node) => node.value === id,
      ),
    {},
    bad.id,
  );
  await (await control('Evaluation to link')).select(bad.id);
  await enabled('Link evaluation gate');
  await (await button('Link evaluation gate')).click();
  await page.waitForFunction(
    (id) =>
      [...document.querySelectorAll('label')]
        .find((node) => node.textContent.trim().startsWith('Evaluation gates'))
        ?.querySelector('textarea')
        ?.value.includes(id),
    {},
    bad.id,
  );
  await save();
  assert.equal(
    workspace.evidence.get(id).report.evaluations[0].report.passed,
    false,
  );
  assert.equal(
    await (
      await button('Record reviewed completion')
    ).evaluate((node) => node.disabled),
    true,
  );
  state.answer = 'Paris';
  const good = await evaluate();
  await fill(
    'Evaluation gates',
    JSON.stringify([{ runId: good.id, thresholds: { exact_match: 1 } }]),
  );
  await fill(
    'Review findings',
    JSON.stringify([
      {
        id: 'regression',
        level: 'blocking',
        text: 'Investigate wrong answer',
        resolved: true,
        resolution: `Reproduced failed evaluation ${bad.id}, corrected the fixture response and attached passing evaluation ${good.id}`,
      },
    ]),
  );
  await save();
  assert.equal(workspace.evidence.get(id).report.ready, true);
  await (await control('I reviewed the linked evidence')).click();
  await enabled('Record reviewed completion');
  await (await button('Record reviewed completion')).click();
  await page.waitForFunction(() =>
    document.body.textContent.includes('Task status: reviewed-complete'),
  );
  await (await button('Preview evidence export')).click();
  await page.waitForFunction(() =>
    document.body.textContent.includes('aiide-task-evidence-v1'),
  );
  await (await control('I reviewed this JSON artifact')).click();
  await enabled('Download reviewed evidence JSON');
  await (await button('Download reviewed evidence JSON')).click();
  const file = path.join(downloads, `task-evidence-${id}.json`);
  for (let i = 0; i < 100 && !fs.existsSync(file); i++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  const artifact = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(artifact.status, 'reviewed-complete');
  assert.equal(
    artifact.evidence.evaluations[0].report.scores.exact_match.mean,
    1,
  );
  fs.appendFileSync(path.join(root, 'main.py'), '# changed after review\n');
  await (await button('Refresh recorded evidence')).click();
  await page.waitForFunction(() =>
    document.body.textContent.includes('Task status: stale-completion'),
  );
  await assert.rejects(
    workspace.operation('evidence.export', {
      id,
      revision: latestExport.revision,
      reviewHash: latestExport.reviewHash,
      confirmed: true,
    }),
    /changed/,
  );
  page.once('dialog', (dialog) => dialog.accept());
  await (await button('Delete task record')).click();
  await page.waitForFunction(
    () => !document.body.textContent.includes('Task status:'),
  );
  assert.equal(workspace.evidence.list().length, 0);
  assert.ok(workspace.store.run(run.id));
  assert.ok(workspace.store.run(good.id));
  assert.ok(fs.existsSync(file));
  assert.ok(fs.existsSync(path.join(root, 'main.py')));
  assert.deepEqual(errors, []);
  console.log(
    'PASS: actual Chrome/Workspace task plan/source checkpoint → real unittest + failing/passing HTTP eval evidence → review findings → completion gate → reviewed JSON download → stale-source rejection → record-only deletion; unsaved new drafts retained',
  );
} catch (error) {
  if (page)
    console.error(
      await page.evaluate(() => ({
        body: document.body.textContent.slice(-12000),
        failure: window.failure,
      })),
    );
  throw error;
} finally {
  await browser?.close();
  await workspace?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  fs.rmSync(directory, { recursive: true, force: true });
}
