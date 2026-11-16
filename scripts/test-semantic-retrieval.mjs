import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import puppeteer from 'puppeteer';
import core from '../packages/core/lib/index.js';

const python = process.env.AIIDE_EMBEDDING_TEST_PYTHON;
const model = process.env.AIIDE_EMBEDDING_TEST_MODEL;
assert.ok(
  python && model,
  'Set AIIDE_EMBEDDING_TEST_PYTHON (model2vec==0.10.0) and AIIDE_EMBEDDING_TEST_MODEL (verified potion-base-8M directory). No models are downloaded by this test.',
);
const files = {
  'config.json':
    '2a6ac0e9aaa356a68a5688070db78fc3a464fefe85d2f06a1905ce3718687553',
  'model.safetensors':
    'f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2',
  'modules.json':
    'a68dcbed0429dcdd5bfdca92b0b03cc30d09122c0a3fcf4758787d4b244e45b2',
  'special_tokens_map.json':
    'a9e8fb6f99fb0b8803f0e6942fdf4d95d6645204620b67dc3310a1024bcbac59',
  'tokenizer.json':
    'e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50',
  'tokenizer_config.json':
    '6725995e3ab3039857ff5bd99178a7cdf42863abb04449e7bb31feb1f55fe567',
};
for (const [file, digest] of Object.entries(files))
  assert.equal(
    crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(model, file)))
      .digest('hex'),
    digest,
    file,
  );
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-real-semantic-'));
const container = 'aiide-semantic-' + crypto.randomUUID().slice(0, 8);
const worker = spawn(
  python,
  [
    '-u',
    '-c',
    `
import sys,json,importlib.metadata
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
from model2vec import StaticModel
assert importlib.metadata.version('model2vec')=='0.10.0'
model=StaticModel.from_pretrained(sys.argv[1])
class Handler(BaseHTTPRequestHandler):
 def do_POST(self):
  n=int(self.headers.get('Content-Length','0'))
  if not 0<n<=1000000:self.send_error(413);return
  data=json.loads(self.rfile.read(n));vectors=model.encode(data['input']).tolist()
  body=json.dumps({'data':[{'index':i,'embedding':v} for i,v in enumerate(vectors)]}).encode()
  self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
print(json.dumps({'port':server.server_address[1]}),flush=True)
server.serve_forever()
`,
    model,
  ],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HF_HUB_OFFLINE: '1',
      TOKENIZERS_PARALLELISM: 'false',
    },
  },
);
const workerDone = new Promise((resolve) => worker.once('close', resolve));
let diagnostics = '',
  workspace,
  browser,
  frontend,
  started = false;
