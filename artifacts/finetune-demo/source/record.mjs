// Drives the real IDE from an empty folder through serve → eval → fine-tune → eval → agent review → fast serving,
// screen-recording each scene. Long waits (downloads, training, evaluations) happen off camera between scenes.
// Usage: node record.mjs [scene-id ...]   (IDE must serve the empty recording folder at DEMO_URL)
import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const repo = path.resolve(root, '../..');
const assets = path.join(root, 'assets');
const timelineFile = path.join(assets, 'timeline.json');
const resultsFile = path.join(assets, 'results.json');
const timeline = JSON.parse(fs.readFileSync(timelineFile));
const results = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile)) : {};
const only = process.argv.slice(2);
const ffmpegPath = process.env.FFMPEG || '/opt/zerobrew/prefix/bin/ffmpeg';
const project = path.join(root, 'recording/ticket-triage');
const base = process.env.DEMO_URL || 'http://127.0.0.1:3120';
// After the project exists, later runs reopen it directly.
const url = fs.existsSync(project) && !only.includes('02-project') ? `${base}/#${project}` : base;
const { loadProject, saveProject } = await import(path.join(repo, 'packages/core/lib/index.js')).then((m) => m.default);

const SYSTEM = JSON.parse(fs.readFileSync(path.join(root, 'files/system.json'))).system;
const TICKET =
  'Hello team, Checkout in the iOS app keeps failing when I pay. I cannot finish my order today. Please refund the double charge. Thanks, Marco';
const RUBRIC =
  "Grade as Lumen's support lead. Policy: P1 = outage, data loss or a whole team blocked; P2 = one person blocked or a payment failing; P3 = otherwise. needs_human = refund, cancellation or churn threat, legal or security. 1 = triage fully defensible; 0.5 = one questionable field; 0 = wrong or unusable.";

const browser = await puppeteer.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox', '--window-size=1440,900'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, timeout = 30 * 60000, every = 1000) => {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error('Timed out waiting: ' + fn);
    await delay(every);
  }
};
const find = (text, selector = 'button', timeout = 60000) =>
  page.waitForFunction(
    (text, selector) =>
      [...document.querySelectorAll(selector)].find(
        (e) => e.textContent.includes(text) && !e.disabled && e.offsetParent,
      ),
    { timeout },
    text,
    selector,
  );
const point = async (el) => {
  await el.evaluate((e) => e.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  await delay(1000);
  const box = await el.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
  await delay(200);
};
const click = async (text, selector = 'button', timeout) => {
  const el = (await find(text, selector, timeout)).asElement();
  await point(el);
  await el.click();
  await delay(550);
};
const nav = async (id) => {
  await page.click('[id="shell-tab-aiide.workbench"]').catch(() => {});
  await delay(300);
  await click('', `.aiide-tabs [data-tab="${id}"]`);
  await delay(600);
};
const control = (label, scope) =>
  page.evaluateHandle(
    (label, scope) =>
      [...document.querySelectorAll(`${scope} label`)]
        .find((e) => e.textContent.trim().startsWith(label) && e.offsetParent)
        ?.querySelector('input,textarea,select'),
    label,
    scope,
  );
const field = async (label, value, { fast = false, scope = '.aiide' } = {}) => {
  const el = (await control(label, scope)).asElement();
  assert.ok(el, 'Missing field: ' + label);
  await point(el);
  const tag = await el.evaluate((e) => e.tagName);
  if (tag === 'SELECT') {
    const option = await el.evaluate(
      (e, value) => [...e.options].find((o) => o.value === value || o.textContent.includes(value))?.value,
      value,
    );
    assert.ok(option !== undefined, `No option ${value} for ${label}`);
    await el.select(option);
  } else if ((await el.evaluate((e) => e.type)) === 'number') {
    await el.click();
    await el.evaluate((e, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, value);
      e.dispatchEvent(new Event('input', { bubbles: true }));
    }, String(value));
    await delay(150);
    assert.equal(await el.evaluate((e) => e.value), String(value), 'Number field ' + label);
  } else {
    await el.click();
    await el.evaluate((e) => {
      const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, '');
      e.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await delay(120);
    if (fast) {
      await el.evaluate((e, value) => {
        const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, value);
        e.dispatchEvent(new Event('input', { bubbles: true }));
      }, String(value));
    } else await el.type(String(value), { delay: 22 });
  }
  await delay(400);
};
const scrollTo = async (selector, block = 'start') => {
  await page.waitForSelector(selector, { timeout: 60000 });
  await page.$eval(selector, (e, block) => e.scrollIntoView({ block, behavior: 'smooth' }), block);
  await delay(900);
};
const scrollText = async (text, selector = 'h3,h4', block = 'start') => {
  const el = (await find(text, selector)).asElement();
  await el.evaluate((e, block) => e.scrollIntoView({ block, behavior: 'smooth' }), block);
  await delay(900);
};
const top = async () => {
  await page.$eval('.aiide-content', (e) => e.scrollTo({ top: 0, behavior: 'smooth' })).catch(() => {});
  await delay(600);
};
const installCursor = () =>
  page.evaluate(() => {
    if (document.getElementById('demo-cursor')) return;
    const cursor = document.createElement('div');
    cursor.id = 'demo-cursor';
    cursor.style = 'position:fixed;z-index:999999;left:720px;top:450px;width:22px;height:28px;pointer-events:none;filter:drop-shadow(0 2px 2px #0009)';
    cursor.innerHTML = '<svg viewBox="0 0 22 28"><path d="M2 2 L2 23 L7 18 L12 26 L16 24 L11 16 L19 16 Z" fill="white" stroke="#111" stroke-width="1.5"/></svg>';
    document.body.append(cursor);
    document.addEventListener('mousemove', (e) => {
      cursor.style.left = e.clientX + 'px';
      cursor.style.top = e.clientY + 'px';
    });
    // Never show credentials on camera.
    const style = document.createElement('style');
    style.textContent = '.aiide input[readonly], .aiide textarea[readonly] { filter: blur(7px); } .theia-notifications-container, .theia-notification-center { display: none !important; }';
    document.head.append(style);
  });
