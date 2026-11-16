import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import puppeteer from 'puppeteer';
import core from '../packages/core/lib/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-rag-lifecycle-'));
const name = 'aiide-rag-test-' + crypto.randomUUID().slice(0, 8);
let workspace,
  started = false,
  embeddingCalls = 0;
let bundle = '',
  browser;
const model = http.createServer(async (req, res) => {
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<main class="aiide" id="root"></main><script>' + bundle + '</script>',
    );
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(404).end();
    return;
  }
  let raw = '';
  for await (const part of req) raw += part;
  const request = JSON.parse(raw);
  if (req.url === '/api') {
    try {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify(
          await workspace.operation(request.operation, request.args),
        ),
      );
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: String(error) }));
    }
    return;
  }
  embeddingCalls++;
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      data: request.input.map((_, index) => ({ index, embedding: [1, 0, 0] })),
    }),
  );
});
try {
  execFileSync(
    'docker',
    [
      'run',
      '--pull=never',
      '--rm',
      '-d',
      '--name',
      name,
      '--memory=512m',
      '--cpus=1',
      '-p',
      '127.0.0.1::6333',
      'qdrant/qdrant:v1.16.2',
    ],
    { stdio: 'pipe' },
  );
  started = true;
  const port = execFileSync('docker', ['port', name, '6333/tcp'], {
    encoding: 'utf8',
  })
    .trim()
    .split(':')
    .at(-1);
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(url + '/collections')).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Qdrant did not start');
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(
    path.join(root, 'knowledge.md'),
    'Original source text. '.repeat(40),
  );
  fs.writeFileSync(
    path.join(root, 'other.md'),
    'Another source that must survive deletion.',
  );
  workspace = await core.Workspace.open(root);
  await workspace.connections.save({ id: 'db', kind: 'qdrant', url });
  await workspace.connections.save({
    id: 'embedding',
    kind: 'model',
    model: 'fixture',
    url: `http://127.0.0.1:${model.address().port}/v1`,
  });
  const op = (operation, args) => workspace.operation(operation, args);
  const args = {
    vector: 'db',
    embedding: 'embedding',
    collection: 'lifecycle',
    file: 'knowledge.md',
    size: 100,
    overlap: 0,
  };
  const first = await op('rag.ingest', args);
  const before = embeddingCalls;
  const duplicate = await op('rag.ingest', {
    ...args,
    file: 'alias/../knowledge.md',
  });
  assert.equal(duplicate.unchanged, true);
  assert.equal(
    embeddingCalls,
    before,
    'unchanged input should not call the embedding provider',
  );
  assert.equal(duplicate.sourceId, first.sourceId);
  const foreign = [
    {
      id: crypto.randomUUID(),
      vector: [1, 0, 0],
      payload: { source: 'knowledge.md', text: 'Legacy point' },
    },
    {
      id: crypto.randomUUID(),
      vector: [1, 0, 0],
      payload: {
        source: 'knowledge.md',
        text: 'Other workspace point',
        aiide_rag_owner: 'aiide-rag-v1',
        aiide_rag_workspace: 'other',
        aiide_rag_source_id: first.sourceId,
      },
    },
  ];
  await workspace.connections.request(
    'db',
    '/collections/lifecycle/points?wait=true',
    { points: foreign },
    undefined,
    'PUT',
  );
  await op('rag.ingest', { ...args, file: 'other.md' });
  const inventory = await op('rag.sources', {
    id: 'db',
    collection: 'lifecycle',
  });
  const old = inventory.find((source) => source.source === 'knowledge.md');
  assert.equal(inventory.length, 2);
  // Inject a transport failure into the second real Qdrant batch: old data must survive.
  fs.writeFileSync(
    path.join(root, 'knowledge.md'),
    'Updated source text. '.repeat(1000),
  );
  const request = workspace.connections.request.bind(workspace.connections);
  let batches = 0;
  workspace.connections.request = async (...values) => {
    if (
      values[0] === 'db' &&
      values[1].endsWith('/points?wait=true') &&
      ++batches === 2
    )
      throw new Error('Injected second-batch failure');
    return request(...values);
  };
  await assert.rejects(op('rag.ingest', args), /second-batch failure/);
  workspace.connections.request = request;
  const interrupted = (
    await op('rag.sources', { id: 'db', collection: 'lifecycle' })
  ).find((source) => source.source === 'knowledge.md');
  assert.equal(interrupted.pending, 64);
  assert.equal(interrupted.generations.length, 2);
  const retrieval = await op('rag.query', {
    vector: 'db',
    embedding: 'embedding',
    collection: 'lifecycle',
    query: 'source',
    limit: 20,
  });
  assert.ok(
    retrieval.points.every((point) => !point.payload.aiide_rag_pending),
    'partial new generations must not be retrieved',
  );
  assert.ok(
    interrupted.chunks > old.chunks,
    'old generation remains alongside pending chunks',
  );
  await assert.rejects(
    op('rag.removeSource', {
      id: 'db',
      collection: 'lifecycle',
      sourceId: old.sourceId,
      revision: old.revision,
      confirmed: true,
    }),
    /changed/,
  );
  const repaired = await op('rag.ingest', args);
  assert.equal(repaired.unchanged, false);
  const fresh = (
    await op('rag.sources', { id: 'db', collection: 'lifecycle' })
  ).find((source) => source.source === 'knowledge.md');
  assert.equal(fresh.pending, 0);
  assert.equal(fresh.generations.length, 1);
  assert.equal(fresh.chunks, repaired.chunks);
  assert.equal(fresh.freshness, 'current');
  const removed = await op('rag.removeSource', {
    id: 'db',
    collection: 'lifecycle',
    sourceId: fresh.sourceId,
    revision: fresh.revision,
    confirmed: true,
  });
  assert.equal(removed.removed, repaired.chunks);
  assert.ok(fs.existsSync(path.join(root, 'knowledge.md')));
  const remaining = await op('rag.sources', {
    id: 'db',
    collection: 'lifecycle',
  });
  assert.deepEqual(
    remaining.map((source) => source.source),
    ['other.md'],
  );
  const points = await (
    await workspace.connections.request(
      'db',
      '/collections/lifecycle/points/scroll',
      { limit: 500, with_payload: true, with_vector: false },
    )
  ).json();
  assert.ok(
    foreign.every((point) =>
      points.result.points.some((found) => found.id === point.id),
    ),
    'legacy and other-workspace points survive source replacement/removal',
  );
  const { outputFiles } = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
    import React from 'react';import{createRoot}from'react-dom/client';
    import{RagPanel}from'./packages/theia-extension/src/browser/rag-panel.tsx';
    const call=async(operation,args={})=>{const response=await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,args})});const value=await response.json();if(!response.ok)throw new Error(value.error);return value;};
    const perform=async action=>{try{await action();}catch(error){window.failure=String(error);}};
    createRoot(document.getElementById('root')).render(<RagPanel call={call} perform={perform} connections={[{id:'db',kind:'qdrant'},{id:'embedding',kind:'model',model:'fixture'}]} refresh={async()=>{}} attach={()=>{}}/>);
  `,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    alias: { '@theia/core/shared/react': 'react' },
  });
  bundle = outputFiles[0].text;
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
          .querySelector('input,select');
        const prototype =
          node.tagName === 'SELECT'
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(
          node,
          value,
        );
        node.dispatchEvent(
          new Event(node.tagName === 'SELECT' ? 'change' : 'input', {
            bubbles: true,
          }),
        );
      },
      label,
      value,
    );
  await page.goto(`http://127.0.0.1:${model.address().port}`);
  await page.waitForSelector('h2');
  await field('Vector database', 'db');
  await field('Embedding model', 'embedding');
  await field('Collection', 'lifecycle');
  await click('Refresh indexed sources');
  await page.waitForFunction(() =>
    document.querySelector('table')?.textContent.includes('other.md'),
  );
  await click('Select for reingestion');
  await click('Embed & ingest');
  await page.waitForFunction(() =>
    document.body.textContent.includes('"unchanged": true'),
  );
  await click('Remove indexed source');
  await click('Confirm indexed source removal');
  await page.waitForFunction(() => !document.querySelector('table'));
  assert.ok(fs.existsSync(path.join(root, 'other.md')));
  await click('Embed & ingest');
  await page.waitForFunction(() =>
    document.querySelector('table')?.textContent.includes('other.md'),
  );
  assert.equal(await page.evaluate(() => window.failure), undefined);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: real Qdrant idempotent ingestion, canonical source IDs, interrupted replacement/recovery, pending exclusion, stale removal guard, ownership-safe deletion and browser source management',
  );
} finally {
  await browser?.close();
  await workspace?.close();
  model.closeAllConnections();
  if (model.listening) await new Promise((resolve) => model.close(resolve));
  if (started) execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  fs.rmSync(root, { recursive: true, force: true });
}
