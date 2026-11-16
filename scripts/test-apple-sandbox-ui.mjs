import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import puppeteer from 'puppeteer';
import core from '../packages/core/lib/index.js';

assert.equal(
  process.platform,
  'darwin',
  'Native VM UI acceptance requires Apple Silicon macOS 26',
);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-vm-ui-'));
const kernel = process.env.AIIDE_APPLE_TEST_KERNEL;
const operations = [];
let workspace, browser;
const configureKernel = (sandbox) => {
  if (!kernel) return;
  assert.ok(path.isAbsolute(kernel) && fs.statSync(kernel).isFile());
  const original = sandbox.apple.args.bind(sandbox.apple);
  // A test-only per-VM kernel argument; the runtime's default kernel stays untouched.
  sandbox.apple.args = (...args) => {
    const command = original(...args);
    return [command[0], '--kernel', kernel, ...command.slice(1)];
  };
};
try {
  for (const file of ['pyproject.toml', 'uv.lock'])
    fs.copyFileSync(
      path.resolve('templates/python', file),
      path.join(directory, file),
    );
  fs.writeFileSync(
    path.join(directory, '.env'),
    'do-not-share-test-credential',
  );
  fs.writeFileSync(
    path.join(directory, 'main.py'),
    `import os,json,sys\nfrom pathlib import Path\nassert os.geteuid()!=0\nassert sys.prefix=='/workspace/.venv'\nassert not Path('/workspace/.env').exists()\nassert not Path('/var/run/docker.sock').exists()\nassert 'NoNewPrivs:\\t1' in Path('/proc/self/status').read_text()\nquota,period=Path('/sys/fs/cgroup/cpu.max').read_text().split()\nassert int(quota)/int(period)==2\nassert int(Path('/sys/fs/cgroup/memory.max').read_text())==1073741824\nPath('reviewed-vm.txt').write_text('A reviewed native VM change\\n')\nprint('native-ui-vm-complete',flush=True)\n`,
  );
  workspace = await core.Workspace.open(directory);
  configureKernel(workspace.sandbox);
  const capabilities = await workspace.operation('sandbox.capabilities');
  assert.ok(
    capabilities.apple.available && capabilities.docker.available,
    'Start both installed runtimes for the policy transition acceptance',
  );
  const bundle = await build({
    stdin: {
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {SandboxPanel} from './packages/theia-extension/src/browser/sandbox-panel.tsx';
const root=createRoot(document.getElementById('root'));window.failures=[];
const call=(operation,args)=>window.request(operation,args);
function App(){const[error,setError]=React.useState('');const perform=React.useCallback(async fn=>{setError('');try{await fn();}catch(error){window.failures.push(String(error));setError(String(error));}},[]);return <><SandboxPanel call={call} perform={perform}/>{error&&<p role="alert">{error}</p>}</>;}
window.mount=()=>root.render(<App/>);window.unmount=()=>root.render(<p>Closed</p>);window.mount();`,
      loader: 'tsx',
      resolveDir: process.cwd(),
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
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.exposeFunction('request', (operation, args) => {
    operations.push({ operation, args });
    return workspace.operation(operation, args);
  });
  await page.setContent('<main id="root"></main>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const buttonDisabled = (text) =>
    page.evaluate(
      (text) =>
        [...document.querySelectorAll('button')].find(
          (node) => node.textContent.trim() === text,
        )?.disabled,
      text,
    );
  const click = async (text) => {
    await page.waitForFunction(
      (text) =>
        [...document.querySelectorAll('button')].some(
          (node) => node.textContent.trim() === text && !node.disabled,
        ),
      {},
      text,
    );
    await page.evaluate(
      (text) =>
        [...document.querySelectorAll('button')]
          .find((node) => node.textContent.trim() === text)
          .click(),
      text,
    );
  };
  const policySelect = async () =>
    (
      await page.evaluateHandle(() =>
        [...document.querySelectorAll('label')]
          .find((node) =>
            node.textContent.trim().startsWith('Sandbox isolation policy'),
          )
          .querySelector('select'),
      )
    ).asElement();
  await page.waitForFunction(() =>
    document.body.textContent.includes('dedicated VM available'),
  );
  await click('Create sandbox');
  await page.waitForSelector('[aria-label="Sandbox command status"]');
  const old = workspace.sandbox.all()[0];
  assert.equal(old.engine, 'docker');
  await (await policySelect()).select('apple-vm');
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('button')].find(
        (node) => node.textContent.trim() === 'Create sandbox',
      ).disabled,
  );
  assert.equal(
    await buttonDisabled('Run in sandbox'),
    true,
    'An unsaved stronger policy must not execute an old weaker stage',
  );
  assert.equal(
    await buttonDisabled('Install locked environment (network)'),
    true,
    'Environment setup must wait until the selected policy is saved',
  );
  const creates = operations.filter(
    (entry) => entry.operation === 'sandbox.create',
  ).length;
  await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .find((node) => node.textContent.trim() === 'Create sandbox')
      .click(),
  );
  assert.equal(
    operations.filter((entry) => entry.operation === 'sandbox.create').length,
    creates,
    'Unsaved VM selection cannot silently create a Docker sandbox',
  );
  assert.equal(workspace.sandbox.policy().engine, 'docker');
  await click('Save isolation policy');
  await page.waitForFunction(() =>
    document.body.textContent.includes('Saved policy: dedicated VM required'),
  );
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(directory, '.aiide/sandbox-policy.json')),
    ).engine,
    'apple-vm',
  );
  await click('Run in sandbox');
  await page.waitForFunction(() =>
    window.failures.some((error) => error.includes('requires a dedicated VM')),
  );
  assert.equal(
    workspace.sandbox.status(old.id).status,
    'ready',
    'A weaker stage never starts after VM policy is saved',
  );
  assert.equal(await buttonDisabled('Create sandbox'), false);
  await click('Create sandbox');
  await page.waitForFunction(() =>
    document
      .querySelector('[aria-label="Sandbox command status"]')
      ?.textContent.includes('dedicated Linux VM per command'),
  );
  const selected = workspace.sandbox
    .all()
    .find((session) => session.engine === 'apple-vm');
  assert.ok(selected);
  await click('Install locked environment (network)');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="Sandbox command status"]')
        ?.textContent.includes('locked environment installed'),
    { timeout: 60000 },
  );
  assert.ok(
    operations.some(
      (entry) =>
        entry.operation === 'sandbox.prepare' && entry.args.id === selected.id,
    ),
  );
  await page.evaluate(() => {
    const field = [...document.querySelectorAll('label')]
      .find((node) => node.textContent.trim().startsWith('Container command'))
      .querySelector('input');
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    ).set.call(field, 'python main.py');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Run in sandbox');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="Sandbox command status"]')
        ?.textContent.includes('completed') &&
      document
        .querySelector('[aria-label="Sandbox output"]')
        ?.textContent.includes('native-ui-vm-complete'),
    { timeout: 60000 },
  );
  assert.equal(fs.existsSync(path.join(directory, 'reviewed-vm.txt')), false);
  await click('Review diff');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('summary')].some(
      (node) => node.textContent === 'reviewed-vm.txt',
    ),
  );
  await click('Apply reviewed changes');
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('button')].some(
        (node) => node.textContent.trim() === 'Apply reviewed changes',
      ),
  );
  assert.equal(
    fs.readFileSync(path.join(directory, 'reviewed-vm.txt'), 'utf8'),
    'A reviewed native VM change\n',
  );
  await page.evaluate(() => window.unmount());
  await page.waitForFunction(() => document.body.textContent === 'Closed');
  await workspace.close();
  workspace = await core.Workspace.open(directory);
  configureKernel(workspace.sandbox);
  await page.evaluate(() => window.mount());
  await page.waitForFunction(() =>
    document.body.textContent.includes('Saved policy: dedicated VM required'),
  );
  assert.equal(
    await (await policySelect()).evaluate((node) => node.value),
    'apple-vm',
  );
  assert.deepEqual(browserErrors, []);
  assert.deepEqual(
    await page.evaluate(() =>
      window.failures.filter(
        (error) => !error.includes('requires a dedicated VM'),
      ),
    ),
    [],
  );
  console.log(
    'PASS: actual Chrome SandboxPanel → persisted VM policy → fail-closed old Docker stage → actual locked UV install → offline native VM command → diff review/host apply → workspace reopen',
  );
  if (kernel)
    console.log(
      'Kernel selected only in test VM arguments; runtime default unchanged:',
      kernel,
    );
} finally {
  await browser?.close();
  await workspace?.close();
  if (workspace)
    await workspace.sandbox.apple
      .recover(core.hash(fs.realpathSync(directory)))
      .catch(() => {});
  fs.rmSync(directory, { recursive: true, force: true });
}