const trust = async () => {
  await delay(1500);
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Yes, I trust'))?.click());
  await delay(800);
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Never')?.click());
};
const openWorkbench = async () => {
  await page.waitForSelector('[id="shell-tab-aiide.workbench"]', { timeout: 90000 });
  await trust();
  await page.click('[id="shell-tab-aiide.workbench"]');
  await page.waitForSelector('.aiide-welcome, .aiide-tabs', { timeout: 90000 });
  if (await page.$('.aiide-welcome')) await click('Open engineering workspace');
  await page.waitForSelector('.aiide-tabs', { timeout: 90000 });
};

// ---- Workspace state read from disk (the IDE writes these files) ----
const evalFiles = () => {
  const dir = path.join(project, '.aiide/evals');
  return fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f))))
        .sort((a, b) => a.started - b.started)
    : [];
};
const evalNamed = (name) => evalFiles().filter((e) => e.name === name).at(-1);
const waitEval = (name) => until(() => ['completed', 'failed', 'cancelled'].includes(evalNamed(name)?.status) && evalNamed(name));
const models = () => {
  const dir = path.join(project, 'models');
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).flatMap((d) => {
        try {
          return [{ path: `models/${d}`, ...JSON.parse(fs.readFileSync(path.join(dir, d, 'aiide-model.json'))) }];
        } catch {
          return [];
        }
      })
    : [];
};
const pct = (x) => Math.round(x * 100);
const save = () => fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
const record = (name, data) => {
  const s = data.summary;
  results[name] = {
    exact: pct(s.scorers.json_match.mean),
    fields: pct(s.scorers.triage_reward.mean),
    perRequest: +s.throughput.perRequest.toFixed(1),
    aggregate: +s.throughput.aggregate.toFixed(1),
    p50: +(s.latency.p50 / 1000).toFixed(1),
    outputTokens: s.tokens.output,
  };
  save();
};

