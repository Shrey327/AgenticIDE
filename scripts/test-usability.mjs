import assert from 'node:assert/strict';
import { build } from 'esbuild';
import puppeteer from 'puppeteer';

// Render the real components with a delayed API to exercise keyboard and request races.
const { outputFiles } = await build({
  stdin: {
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { ModelsPanel } from './packages/theia-extension/src/browser/models-panel.tsx';
      import { Overview } from './packages/theia-extension/src/browser/overview.tsx';
      import { MetricChart } from './packages/theia-extension/src/browser/metric-chart.tsx';
      import { TrainingPanel } from './packages/theia-extension/src/browser/training-panel.tsx';
      import { AssistantPanel } from './packages/theia-extension/src/browser/assistant-panel.tsx';
      import { RunsPanel } from './packages/theia-extension/src/browser/runs-panel.tsx';
      const root = createRoot(document.getElementById('root'));
      const project = {
        config: { commands: {}, environment: { python: 'python3' } },
        environment: { frameworks: [], locks: [], python: 'python3', manager: 'none' }
      };
      const perform = async (fn) => { try { await fn(); } catch(e) { window.failure = String(e); } };
      const call = async (method, args) => {
        if (method === 'assistant.start') { window.request = args; return { status: 'completed', text: 'done' }; }
        if (method === 'training.start') { window.trainingCalls = (window.trainingCalls || 0) + 1; return new Promise(resolve => { window.trainingComplete = resolve; }); }
        if (method === 'ssh.list') return [];
        if (method === 'models.complete') return new Promise(resolve => { window.complete = resolve; });
        if (method === 'events.list') return [];
        if (method === 'runs.summary') return { metrics: [] };
        return {};
      };
      const common = { call, perform, refresh: async () => {}, connections: [] };
      window.show = (page) => {
        if (page === 'training') root.render(<TrainingPanel {...common} project={{...project, config: {...project.config, commands: {train: ['python', 'train.py']}}}} runs={[]} selected="" select={() => {}} />);
        if (page === 'assistant') root.render(<AssistantPanel {...common} context="" setContext={() => {}} selection={() => ''} connections={[
          { id: 'tools', kind: 'model', capabilities: { tools: true } }, { id: 'basic', kind: 'model' }
        ]} />);
        if (page === 'models') root.render(<ModelsPanel {...common} connections={[
          { id: 'local', kind: 'model', url: 'http://localhost:11434/v1', model: 'qwen' }
        ]} />);
        if (page === 'overview') root.render(<Overview {...common} project={project} runs={[]}
          status={{}} created={async () => {}} go={() => {}} openRun={() => {}} openTrace={() => {}} />);
        if (page === 'chart') root.render(<MetricChart values={[{ name: 'loss', value: null, timestamp: 0 }]}
          compare={[{ name: 'loss', value: 3, timestamp: 1 }, { name: 'loss', value: 2, timestamp: 2 }]} />);
        if (page === 'runs') root.render(<RunsPanel {...common} project={project} selected=""
          runs={[{ id: 'a', name: 'classification sweep', status: 'completed', started: 1, ended: 2, command: [] }]}
          select={() => {}} inspect={() => {}} attach={() => {}} />);
      };
    `,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  alias: { '@theia/core/shared/react': 'react' },
});
const browser = await puppeteer.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH ||
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined),
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<main class="aiide" id="root"></main>');
  await page.addScriptTag({ content: outputFiles[0].text });

  await page.evaluate(() => window.show('chart'));
  await page.waitForSelector('svg[role="img"]');
  const chart = await page.$eval('svg', (node) =>
    node.getAttribute('aria-label'),
  );
  assert.match(chart, /0 primary samples, latest unavailable/);
  assert.match(chart, /Range 2 to 3/);
  assert.match(chart, /Comparison: 2 samples, latest 2/);

  await page.evaluate(() => window.show('overview'));
  await page.waitForSelector('[aria-label="Project template"]');
  const firstTemplate = '[aria-label="Project template"] button:first-child';
  await page.focus(firstTemplate);
  await page.keyboard.press('Space');
  await page.waitForFunction(
    (selector) =>
      document.querySelector(selector)?.getAttribute('aria-pressed') === 'true',
    {},
    firstTemplate,
  );
  assert.equal(
    await page.$eval('.aiide-templates [aria-pressed="true"]', (node) =>
      node.textContent.includes('Instrumented Python'),
    ),
    true,
  );

  await page.evaluate(() => window.show('models'));
  await page.waitForSelector('[aria-label="Prompt"]');
  assert.ok(await page.$('textarea[aria-label="System prompt"]'));
  await page.focus('[aria-label="Prompt"]');
  await page.keyboard.type('Hello');
  await page.keyboard.down('Control');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Control');
  await page.waitForSelector('[aria-busy="true"]');
  assert.equal(
    await page.$eval(
      '.aiide-playground .aiide-subtle',
      (node) => node.disabled,
    ),
    true,
  );
  assert.equal(
    await page.$eval('.aiide-playground fieldset', (node) => node.disabled),
    true,
  );
  assert.equal(
    await page.$eval('[aria-label="Prompt"]', (node) => node.disabled),
    true,
  );
  await page.evaluate(() => window.complete({ text: 'Hello back' }));
  await page.waitForSelector('[aria-busy="false"]');
  assert.match(
    await page.$eval('[role="log"]', (node) => node.textContent),
    /Hello back/,
  );
  await page.click('.aiide-playground .aiide-subtle');
  await page.waitForFunction(() => !document.querySelector('[role="log"]'));

  await page.evaluate(() => window.show('runs'));
  await page.waitForSelector('[aria-label="Search runs"]');
  await page.type('[aria-label="Search runs"]', 'no matching run');
  await page.waitForFunction(() =>
    document.body.textContent.includes('No runs match these filters'),
  );
  await page.evaluate(() => window.show('assistant'));
  await page.waitForSelector('select');
  await page.select('select', 'tools');
  await page.click('input[type="checkbox"]');
  await page.select('select', 'basic');
  await page.type('textarea', 'Explain the failure');
  await page.click('.aiide-primary');
  await page.waitForFunction(() => !!window.request);
  assert.equal(await page.evaluate(() => window.request.autonomous), false);

  await page.evaluate(() => window.show('training'));
  await page.waitForFunction(
    () => document.querySelector('h2')?.textContent === 'Training workspace',
  );
  await page.type('textarea', 'broken');
  await page.click('.aiide-primary');
  await page.waitForFunction(() => !!window.failure);
  assert.match(
    await page.evaluate(() => window.failure),
    /Training parameters must be a JSON object/,
  );
  assert.equal(await page.evaluate(() => window.trainingCalls || 0), 0);
  await page.$eval('textarea', (node) => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    ).set.call(node, '{}');
    node.dispatchEvent(new Event('input', { bubbles: true }));
    window.failure = undefined;
  });
  await page.click('.aiide-primary');
  await page.waitForFunction(() => window.trainingCalls === 1);
  assert.equal(
    await page.$eval('.aiide-primary', (node) => node.disabled),
    true,
  );
  await page.evaluate(() => window.trainingComplete({ id: 'test' }));
  await page.waitForFunction(
    () => !document.querySelector('.aiide-primary').disabled,
  );
  assert.equal(await page.evaluate(() => window.failure), undefined);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: comparison-only chart, keyboard template selection, pending inference, labeled controls, empty run filters, assistant capability guard, training validation and duplicate launch guard',
  );
} finally {
  await browser.close();
}