worker.stderr.on('data', (chunk) => {
  diagnostics = (diagnostics + chunk.toString()).slice(-8000);
});
try {
  const port = await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(
      () =>
        reject(new Error('Embedding server startup timed out: ' + diagnostics)),
      30000,
    );
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Embedding server exited ${code}: ${diagnostics}`));
    });
    worker.stdout.on('data', (chunk) => {
      text += chunk;
      if (text.includes('\n')) {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(text.split('\n')[0]).port);
        } catch (error) {
          reject(error);
        }
      }
    });
  });
  execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--pull=never',
      '-d',
      '--name',
      container,
      '--memory=512m',
      '--cpus=1',
      '-p',
      '127.0.0.1::6333',
      'qdrant/qdrant:v1.16.2',
    ],
    { stdio: 'pipe' },
  );
  started = true;
  const dbPort = execFileSync('docker', ['port', container, '6333/tcp'], {
    encoding: 'utf8',
  })
    .trim()
    .split(':')
    .at(-1);
  const db = `http://127.0.0.1:${dbPort}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(db + '/collections')).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Qdrant failed to start');
  workspace = await core.Workspace.open(root);
  await workspace.connections.save({
    id: 'embedding',
    kind: 'model',
    model: 'potion-base-8M',
    url: `http://127.0.0.1:${port}/v1`,
  });
  await workspace.connections.save({ id: 'db', kind: 'qdrant', url: db });
  const documents = {
    'vehicle.md':
      'Automobiles need petrol. The engine uses fuel for travel. Schedule routine maintenance for cars.',
    'cooking.md': 'A ripe apple grows on a tree and can be baked in a pie.',
    'policy.md':
      'A reinforcement learning policy improves reward through environment interactions.',
    'exception.md': 'Ticket ZXQ912 requires manual approval before shipment.',
  };
  for (const [file, text] of Object.entries(documents))
    fs.writeFileSync(path.join(root, file), text);
  const car = workspace.knowledge.importSources({
    title: 'Vehicle servicing',
    files: ['vehicle.md'],
  });
  workspace.knowledge.importSources({
    title: 'Cooking',
    files: ['cooking.md'],
  });
  workspace.knowledge.importSources({
    title: 'Policy training',
    files: ['policy.md'],
  });
  const op = (name, args) => workspace.operation(name, args);
  await op('knowledge.indexSemantic', { embedding: 'embedding' });
  const found = await op('knowledge.searchSemantic', {
    query: 'Which liquid powers a car?',
    mode: 'semantic',
  });
  assert.equal(found.pages[0].id, car.id);
  assert.ok(found.pages[0].semanticScore > 0.3);
  assert.equal(
    workspace.knowledge.list('Which liquid powers a car?').length,
    0,
  );
  for (const file of Object.keys(documents))
    await op('rag.ingest', {
      vector: 'db',
      embedding: 'embedding',
      collection: 'semantic',
      file,
      size: 800,
      overlap: 0,
    });
  const request = {
    vector: 'db',
    embedding: 'embedding',
    collection: 'semantic',
  };
  // Two hosts can share a canonical path while keeping independent private state.
  const identityFile = path.join(root, '.aiide/rag-state/instance.json');
  const firstState = fs.readFileSync(identityFile);
  fs.unlinkSync(identityFile);
  const other = new core.Rag(root, workspace.connections, {
    span: () => {},
    event: () => {},
  });
  assert.notEqual(other.identity().id, workspace.rag.identity().id);
  fs.writeFileSync(identityFile, firstState);
  const mutation = { ...request, file: 'vehicle.md', size: 800, overlap: 0 };
  await other.ingest(mutation, 'independent-host');
  const beforeOther = (await other.sources('db', 'semantic')).find(
    (source) => source.namespace === other.identity().id,
  );
  fs.appendFileSync(
    path.join(root, 'vehicle.md'),
    ' Maintenance guidance was updated.',
  );
  await op('rag.ingest', mutation);
  const owned = (
    await op('rag.sources', { id: 'db', collection: 'semantic' })
  ).find(
    (source) =>
      source.source === 'vehicle.md' && source.ownership === 'current',
  );
  await op('rag.removeSource', {
    id: 'db',
    collection: 'semantic',
    sourceId: owned.sourceId,
    revision: owned.revision,
    confirmed: true,
  });
  assert.equal(
    (await other.sources('db', 'semantic')).find(
      (source) => source.namespace === other.identity().id,
    ).revision,
    beforeOther.revision,
    'one host must not replace or prune another namespace at an identical path',
  );
  const legacyText =
    'Legacy reviewed evidence remains useful when local provenance matches.';
  fs.writeFileSync(path.join(root, 'legacy.md'), legacyText);
  const digest = (value) =>
    crypto.createHash('sha256').update(value).digest('hex');
  const legacyId = crypto.randomUUID();
  const [legacyVector] = await workspace.connections.embed('embedding', [
    legacyText,
  ]);
  const legacyPayload = {
    source: 'legacy.md',
    text: legacyText,
    start: 0,
    end: legacyText.length,
    aiide_rag_owner: 'aiide-rag-v1',
    aiide_rag_workspace: digest(fs.realpathSync(root)),
    aiide_rag_source_id: digest(fs.realpathSync(root) + '\nlegacy.md'),
    aiide_rag_generation: digest('legacy-generation'),
    aiide_rag_hash: digest(legacyText),
    aiide_rag_pending: false,
  };
  await workspace.connections.request(
    'db',
    '/collections/semantic/points?wait=true',
    {
      points: [{ id: legacyId, vector: legacyVector, payload: legacyPayload }],
    },
    undefined,
    'PUT',
  );
  const legacy = (
    await op('rag.sources', { id: 'db', collection: 'semantic' })
  ).find((source) => source.ownership === 'legacy-readonly');
  assert.ok(legacy);
  await assert.rejects(
    op('rag.removeSource', {
      id: 'db',
      collection: 'semantic',
      sourceId: legacy.sourceId,
      revision: legacy.revision,
      confirmed: true,
    }),
    /read-only legacy/,
  );
  const legacyQuery = {
    vector: 'db',
    collection: 'semantic',
    query: 'Legacy',
    mode: 'lexical',
  };
  assert.equal(
    (await op('rag.query', legacyQuery)).points[0].sourceOwnership,
    'legacy-readonly',
  );
  fs.writeFileSync(path.join(root, 'legacy.md'), 'Changed original');
  assert.equal(
    (await op('rag.query', legacyQuery)).retrieval.excludedLegacy,
    1,
  );
  fs.writeFileSync(path.join(root, 'legacy.md'), legacyText);
  await op('rag.ingest', {
    ...request,
    file: 'legacy.md',
    size: 800,
    overlap: 0,
  });
  const dedup = await op('rag.query', legacyQuery);
  assert.equal(dedup.points.length, 1);
  assert.equal(dedup.points[0].sourceOwnership, 'current');
  assert.equal(dedup.retrieval.deduplicated, 1);
  const retained = await (
    await workspace.connections.request('db', '/collections/semantic/points', {
      ids: [legacyId],
      with_payload: true,
    })
  ).json();
  assert.equal(
    retained.result[0].id,
    legacyId,
    'legacy point must remain physically retained',
  );

  const semantic = await op('rag.query', {
    ...request,
    query: 'Which liquid powers a car?',
  });
  assert.equal(semantic.points[0].payload.source, 'vehicle.md');
  const lexical = await op('rag.query', {
    vector: 'db',
    collection: 'semantic',
    query: 'ZXQ912',
    mode: 'lexical',
  });
  assert.equal(lexical.points[0].payload.source, 'exception.md');
  const hybrid = await op('rag.query', {
    ...request,
    query: 'ZXQ912',
    mode: 'hybrid',
  });
  assert.equal(hybrid.points[0].payload.source, 'exception.md');
  assert.ok(hybrid.points[0].fusionScore > 0);
  fs.writeFileSync(
    path.join(root, 'evaluation.jsonl'),
    JSON.stringify({ input: 'ZXQ912', expected: 'manual approval' }) + '\n',
  );
  const evaluation = await op('evaluations.rag', {
    vector: 'db',
    collection: 'semantic',
    dataset: 'evaluation.jsonl',
    mode: 'lexical',
  });
  assert.equal(
    evaluation.passed,
    1,
    'lexical RAG evaluation must use the same selected pipeline without embedding credentials',
  );
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'tsx',
      contents: `
 import React from 'react';import{createRoot}from'react-dom/client';
 import{KnowledgePanel}from'./packages/theia-extension/src/browser/knowledge-panel.tsx';
 import{RagPanel}from'./packages/theia-extension/src/browser/rag-panel.tsx';
 const call=async(operation,args={})=>{const res=await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,args})});const data=await res.json();if(!res.ok)throw new Error(data.error);return data;};
 const perform=async fn=>{try{await fn();}catch(error){window.failure=String(error);}};
 const connections=[{id:'embedding',kind:'model',model:'potion-base-8M'},{id:'db',kind:'qdrant'}];
 const root=createRoot(document.getElementById('root'));window.show=page=>root.render(page==='memory'?<KnowledgePanel call={call} perform={perform} connections={connections} attach={()=>{}}/>:<RagPanel call={call} perform={perform} connections={connections} refresh={async()=>{}} attach={()=>{}}/>);window.show('memory');
 `,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    alias: { '@theia/core/shared/react': 'react' },
  });
  frontend = http.createServer(async (req, res) => {
    try {
      if (req.url === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end(
          '<main id="root"></main><script>' +
            bundle.outputFiles[0].text +
            '</script>',
        );
        return;
      }
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(await op(body.operation, body.args)));
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise((resolve) => frontend.listen(0, '127.0.0.1', resolve));
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
  await page.goto(`http://127.0.0.1:${frontend.address().port}`);
  const control = async (label, tag) => {
    const handle = await page.evaluateHandle(
      (label, tag) =>
        [...document.querySelectorAll('label')]
          .find((node) => node.textContent.trim().startsWith(label))
          ?.querySelector(tag),
      label,
      tag,
    );
    const element = handle.asElement();
    assert.ok(element, label);
    return element;
  };
  const click = async (text) =>
    page.evaluate((text) => {
      const node = [...document.querySelectorAll('button')].find(
        (node) =>
          node.textContent.replace(/\s+/g, ' ').trim() ===
          text.replace(/\s+/g, ' ').trim(),
      );
      if (!node || node.disabled) throw new Error('Unavailable button ' + text);
      node.click();
    }, text);
  await page.waitForSelector('form');
  await (await control('Memory search method', 'select')).select('semantic');
  await (
    await control('Search memory', 'input')
  ).type('Which liquid powers a car?');
  await click('Search');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('small')].some((node) =>
      node.textContent.startsWith('Cosine '),
    ),
  );
  assert.match(
    await page.$eval('section.aiide-card', (node) => node.textContent),
    /Vehicle servicing/,
  );
  await page.evaluate(() => window.show('rag'));
  await page.waitForFunction(() =>
    [...document.querySelectorAll('h3')].some(
      (node) => node.textContent.trim() === 'Test retrieval',
    ),
  );
  await (await control('Vector database', 'select')).select('db');
  await (
    await control('Collection', 'input')
  ).evaluate((node) => node.select());
  await (await control('Collection', 'input')).type('semantic');
  assert.equal(
    await (await control('Collection', 'input')).evaluate((node) => node.value),
    'semantic',
  );
  await (await control('Retrieval method', 'select')).select('lexical');
  await (await control('Question', 'textarea')).type('ZXQ912');
  await click('Retrieve →');
  await page.waitForFunction(
    () => document.querySelector('.aiide-chunk') || window.failure,
  );
  assert.equal(await page.evaluate(() => window.failure), undefined);
  assert.match(
    await page.$eval('.aiide-chunk', (node) => node.textContent),
    /exception.md/,
  );
  assert.equal(await page.evaluate(() => window.failure), undefined);
  assert.deepEqual(errors, []);
  await page.evaluate(() =>
    [...document.querySelectorAll('summary')]
      .find((node) => node.textContent.includes('Workspace identity'))
      .click(),
  );
  const beforeReset = workspace.rag.identity().id;
  await click('Preview new RAG identity');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('p')].some((node) =>
      node.textContent.includes('No database points will be deleted.'),
    ),
  );
  await click('Apply reviewed RAG identity');
  await page.waitForFunction(
    (id) => {
      const node = [...document.querySelectorAll('p')].find((node) =>
        node.textContent.trim().startsWith('Current RAG identity:'),
      );
      return Boolean(node && !node.textContent.includes(id));
    },
    {},
    beforeReset,
  );
  assert.notEqual(workspace.rag.identity().id, beforeReset);
  await click('Refresh indexed sources');
  await page.waitForSelector('.aiide-table tbody tr');
  assert.ok(
    await page.$$eval('.aiide-table tbody button', (buttons) =>
      buttons
        .filter(
          (button) => button.textContent.trim() === 'Remove indexed source',
        )
        .every((button) => button.disabled),
    ),
    'retained namespace delete buttons must be disabled',
  );

  const current = workspace.knowledge.get(car.id);
  workspace.knowledge.save({
    ...current,
    body: 'A changed note needs a new index.',
  });
  assert.ok(
    (
      await op('knowledge.searchSemantic', {
        query: 'Which liquid powers a car?',
      })
    ).pages.every((note) => note.id !== car.id),
  );
  assert.equal(
    (
      await op('knowledge.indexSemantic', {
        embedding: 'embedding',
        ids: [car.id],
      })
    ).updated,
    1,
  );
  await workspace.close();
  workspace = await core.Workspace.open(root);
  assert.equal((await op('knowledge.semanticStatus')).stale, 0);
  console.log(
    'PASS: verified actual model2vec/potion embeddings → semantic memory/restart/stale exclusion → real Qdrant semantic/BM25/hybrid search → actual memory/RAG browser controls, same-path independent namespace isolation, legacy read-only retention/deduplication and reviewed identity reset. Model revision bf8b056651a2c21b8d2565580b8569da283cab23; no chat-model quality claim.',
  );
} finally {
  await browser?.close();
  if (frontend) {
    frontend.closeAllConnections();
    await new Promise((resolve) => frontend.close(resolve));
  }
  await workspace?.close();
  worker.kill('SIGTERM');
  const forced = setTimeout(() => worker.kill('SIGKILL'), 3000);
  await workerDone;
  clearTimeout(forced);
  if (started)
    execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  fs.rmSync(root, { recursive: true, force: true });
}