// ---- Reusable UI flows ----
const serve = async (modelLabel, engine) => {
  await nav('Evals');
  await top();
  await field('Model or LoRA adapter', modelLabel);
  await field('Inference engine', engine);
  await click('Serve model');
};
const waitServer = () => find('Evaluate this', 'button', 10 * 60000);
const stopServers = async () => {
  await nav('Evals');
  for (;;) {
    const stop = await page.evaluateHandle(() =>
      [...document.querySelectorAll('.aiide-server button')].find((b) => b.textContent.trim() === 'Stop'),
    );
    if (!stop.asElement()) break;
    await stop.asElement().click();
    await delay(2500);
  }
};
const toggleScorer = async (label, on) => {
  const el = (await find(label, '.aiide-scorer')).asElement();
  const pressed = await el.evaluate((e) => e.getAttribute('aria-pressed') === 'true');
  if (pressed !== on) {
    await point(el);
    await el.click();
    await delay(350);
  }
};
const runEval = async ({ name, parallel = 1, agent = false }) => {
  await click('Evaluate this');
  await scrollText('2. Set up an evaluation');
  await field('Eval dataset', 'data/eval.jsonl');
  await field('Max output tokens', '96');
  await field('Parallel requests', String(parallel));
  await toggleScorer('Contains', false);
  await toggleScorer('Tool call', false);
  await toggleScorer('JSON match', true);
  await toggleScorer('Python reward', true);
  await field('Reward file', 'rewards/triage_reward.py');
  if (agent) {
    await toggleScorer('Agent review', true);
    await field('Grading rubric', RUBRIC, { fast: true });
  }
  await field('Experiment name', name);
  await click('Run evaluation');
};
const editor = async (file, line) => {
  await page.click('#theia-main-content-panel').catch(() => {});
  await page.keyboard.down('Meta');
  await page.keyboard.press('KeyP');
  await page.keyboard.up('Meta');
  await delay(700);
  await page.keyboard.type(file + (line ? ':' + line : ''), { delay: 35 });
  await delay(900);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.monaco-editor', { timeout: 30000 });
  await delay(1500);
};
const runCommand = async (command) => {
  await nav('Runs');
  await top();
  await field('Configured command', command);
  await click('Run locally');
  await page.waitForFunction(() => document.querySelector('tr.selected .aiide-badge.completed'), { timeout: 120000 });
  await delay(800);
};
const caseRow = async (text) => {
  const row = await page.evaluateHandle(
    (text) => [...document.querySelectorAll('.aiide-cases tbody tr')].find((r) => r.textContent.includes(text)),
    text,
  );
  return row.asElement();
};
const openCase = async (predicate) => {
  const row = (
    await page.evaluateHandle(
      (source) => [...document.querySelectorAll('.aiide-cases tbody tr')].find(new Function('r', 'return ' + source)),
      predicate,
    )
  ).asElement();
  assert.ok(row, 'No matching case row');
  await point(row);
  await row.evaluate((e) => e.click());
  await delay(800);
  await scrollText('Trace · case', 'h4');
};
const treeNode = async (text) => {
  const node = (
    await page.evaluateHandle(
      (text) => [...document.querySelectorAll('.aiide-tt-row')].find((r) => r.querySelector('.aiide-tt-name')?.textContent.includes(text)),
      text,
    )
  ).asElement();
  if (!node) return;
  await point(node);
  await node.evaluate((e) => e.click());
  await delay(1200);
};
const selectExperiment = async (name) => {
  await scrollText('3. Experiments');
  const row = (
    await page.evaluateHandle(
      (name) => [...document.querySelectorAll('table[aria-label="Evaluation experiments"] tbody tr')].find((r) => r.querySelector('td strong')?.textContent === name),
      name,
    )
  ).asElement();
  assert.ok(row, 'No experiment ' + name);
  await point(row);
  await row.evaluate((e) => e.click());
  await delay(2000);
};
const failing = "r.querySelector('.aiide-score-bad, .aiide-score-mid')";

