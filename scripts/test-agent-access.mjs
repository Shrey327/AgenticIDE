import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import core from '../packages/core/lib/index.js';
const { Workspace, saveProject, agentClientSetup } = core;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-external-agents-'));
const project = path.join(root, 'project');
fs.mkdirSync(project);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let browser, backend, client;
try {
  fs.writeFileSync(path.join(project, 'main.py'), 'print("before")\n');
  fs.writeFileSync(path.join(project, '.env'), 'SECRET=fixture-only\n');
  saveProject(project, {
    version: 1,
    name: 'External agent acceptance',
    commands: { example: ['python3', 'main.py'] },
  });
  const workspace = await Workspace.open(project);
  workspace.store.saveRun({
    id: 'fixture-run',
    project: 'fixture',
    name: 'example',
    status: 'failed',
    started: Date.now(),
    command: ['python3', 'main.py'],
    source: 'fixture',
    environment: {},
    configuration: {},
  });
  workspace.store.event({
    runId: 'fixture-run',
    kind: 'metric',
    name: 'loss',
    value: 0.5,
    step: 1,
    timestamp: Date.now(),
  });
  await workspace.close();
  const log = fs.openSync('/tmp/aiide-agent-ui-server.log', 'w');
  const electron = process.env.AIIDE_ELECTRON_EXECUTABLE;
  backend = spawn(
    electron || 'node',
    electron
      ? [project, '--hostname=127.0.0.1', '--remote-debugging-port=9226']
      : [
          'apps/browser/lib/backend/main.js',
          project,
          '--hostname=127.0.0.1',
          '--port=3094',
        ],
    {
      env: { ...process.env, THEIA_CONFIG_DIR: path.join(root, 'theia') },
      stdio: ['ignore', log, log],
      detached: true,
    },
  );
  fs.closeSync(log);
  const endpoint = electron ? 'http://127.0.0.1:9226' : 'http://127.0.0.1:3094';
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(endpoint + (electron ? '/json/version' : ''))).ok) break;
    } catch {}
    await delay(250);
  }
  browser = electron
    ? await puppeteer.connect({ browserURL: endpoint, defaultViewport: null })
    : await puppeteer.launch({
        headless: true,
        executablePath:
          process.env.CHROME_PATH ||
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        args: ['--no-sandbox'],
        defaultViewport: { width: 1440, height: 1100 },
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
  await click('External agents', '.aiide-tabs button');
  await page.waitForSelector('[data-testid="agent-access-panel"]');
  await page.select('[data-testid="agent-access-panel"] select', 'work');
  await click('Issue scoped credential');
  await page.waitForSelector(
    '[data-testid="agent-access-panel"] input[type="password"]',
  );
  const connection = await page.$eval(
    '[data-testid="agent-access-panel"]',
    (e) => ({
      url: e.querySelector('input').value,
      token: e.querySelector('input[type="password"]').value,
    }),
  );
  client = new Client({ name: 'external-coding-agent-test', version: '1.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(connection.url), {
      requestInit: { headers: { Authorization: `Bearer ${connection.token}` } },
    }),
  );
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    assert.ok(!response.isError, JSON.stringify(response.content));
    return response.structuredContent.result;
  };
  assert.equal(
    (await call('get_workspace')).project.name,
    'External agent acceptance',
  );
  assert.equal(
    (await call('inspect_metrics', { runId: 'fixture-run', name: 'loss' }))
      .items[0].value,
    0.5,
  );
  const setup = agentClientSetup(connection.url);
  // Test installed CLI parsers without touching user configuration or running a paid model.
  const cliEnv = {
    ...process.env,
    CODEX_HOME: path.join(root, 'codex'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    AIIDE_MCP_TOKEN: connection.token,
  };
  fs.mkdirSync(cliEnv.CODEX_HOME);
  fs.mkdirSync(cliEnv.CLAUDE_CONFIG_DIR);
  const codex = JSON.parse(
    execFileSync(
      'codex',
      [
        '-c',
        `mcp_servers.aiide.url=${JSON.stringify(connection.url)}`,
        '-c',
        'mcp_servers.aiide.bearer_token_env_var="AIIDE_MCP_TOKEN"',
        'mcp',
        'get',
        'aiide',
        '--json',
      ],
      {
        env: cliEnv,
        cwd: project,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15000,
      },
    ),
  );
  assert.equal(codex.transport.url, connection.url);
  execFileSync(
    'claude',
    [
      'mcp',
      'add-json',
      '--scope',
      'local',
      'aiide',
      JSON.stringify(JSON.parse(setup.claude).mcpServers.aiide),
    ],
    {
      env: cliEnv,
      cwd: project,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    },
  );
  const claude = execFileSync('claude', ['mcp', 'list'], {
    env: cliEnv,
    cwd: project,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
  });
  assert.match(claude, /aiide/);
  assert.match(claude, /Connected|connected/);
  console.log(
    'PASS: installed Codex configuration parser and Claude Code MCP handshake; no model inference',
  );
  await click('Project instructions for coding agents', 'summary');
  await click('Create missing agent guides');
  await page.waitForFunction(() =>
    document
      .querySelector('[data-testid="agent-access-panel"]')
      ?.textContent.includes('"created"'),
  );
  assert.ok(fs.existsSync(path.join(project, 'AGENTS.md')));
  assert.ok(fs.existsSync(path.join(project, 'CLAUDE.md')));
  const session = await call('create_session');
  assert.ok(
    !(await call('list_files', { session: session.id })).includes('.env'),
  );
  await call('write_file', {
    session: session.id,
    file: 'main.py',
    text: 'print("agent change")\n',
  });
  assert.equal(
    fs.readFileSync(path.join(project, 'main.py'), 'utf8'),
    'print("before")\n',
  );
  await call('start_command', {
    session: session.id,
    command: 'python main.py',
  });
  let state;
  for (let i = 0; i < 100; i++) {
    state = await call('session_status', { session: session.id });
    if (state.status !== 'running') break;
    await delay(200);
  }
  assert.equal(state.status, 'completed');
  assert.match(state.output, /agent change/);
  assert.equal(
    (await call('review_changes', { session: session.id }))[0].file,
    'main.py',
  );
  await click('Review external changes');
  await click('Apply reviewed external changes');
  for (
    let i = 0;
    i < 50 &&
    fs.readFileSync(path.join(project, 'main.py'), 'utf8') !==
      'print("agent change")\n';
    i++
  )
    await delay(100);
  assert.equal(
    fs.readFileSync(path.join(project, 'main.py'), 'utf8'),
    'print("agent change")\n',
  );
  // Host edits after the stage baseline must be preserved even after a user reviews the diff.
  await call('write_file', {
    session: session.id,
    file: 'main.py',
    text: 'print("second change")\n',
  });
  fs.writeFileSync(
    path.join(project, 'main.py'),
    'print("concurrent host edit")\n',
  );
  await click('Review external changes');
  await click('Apply reviewed external changes');
  await page.waitForFunction(() =>
    document.body.textContent.includes('Concurrent edit conflict'),
  );
  assert.equal(
    fs.readFileSync(path.join(project, 'main.py'), 'utf8'),
    'print("concurrent host edit")\n',
  );
  await call('start_command', {
    session: session.id,
    command: 'python -c "import time; time.sleep(60)"',
  });
  await click('Revoke all credentials');
  await page.waitForFunction(
    () =>
      !document.querySelector(
        '[data-testid="agent-access-panel"] input[type="password"]',
      ),
  );
  await assert.rejects(call('get_workspace'));
  assert.throws(
    () =>
      execFileSync('docker', ['inspect', 'aiide-' + session.id], {
        stdio: 'pipe',
      }),
    'Revocation must remove the running container',
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS: Settings → MCP → real Docker edit/command → visible review/apply; concurrent edit protection and revocation',
  );
} finally {
  if (client) await client.close();
  if (browser) await browser.close();
  if (backend) {
    try {
      process.kill(-backend.pid, 'SIGTERM');
    } catch {}
    await delay(1000);
  }
  fs.rmSync(root, { recursive: true, force: true });
}
