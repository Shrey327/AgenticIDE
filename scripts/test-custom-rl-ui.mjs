import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import puppeteer from 'puppeteer';
import core from '../packages/core/lib/index.js';

const python =
  process.env.AIIDE_RL_TEST_PYTHON ||
  path.resolve('templates/rl/.venv/bin/python');
assert.ok(
  fs.existsSync(python),
  'Set AIIDE_RL_TEST_PYTHON to the advanced RL environment',
);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-custom-rl-ui-'));
let workspace, browser, page;
try {
  core.saveProject(root, {
    version: 1,
    name: 'Custom RL UI',
    environment: { python },
  });
  fs.copyFileSync(
    'templates/rl/custom_target.py',
    path.join(root, 'custom_target.py'),
  );
  workspace = await core.Workspace.open(root);
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {RLPanel} from './packages/theia-extension/src/browser/rl-panel.tsx';
    const call=(operation,args={})=>window.apiCall(operation,args);
    function App(){
      const [runs,setRuns]=React.useState([]),[error,setError]=React.useState('');
      const refresh=async()=>{const values=await call('runs.list');setRuns(values);window.runs=values;};
      React.useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),300);return()=>clearInterval(timer);},[]);
      return <><p role="alert">{error}</p><RLPanel call={call} perform={async action=>{try{await action();setError('');}catch(error){setError(String(error));window.failure=String(error);}}} runs={runs} refresh={refresh} openTrace={()=>{}}/></>;
    }
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
  await page.exposeFunction('apiCall', (operation, args) =>
    workspace.operation(operation, args),
  );
  await page.setContent('<main id="root"></main>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const button = async (text) => {
    const handle = await page.evaluateHandle(
      (text) =>
        [...document.querySelectorAll('button')].find(
          (node) => node.textContent.trim() === text,
        ),
      text,
    );
    const element = handle.asElement();
    assert.ok(element, text);
    return element;
  };
  const control = async (label) => {
    const handle = await page.evaluateHandle(
      (label) =>
        [...document.querySelectorAll('label')]
          .find((node) => node.textContent.trim().startsWith(label))
          ?.querySelector('input,select,textarea'),
      label,
    );
    const element = handle.asElement();
    assert.ok(element, label);
    return element;
  };
  const fill = async (label, value) => {
    const element = await control(label);
    await element.evaluate((node, value) => {
      const prototype =
        node instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
  };
  await page.waitForFunction(() =>
    document.body.textContent.includes('Review a custom environment'),
  );
  await fill('Environment ID', 'ui-target');
  await (await button('Preview environment sources')).click();
  await page.waitForFunction(() =>
    document.body.textContent.includes('Reviewed revision:'),
  );
  assert.equal(workspace.rl.environments().length, 0);
  await (await control('I reviewed these sources')).click();
  await (await button('Register reviewed environment')).click();
  await page.waitForFunction(() =>
    document.body.textContent.includes('Registered custom:ui-target'),
  );
  await (await button('Check environment (executes project Python)')).click();
  await page.waitForFunction(
    () => document.body.textContent.includes('Gymnasium/SB3 check passed'),
    { timeout: 60000 },
  );
  await (await control('Algorithm')).select('ppo');
  await (await control('Neural environment')).select('custom:ui-target');
  await fill('Training steps per seed', '256');
  await fill('Parallel environments', '2');
  await fill('Training seeds', '99');
  await fill('Held-out episodes', '2');
  await fill('Neural episode step limit', '10');
  assert.equal(
    await page.$eval('form', (form) => form.checkValidity()),
    true,
    'default neural controls must permit actual form submission',
  );
  await (await button('Train policy')).click();
  await page.waitForFunction(
    () =>
      window.runs?.some(
        (run) =>
          run.name === 'RL · custom:ui-target' && run.status === 'completed',
      ),
    { timeout: 120000 },
  );
  await page.waitForFunction(() =>
    document.body.textContent.includes('Inspect policy'),
  );
  await (await button('Inspect policy')).click();
  await (await button('Run policy')).click();
  await page.waitForFunction(
    () => document.body.textContent.includes('Custom environment rollout'),
    { timeout: 60000 },
  );
  assert.equal(
    await page.$('svg[aria-label*="angle"]'),
    null,
    'custom observations must not be rendered as CartPole physics',
  );
  fs.appendFileSync(
    path.join(root, 'custom_target.py'),
    '\n# changed after review\n',
  );
  const count = workspace.store.runs().length;
  await (await button('Train policy')).click();
  await page.waitForFunction(() => window.failure?.includes('changed'));
  assert.equal(
    workspace.store.runs().length,
    count,
    'unreviewed modified source must not launch',
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS: actual Chrome → source preview/consent → registration → Gym checker → recorded custom PPO workers → policy/rollout → changed-source rejection',
  );
} catch (error) {
  if (page)
    console.error(
      await page.evaluate(() => ({
        body: document.body.textContent,
        failure: window.failure,
      })),
    );
  throw error;
} finally {
  await browser?.close();
  await workspace?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