const latestModel = (kind) => models().filter((m) => m.kind === kind).sort((a, b) => b.created - a.created)[0];
const modelOption = (m) => m.path.slice(-8);
const state = {};
const scenes = {
  '02-project': {
    run: async () => {
      await nav('Overview');
      await scrollText('Create a project from a template');
      await click('PEFT fine-tuning', '.aiide-template');
      await field('Folder name', 'ticket-triage');
      await click('Create project');
      await page.waitForFunction(() => location.href.includes('ticket-triage'), { timeout: 60000 });
      await openWorkbench();
      await installCursor();
      await delay(2500);
    },
    after: async () => {
      // Off camera: add the dataset generator and reward (shown and explained on camera next).
      fs.cpSync(path.join(root, 'files/make_dataset.py'), path.join(project, 'make_dataset.py'));
      fs.cpSync(path.join(root, 'files/rewards'), path.join(project, 'rewards'), { recursive: true });
      const config = loadProject(project);
      config.commands.dataset = ['python', 'make_dataset.py'];
      config.commands['dataset-round2'] = ['python', 'make_dataset.py', '--round', '2'];
      saveProject(project, config);
    },
  },
  '03-setup': {
    run: async () => {
      await nav('Finetune');
      await top();
      await click('Install locked project environment');
      await find('Ready · available hardware', 'p', 10 * 60000);
      await delay(1200);
      await scrollText('2. Download a base model');
      await field('Hugging Face repository', 'Qwen/Qwen3-0.6B');
      await click('Download model');
      await delay(4000);
    },
    after: async () => {
      await until(() => latestModel('base'), 30 * 60000, 3000);
      await delay(3000);
    },
  },
  '04-data': {
    run: async () => {
      await editor('make_dataset.py');
      await delay(9000);
      await page.click('[id="shell-tab-aiide.workbench"]');
      await delay(600);
      await runCommand('dataset');
      await scrollText('Logs', 'summary,h3,h4', 'center').catch(() => {});
      await delay(3000);
      await editor('data/eval.jsonl');
      await delay(4000);
    },
  },
  '05-try': {
    before: stopServers,
    run: async () => {
      await serve('base', 'transformers');
      await waitServer();
      await delay(1500);
      await nav('Models');
      await scrollText('Inference playground');
      await field('Model', 'serve-transformers', { scope: '.aiide-playground-controls' });
      await click('System prompt', 'summary');
      const system = await page.$('textarea[aria-label="System prompt"]');
      await point(system);
      await system.evaluate((e, value) => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(e, value);
        e.dispatchEvent(new Event('input', { bubbles: true }));
      }, SYSTEM);
      await delay(800);
      const prompt = (await page.$('textarea[aria-label="Prompt"]'));
      await point(prompt);
      await prompt.type(TICKET, { delay: 12 });
      await click('Send');
      await page.waitForSelector('.aiide-message-stats', { timeout: 120000 });
      await scrollTo('.aiide-message-stats', 'center');
      await delay(4000);
    },
  },
  '06-baseline': {
    run: async () => {
      await nav('Evals');
      await top();
      await runEval({ name: 'baseline' });
      await delay(1500);
      await scrollText('Evaluation cases', 'h3').catch(() => {});
      await scrollTo('table[aria-label="Evaluation cases"]', 'center');
      await delay(6000);
    },
    after: async () => {
      record('baseline', await waitEval('baseline'));
    },
  },
  '07-baseline-results': {
    run: async () => {
      if (only.includes('07-baseline-results')) {
        await nav('Evals');
        await selectExperiment('baseline');
      }
      await scrollTo('.aiide-stats', 'center');
      await delay(4500);
      await openCase(failing);
      await treeNode('ft-');
      await delay(3500);
      await treeNode('triage_reward');
      await delay(3500);
    },
    after: stopServers,
  },
  '08-train': {
    run: async () => {
      await nav('Finetune');
      await scrollText('3. Choose data & fine-tune');
      await field('Downloaded model or adapter', 'base');
      await field('Training dataset', 'data/train.jsonl');
      await field('Training steps', '150');
      await field('Learning rate', '0.0002');
      await field('Batch size', '4');
      await field('Maximum tokens per example', '256');
      await field('LoRA rank', '16');
      await click('Start LoRA fine-tuning');
      state.trainStart = Date.now();
      await delay(1500);
      await nav('Training');
      await top();
      await scrollTo('.aiide-metric-grid', 'start');
      await delay(25000);
    },
    after: async () => {
      const before = models().filter((m) => m.kind === 'adapter').length;
      await until(() => models().filter((m) => m.kind === 'adapter').length > before, 30 * 60000, 3000);
      const adapter = latestModel('adapter');
      results.train1_min = Math.max(1, Math.round((adapter.created - state.trainStart) / 60000));
      save();
    },
  },
  '09-eval1': {
    run: async () => {
      await nav('Training');
      await top();
      await scrollTo('.aiide-metric-grid', 'start');
      await delay(3500);
      await serve(modelOption(latestModel('adapter')), 'transformers');
      await waitServer();
      await runEval({ name: 'round1' });
      await delay(4000);
    },
    after: async () => {
      record('round1', await waitEval('round1'));
    },
  },
  '10-eval1-results': {
    run: async () => {
      if (only.includes('10-eval1-results')) {
        await nav('Evals');
        await selectExperiment('round1');
      }
      await scrollText('3. Experiments');
      await delay(4000);
      await scrollTo('.aiide-stats', 'center');
      await delay(3000);
      await openCase(`r.textContent.includes('Nobody at our company') && ${failing}`);
      await treeNode('triage_reward');
      await delay(4000);
    },
    after: stopServers,
  },
  '11-round2': {
    run: async () => {
      const line = fs.readFileSync(path.join(project, 'make_dataset.py'), 'utf8').split('\n').findIndex((l) => l.startsWith('# Round 2')) + 1;
      await editor('make_dataset.py', line);
      await delay(8000);
      await page.click('[id="shell-tab-aiide.workbench"]');
      await runCommand('dataset-round2');
      await delay(2000);
      await nav('Finetune');
      await scrollText('3. Choose data & fine-tune');
      await field('Downloaded model or adapter', 'base');
      await field('Training dataset', 'data/train.jsonl');
      await field('Training steps', '200');
      await field('Learning rate', '0.0002');
      await field('Batch size', '4');
      await field('Maximum tokens per example', '256');
      await field('LoRA rank', '16');
      await click('Start LoRA fine-tuning');
      await delay(1500);
      await nav('Training');
      await scrollTo('.aiide-metric-grid', 'start');
      await delay(12000);
    },
    after: async () => {
      const before = models().filter((m) => m.kind === 'adapter').length;
      await until(() => models().filter((m) => m.kind === 'adapter').length > before, 30 * 60000, 3000);
    },
  },
  '12-eval2': {
    run: async () => {
      await serve(modelOption(latestModel('adapter')), 'transformers');
      await waitServer();
      await runEval({ name: 'round2', agent: true });
      await delay(4000);
    },
    after: async () => {
      const data = await waitEval('round2');
      state.round2Id = data.runId;
      record('round2', data);
    },
  },
  '13-eval2-results': {
    run: async () => {
      await scrollText('3. Experiments');
      await delay(5000);
      await scrollTo('.aiide-stats', 'center');
      await delay(4500);
    },
    after: stopServers,
  },
  '14-agent': {
    run: async () => {
      await nav('Agents');
      await top();
      await field('Agent permissions', 'workflow');
      await click('Issue scoped credential');
      await delay(2000);
      const secret = await page.evaluate(() => [...document.querySelectorAll('input[readonly]')].find((e) => /^[a-f0-9]{64}$/.test(e.value))?.value);
      const mcp = await page.evaluate(() => [...document.querySelectorAll('textarea')].map((t) => t.value).find((v) => v.includes('/mcp'))?.match(/http:\/\/127\.0\.0\.1:\d+\/mcp/)?.[0]);
      assert.ok(secret && mcp, 'Credential not shown');
      // Open the IDE terminal (Terminal → New Terminal).
      await page.keyboard.press('F1');
      await delay(700);
      await page.keyboard.type('Create New Terminal', { delay: 30 });
      await delay(900);
      await page.keyboard.press('Enter');
      await page.waitForSelector('.xterm-helper-textarea', { timeout: 30000 });
      await delay(2500);
      await page.focus('.xterm-helper-textarea');
      const type = async (text, d = 16) => {
        await page.keyboard.type(text, { delay: d });
        await page.keyboard.press('Enter');
      };
      // Hand the credential over through a private file so it is never typed or shown on screen.
      const tokenFile = path.join(process.env.DEMO_SECRETS || '/tmp', `aiide-demo-token-${process.pid}`);
      fs.writeFileSync(tokenFile, secret + '\n', { mode: 0o600 });
      await type(`read -r AIIDE_MCP_TOKEN < ${tokenFile}; export AIIDE_MCP_TOKEN; rm -f ${tokenFile}; clear`);
      await delay(1500);
      const prompt = `Grade AI Engineering IDE evaluation ${evalNamed('round2').runId}: call run_workflow evals.get, judge every case against the rubric and reference, then submit all scores in one run_workflow evals.score call. Reply with a two-sentence summary.`;
      await type(
        `codex exec --sandbox read-only -c 'mcp_servers.aiide.url="${mcp}"' -c 'mcp_servers.aiide.bearer_token_env_var="AIIDE_MCP_TOKEN"' -c 'mcp_servers.aiide.tools.run_workflow.approval_mode="approve"' -c 'approval_policy="never"' "${prompt}"`,
        6,
      );
      await delay(15000);
    },
    after: async () => {
      await until(() => {
        const data = evalNamed('round2');
        return data?.summary.scorers.agent_review && data.summary.scorers.agent_review.pending === 0 && data;
      }, 20 * 60000, 3000);
      await delay(8000);
    },
  },
  '15-agent-results': {
    run: async () => {
      await delay(5000);
      await page.click('[id="shell-tab-aiide.workbench"]');
      await nav('Evals');
      const round2 = evalNamed('round2');
      results.agent_mean = round2.summary.scorers.agent_review.mean.toFixed(2);
      save();
      await selectExperiment('round2');
      await scrollTo('.aiide-stats', 'center');
      await delay(3000);
      await openCase(failing);
      await treeNode('agent_review');
      await delay(4500);
    },
  },
  '16-speed': {
    run: async () => {
      await serve(modelOption(latestModel('adapter')), 'vllm');
      await delay(6000);
    },
    after: waitServer,
  },
  '17-speed-results': {
    run: async () => {
      await nav('Evals');
      await runEval({ name: 'vllm', parallel: 8 });
      const data = await waitEval('vllm');
      record('vllm', data);
      await scrollText('3. Experiments');
      await delay(6000);
      await scrollText('1. Serve a model');
      await click('How to make inference faster', 'summary');
      await delay(5000);
      await scenes['17b-playground'].run();
    },
    after: stopServers,
  },
  // Playground half of chapter 17, recorded separately and spliced after the eval part.
  '17b-playground': {
    before: async () => {
      await serve(modelOption(latestModel('adapter')), 'vllm');
      await waitServer();
    },
    after: stopServers,
    run: async () => {
      await nav('Models');
      await scrollText('Inference playground');
      await field('Model', 'serve-vllm', { scope: '.aiide-playground-controls' });
      await click('System prompt', 'summary');
      const system = await page.$('textarea[aria-label="System prompt"]');
      await point(system);
      await system.evaluate((e, value) => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(e, value);
        e.dispatchEvent(new Event('input', { bubbles: true }));
      }, SYSTEM);
      await delay(800);
      const prompt = await page.$('textarea[aria-label="Prompt"]');
      await point(prompt);
      await prompt.type(TICKET, { delay: 10 });
      await click('Send');
      await page.waitForSelector('.aiide-message-stats', { timeout: 120000 });
      await scrollTo('.aiide-message-stats', 'center');
      await delay(5000);
    },
  },
};

