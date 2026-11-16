const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { Rag } = require('../lib/rag');
const { ProjectBundles } = require('../lib/project-bundles');
const { hash } = require('../lib/security');
const state = '.aiide/rag-state/instance.json';
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-rag-owner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function fixture(t) {
  const root = temporary(t);
  fs.writeFileSync(path.join(root, 'source.md'), 'Local reviewed evidence');
  const points = [],
    requests = [];
  const connections = {
    get: (id) => ({
      id,
      kind: id === 'db' ? 'qdrant' : 'model',
      model: 'embed',
      url: 'http://127.0.0.1:4000/v1',
    }),
    embed: async () => [[1, 0]],
    request: async (_id, resource, body) => {
      requests.push({ resource, body });
      if (resource === '/collections')
        return new Response(JSON.stringify({ result: { collections: [] } }));
      const filtered = points.filter(
        (point) =>
          (body?.filter?.must || []).every(
            (item) => !item.key || point.payload[item.key] === item.match.value,
          ) &&
          (body?.filter?.must_not || []).every(
            (item) => !item.key || point.payload[item.key] !== item.match.value,
          ),
      );
      return new Response(JSON.stringify({ result: { points: filtered } }));
    },
  };
  const rag = new Rag(root, connections, { span: () => {}, event: () => {} });
  return { root, rag, points, requests, connections };
}

test('RAG instance metadata is atomic under concurrent initialization and ignored by Git without changing user ignore rules', async (t) => {
  const root = temporary(t);
  fs.writeFileSync(path.join(root, '.gitignore'), 'custom-pattern\n');
  const script = `const {Rag}=require(process.argv[1]);process.stdout.write(new Rag(process.argv[2],{},{}).identity().id);`;
  const module = path.resolve(__dirname, '../lib/rag.js');
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      promisify(execFile)(process.execPath, ['-e', script, module, root]),
    ),
  );
  assert.equal(new Set(results.map((result) => result.stdout)).size, 1);
  assert.match(results[0].stdout, /^[a-f0-9-]{36}$/);
  assert.equal(
    fs.readFileSync(path.join(root, '.gitignore'), 'utf8'),
    'custom-pattern\n',
  );
  execFileSync('git', ['init', '-q', root]);
  const ignored = execFileSync(
    'git',
    ['-C', root, 'check-ignore', '-v', state],
    { encoding: 'utf8' },
  );
  assert.match(ignored, /rag-state\/.gitignore:1:\*/);
  const first = new Rag(root, {}, {});
  assert.equal(new Rag(root, {}, {}).identity().id, first.identity().id);
});

test('official ZIP sharing and actual Git clones receive fresh private identities', async (t) => {
  const root = temporary(t);
  fs.writeFileSync(path.join(root, 'README.md'), 'Shared source');
  const original = new Rag(root, {}, {}).identity().id;
  const bundles = new ProjectBundles(root, path.resolve(__dirname, '../../..'));
  assert.throws(() => bundles.preview({ files: [state] }), /Protected/);
  const plan = bundles.preview({ files: ['README.md'] });
  const archive = await bundles.export({
    files: ['README.md'],
    reviewHash: plan.reviewHash,
  });
  const review = await bundles.inspect({ file: archive.file });
  const imported = await bundles.import({
    file: archive.file,
    name: 'shared-copy',
    reviewHash: review.reviewHash,
  });
  assert.equal(fs.existsSync(path.join(imported.root, state)), false);
  assert.notEqual(new Rag(imported.root, {}, {}).identity().id, original);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', 'README.md']);
  execFileSync('git', [
    '-C',
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'Public sources',
  ]);
  const clone = path.join(root, 'git-copy');
  execFileSync('git', ['clone', '-q', root, clone]);
  assert.equal(fs.existsSync(path.join(clone, state)), false);
  assert.notEqual(new Rag(clone, {}, {}).identity().id, original);
});

test('reviewed offline identity reset retains old namespaces and blocks stale plans or active writes', async (t) => {
  const f = fixture(t),
    before = f.rag.identity(),
    plan = f.rag.previewIdentityReset();
  let started, rejectEmbedding;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  f.connections.embed = () =>
    new Promise((_resolve, reject) => {
      rejectEmbedding = reject;
      started();
    });
  const pending = assert.rejects(
    f.rag.ingest(
      {
        vector: 'db',
        embedding: 'embed',
        collection: 'docs',
        file: 'source.md',
        size: 100,
        overlap: 0,
      },
      'run',
    ),
    /embedding cancelled/,
  );
  await ready;
  assert.throws(() => f.rag.previewIdentityReset(), /active source mutations/);
  assert.throws(
    () => f.rag.resetIdentity({ reviewHash: plan.reviewHash, confirmed: true }),
    /active source mutations/,
  );
  rejectEmbedding(new Error('embedding cancelled'));
  await pending;
  const changed = f.rag.resetIdentity({
    reviewHash: plan.reviewHash,
    confirmed: true,
  });
  assert.equal(changed.id, plan.next);
  assert.deepEqual(changed.readOnly, [before.id]);
  assert.equal(new Rag(f.root, {}, {}).identity().id, changed.id);
  assert.throws(
    () => f.rag.resetIdentity({ reviewHash: plan.reviewHash, confirmed: true }),
    /expired or changed/,
  );
  assert.ok(
    !f.requests.some(
      (request) =>
        request.resource.includes('delete') ||
        request.resource.includes('payload'),
    ),
  );
});