const capture = async (scene) => {
  await installCursor();
  const file = path.join(assets, `${scene.id}.webm`);
  const started = Date.now();
  const recorder = await page.screencast({ path: file, fps: 24, quality: 18, ffmpegPath });
  try {
    await delay(600);
    await scenes[scene.id].run();
    await delay(Math.max(600, scene.duration * 1000 - (Date.now() - started)));
  } finally {
    await recorder.stop();
  }
  const seconds = (Date.now() - started) / 1000;
  scene.recorded = Math.round(seconds * 1000) / 1000;
  scene.duration = Math.max(scene.duration, scene.recorded);
  await page.screenshot({ path: path.join(assets, `${scene.id}.png`) });
  console.log('Recorded', scene.id, seconds.toFixed(1) + 's', 'scene', scene.duration + 's', new Date().toLocaleTimeString());
  if (timeline.includes(scene)) fs.writeFileSync(timelineFile, JSON.stringify(timeline, null, 2));
};

try {
  await page.goto(url, { waitUntil: 'networkidle2' });
  await openWorkbench();
  await installCursor();
  const extra = only.filter((id) => scenes[id] && !timeline.some((s) => s.id === id)).map((id) => ({ id, duration: 0 }));
  for (const scene of [...timeline, ...extra]) {
    if (!scenes[scene.id] || (only.length && !only.includes(scene.id))) continue;
    if (scenes[scene.id].before) await scenes[scene.id].before();
    await capture(scene);
    if (scenes[scene.id].after) await scenes[scene.id].after();
  }
  console.log(JSON.stringify(results));
} catch (error) {
  await page.screenshot({ path: path.join(assets, 'record-failure.png') });
  throw error;
} finally {
  await browser.close();
}