test('verified path-owned legacy evidence is read-only, stale evidence is withheld, and new copies are preferred without dropping foreign points', async (t) => {
  const f = fixture(t),
    text = fs.readFileSync(path.join(f.root, 'source.md'), 'utf8');
  const payload = {
    source: 'source.md',
    text,
    start: 0,
    end: text.length,
    aiide_rag_owner: 'aiide-rag-v1',
    aiide_rag_workspace: hash(fs.realpathSync(f.root)),
    aiide_rag_source_id: hash('old source'),
    aiide_rag_generation: hash('old generation'),
    aiide_rag_hash: hash(text),
    aiide_rag_pending: false,
  };
  f.points.push({ id: 'legacy', payload });
  const [legacy] = await f.rag.sources('db', 'docs');
  assert.equal(legacy.ownership, 'legacy-readonly');
  await assert.rejects(
    f.rag.removeSource({
      id: 'db',
      collection: 'docs',
      sourceId: legacy.sourceId,
      revision: legacy.revision,
      confirmed: true,
    }),
    /read-only legacy/,
  );
  const args = {
    vector: 'db',
    collection: 'docs',
    query: 'reviewed',
    mode: 'lexical',
  };
  assert.equal(
    (await f.rag.query(args, 'first')).points[0].sourceOwnership,
    'legacy-readonly',
  );
  fs.writeFileSync(path.join(f.root, 'source.md'), 'Changed original');
  const stale = await f.rag.query(args, 'second');
  assert.deepEqual(stale.points, []);
  assert.equal(stale.retrieval.excludedLegacy, 1);
  fs.writeFileSync(path.join(f.root, 'source.md'), text);
  f.points.push(
    {
      id: 'current',
      payload: {
        ...payload,
        aiide_rag_workspace: f.rag.identity().id,
        aiide_rag_source_id: hash('new source'),
      },
    },
    { id: 'foreign', payload: { source: 'source.md', text } },
  );
  const dedup = await f.rag.query(args, 'third');
  assert.deepEqual(
    new Set(dedup.points.map((point) => point.id)),
    new Set(['current', 'foreign']),
  );
  assert.equal(dedup.retrieval.deduplicated, 1);
  assert.equal(f.points.length, 3);
  assert.ok(!f.requests.some((request) => request.resource.includes('delete')));
});

test('identity metadata rejects symlinks, FIFOs, oversized files and unexpected ignore policies without replacing them', (t) => {
  for (const kind of ['symlink', 'large', 'json', 'policy', 'fifo']) {
    if (kind === 'fifo' && process.platform === 'win32') continue;
    const root = temporary(t),
      folder = path.join(root, '.aiide/rag-state');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, '.gitignore'),
      kind === 'policy' ? '!instance.json\n' : '*\n',
    );
    const file = path.join(root, state);
    if (kind === 'symlink') fs.symlinkSync(path.join(root, 'missing'), file);
    if (kind === 'large') fs.writeFileSync(file, 'x'.repeat(4097));
    if (kind === 'json') fs.writeFileSync(file, '{}');
    if (kind === 'fifo') execFileSync('mkfifo', [file]);
    const script = `try{new(require(process.argv[1]).Rag)(process.argv[2],{},{});process.exit(2);}catch{process.exit(0);}`;
    execFileSync(
      process.execPath,
      ['-e', script, path.resolve(__dirname, '../lib/rag.js'), root],
      { timeout: 2000 },
    );
    if (kind === 'json') assert.equal(fs.readFileSync(file, 'utf8'), '{}');
  }
});

test('failed namespace writes remove only their own temporary file and can be retried', (t) => {
  const root = temporary(t),
    original = fs.writeFileSync;
  const mock = t.mock.method(fs, 'writeFileSync', (file, data, ...args) => {
    if (typeof file === 'number' && String(data).includes('"version":1'))
      throw Object.assign(new Error('No space left'), { code: 'ENOSPC' });
    return original(file, data, ...args);
  });
  assert.throws(() => new Rag(root, {}, {}), /No space left/);
  assert.deepEqual(fs.readdirSync(path.join(root, '.aiide/rag-state')), [
    '.gitignore',
  ]);
  mock.mock.restore();
  assert.match(new Rag(root, {}, {}).identity().id, /^[a-f0-9-]{36}$/);
});

test('legacy evidence that changes during answer generation is removed from returned context', async (t) => {
  const f = fixture(t),
    text = fs.readFileSync(path.join(f.root, 'source.md'), 'utf8');
  f.points.push({
    id: 'legacy',
    payload: {
      source: 'source.md',
      text,
      start: 0,
      end: text.length,
      aiide_rag_owner: 'aiide-rag-v1',
      aiide_rag_workspace: hash(fs.realpathSync(f.root)),
      aiide_rag_source_id: hash('legacy-source'),
      aiide_rag_generation: hash('legacy-generation'),
      aiide_rag_hash: hash(text),
      aiide_rag_pending: false,
    },
  });
  const original = f.connections.request;
  f.connections.request = async (...args) => {
    if (args[1] === '/chat/completions') {
      fs.writeFileSync(
        path.join(f.root, 'source.md'),
        'Changed during generation',
      );
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'An answer from the old source' } }],
        }),
      );
    }
    return original(...args);
  };
  const result = await f.rag.query(
    {
      vector: 'db',
      collection: 'docs',
      query: 'reviewed',
      mode: 'lexical',
      model: 'answer',
    },
    'run',
  );
  assert.deepEqual(result.points, []);
  assert.equal(result.retrieval.excludedLegacy, 1);
  assert.match(result.answer, /Sources changed/);
});
