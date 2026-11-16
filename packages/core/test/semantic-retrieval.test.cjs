const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Knowledge } = require('../lib/knowledge');
const { Rag } = require('../lib/rag');
const { hash } = require('../lib/security');
const { retrievalJson } = require('../lib/retrieval');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-semantic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let model = 'embedding-v1',
    calls = 0;
  const connections = {
    get: (id) =>
      id === 'db'
        ? { id, kind: 'qdrant' }
        : { id, kind: 'model', url: 'http://127.0.0.1:4000/v1', model },
    embed: async (_id, texts) => {
      calls++;
      return texts.map((text) =>
        /petrol|vehicle|gasoline|car/i.test(text) ? [1, 0, 0] : [0, 1, 0],
      );
    },
  };
  const memory = new Knowledge(root, connections);
  t.after(() => memory.close());
  return {
    root,
    connections,
    memory,
    calls: () => calls,
    changeModel: () => {
      model = 'embedding-v2';
    },
  };
}

test('semantic memory survives reopen, reuses unchanged vectors and excludes edited/deleted pages', async (t) => {
  const f = setup(t);
  const car = f.memory.save({
    title: 'Vehicle servicing',
    body: 'Petrol powers the engine.',
  });
  const apple = f.memory.save({
    title: 'Cooking',
    body: 'An apple grows on a tree.',
  });
  assert.equal(
    (await f.memory.indexSemantic({ embedding: 'embed' })).indexed,
    2,
  );
  const count = f.calls();
  assert.equal(
    (await f.memory.indexSemantic({ embedding: 'embed' })).updated,
    0,
  );
  assert.equal(f.calls(), count);
  const reopened = new Knowledge(f.root, f.connections);
  t.after(() => reopened.close());
  const found = await reopened.searchSemantic({
    query: 'gasoline refill',
    mode: 'semantic',
  });
  assert.equal(found.pages[0].id, car.id);
  assert.equal(found.pages[0].semanticScore, 1);
  f.memory.save({ ...car, body: 'A completely changed policy.' });
  assert.equal(f.memory.semanticStatus().stale, 1);
  const current = await reopened.searchSemantic({ query: 'gasoline refill' });
  assert.equal(current.excluded, 1);
  assert.ok(current.pages.every((page) => page.id !== car.id));
  f.memory.delete(apple.id, apple.revision);
  assert.deepEqual(
    (await reopened.searchSemantic({ query: 'gasoline refill' })).pages,
    [],
  );
  f.changeModel();
  await assert.rejects(
    reopened.searchSemantic({ query: 'gasoline' }),
    /connection changed/,
  );
});

test('indexing is atomic when source changes during provider work and closing cancels generation', async (t) => {
  const f = setup(t);
  const note = f.memory.save({
    title: 'Vehicle',
    body: 'Petrol powers the car.',
  });
  await f.memory.indexSemantic({ embedding: 'embed' });
  const file = path.join(f.root, '.aiide/memory-index.json'),
    before = fs.readFileSync(file, 'utf8');
  const updated = f.memory.save({
    ...note,
    body: 'Gasoline powers a vehicle.',
  });
  f.connections.embed = async (_id, texts) => {
    f.memory.save({ ...updated, body: 'Changed during provider call' });
    return texts.map(() => [1, 0, 0]);
  };
  await assert.rejects(
    f.memory.indexSemantic({ embedding: 'embed' }),
    /changed while indexing/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  f.connections.embed = (_id, _texts, signal) =>
    new Promise((_resolve, reject) => {
      started();
      signal.addEventListener('abort', () => reject(new Error('cancelled')), {
        once: true,
      });
    });
  const pending = assert.rejects(
    f.memory.indexSemantic({ embedding: 'embed' }),
    /cancelled/,
  );
  await ready;
  await f.memory.close();
  await pending;
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  await assert.rejects(
    f.memory.indexSemantic({ embedding: 'embed' }),
    /closed/,
  );
});

test('semantic index rejects inconsistent/zero/oversized vectors and symlinked caches', async (t) => {
  const f = setup(t);
  f.memory.save({ title: 'First', body: 'Body' });
  for (const vector of [[0, 0], [NaN, 1], new Array(4097).fill(1)]) {
    f.connections.embed = async () => [vector];
    await assert.rejects(
      f.memory.indexSemantic({ embedding: 'embed' }),
      /Embedding/,
    );
  }
  fs.mkdirSync(path.join(f.root, '.aiide'), { recursive: true });
  fs.symlinkSync(
    path.join(f.root, 'elsewhere'),
    path.join(f.root, '.aiide/memory-index.json'),
  );
  assert.throws(() => f.memory.semanticStatus(), /Symbolic|ENOENT/);
});

function ragFixture(t, points) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-hybrid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests = [];
  let embeddings = 0,
    order = [1, 0];
  const connections = {
    get: (id) => ({
      id,
      kind: id === 'db' ? 'qdrant' : 'model',
      model: 'fixture',
    }),
    embed: async () => {
      embeddings++;
      return [[1, 0]];
    },
    request: async (id, resource, body) => {
      requests.push({ id, resource, body });
      if (resource === '/chat/completions')
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ order }) } }],
          }),
        );
      if (resource.endsWith('/query'))
        return {
          json: async () => ({
            result: {
              points: points.map((point, index) => ({
                ...point,
                score: 1 - index * 0.2,
              })),
            },
          }),
        };
      return { json: async () => ({ result: { points } }) };
    },
  };
  return {
    rag: new Rag(root, connections, { span: () => {}, event: () => {} }),
    root,
    connections,
    requests,
    embeddings: () => embeddings,
    setOrder: (value) => {
      order = value;
    },
  };
}

test('lexical retrieval needs no embedding and hybrid fusion recovers exact identifiers', async (t) => {
  const points = [
    {
      id: 'semantic',
      payload: { source: 'general.md', text: 'Most policies are ordinary.' },
    },
    {
      id: 'identifier',
      payload: {
        source: 'exception.md',
        text: 'Ticket ZXQ912 requires manual approval.',
      },
    },
  ];
  const f = ragFixture(t, points);
  const lexical = await f.rag.query(
    { vector: 'db', collection: 'docs', query: 'ZXQ912', mode: 'lexical' },
    'run',
  );
  assert.equal(lexical.points[0].id, 'identifier');
  assert.equal(f.embeddings(), 0);
  const hybrid = await f.rag.query(
    {
      vector: 'db',
      embedding: 'embed',
      collection: 'docs',
      query: 'ZXQ912',
      mode: 'hybrid',
    },
    'run',
  );
  assert.equal(hybrid.points[0].id, 'identifier');
  assert.ok(hybrid.points[0].fusionScore > 0);
  assert.ok(hybrid.points[0].lexicalScore > 0);
  assert.equal(hybrid.points[0].vectorScore, 0.8);
  assert.ok(
    f.requests.every((request) => !request.resource.includes('delete')),
  );
  assert.ok(
    f.requests
      .filter((request) => request.body.filter)
      .every(
        (request) =>
          request.body.filter.must_not[0].key === 'aiide_rag_pending',
      ),
  );
});

test('RAG refuses stale original-document text as answer context without sending it to the model', async (t) => {
  const points = [];
  const f = ragFixture(t, points);
  fs.writeFileSync(path.join(f.root, 'source.pdf'), 'Original PDF evidence');
  const metadata = Buffer.from(
    JSON.stringify({ file: 'source.pdf', hash: hash('Original PDF evidence') }),
  ).toString('base64url');
  const markdown = `<!-- aiide-document-source-v1:${metadata} -->\n# Reviewed evidence\nOriginal facts`;
  fs.writeFileSync(path.join(f.root, 'source.md'), markdown);
  points.push({
    id: 'a',
    payload: {
      source: 'source.md',
      text: 'Original facts',
      aiide_rag_owner: 'aiide-rag-v1',
      aiide_rag_workspace: f.rag.identity().id,
      start: markdown.indexOf('Original facts'),
      end: markdown.length,
      aiide_rag_hash: hash(markdown),
    },
  });
  fs.writeFileSync(
    path.join(f.root, 'source.pdf'),
    'Changed original PDF evidence',
  );
  const result = await f.rag.query(
    {
      vector: 'db',
      embedding: 'embed',
      model: 'answer',
      collection: 'docs',
      query: 'What are the facts?',
    },
    'run',
  );
  assert.equal(result.points[0].sourceStatus, 'changed');
  assert.equal(result.warnings.length, 1);
  assert.match(result.answer, /No current reference/);
  assert.ok(
    !f.requests.some((request) => request.resource === '/chat/completions'),
  );
  fs.writeFileSync(path.join(f.root, 'source.pdf'), 'Original PDF evidence');
  const original = f.connections.request;
  f.connections.request = async (...args) => {
    if (args[1] === '/chat/completions')
      fs.writeFileSync(
        path.join(f.root, 'source.pdf'),
        'Changed while generating',
      );
    return original(...args);
  };
  const changed = await f.rag.query(
    {
      vector: 'db',
      embedding: 'embed',
      model: 'answer',
      collection: 'docs',
      query: 'What are the facts?',
    },
    'second',
  );
  assert.match(changed.answer, /Sources changed while generating/);
  assert.equal(changed.points[0].sourceStatus, 'changed');
});

test('retrieval response byte budgets cancel oversized network bodies before JSON allocation', async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(65537));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await assert.rejects(retrievalJson(response, 65536), /byte budget/);
  assert.equal(cancelled, true);
});

test('reranker can only reorder validated candidates and preserves retrieval scores', async (t) => {
  const f = ragFixture(t, [
    { id: 'a', payload: { text: 'first passage', source: 'a.md' } },
    { id: 'b', payload: { text: 'second passage', source: 'b.md' } },
  ]);
  const args = {
    vector: 'db',
    embedding: 'embed',
    collection: 'docs',
    query: 'question',
    reranker: 'reranker',
  };
  const result = await f.rag.query(args, 'run');
  assert.deepEqual(
    result.points.map((point) => point.id),
    ['b', 'a'],
  );
  assert.equal(result.points[0].score, 0.8);
  assert.equal(result.points[0].rerankRank, 1);
  for (const invalid of [[0, 0], [0, 2], ['invented', 0], [0]]) {
    f.setOrder(invalid);
    await assert.rejects(f.rag.query(args, 'run'));
  }
});

test('retrieval fails closed on incomplete generations, malformed candidates and lexical quotas', async (t) => {
  for (const points of [
    [{ id: 'a', payload: { text: 'unfinished', aiide_rag_pending: true } }],
    [{ id: 'a', payload: { text: 'x'.repeat(10001) } }],
    new Array(2001).fill({ id: 'a', payload: { text: 'ordinary' } }),
  ]) {
    const f = ragFixture(t, points);
    await assert.rejects(
      f.rag.query(
        {
          vector: 'db',
          collection: 'docs',
          query: 'ordinary',
          mode: 'lexical',
        },
        'run',
      ),
    );
  }
});

test('notes changed or deleted during query inference are excluded with a truthful nonnegative count', async (t) => {
  const f = setup(t),
    car = f.memory.save({ title: 'Vehicle', body: 'Petrol powers the car.' }),
    apple = f.memory.save({ title: 'Cooking', body: 'Fruit grows on a tree.' });
  await f.memory.indexSemantic({ embedding: 'embed' });
  f.connections.embed = async () => {
    f.memory.delete(car.id, car.revision);
    f.memory.save({ ...apple, body: 'Changed while query was running' });
    return [[1, 0, 0]];
  };
  const result = await f.memory.searchSemantic({ query: 'gasoline refill' });
  assert.deepEqual(result.pages, []);
  assert.equal(result.excluded, 1);
});

test('automatic memory drafting never sends outdated PDF extraction text to a model', async (t) => {
  const f = setup(t);
  let providerCalls = 0;
  fs.writeFileSync(path.join(f.root, 'source.pdf'), 'Original evidence');
  const marker = Buffer.from(
    JSON.stringify({ file: 'source.pdf', hash: hash('Original evidence') }),
  ).toString('base64url');
  fs.writeFileSync(
    path.join(f.root, 'source.md'),
    `<!-- aiide-document-source-v1:${marker} -->\nOld extracted evidence`,
  );
  const note = f.memory.importSources({
    title: 'Evidence',
    files: ['source.md'],
  });
  f.connections.request = async () => {
    providerCalls++;
    throw new Error('must not reach provider');
  };
  fs.writeFileSync(
    path.join(f.root, 'source.pdf'),
    'Changed original evidence',
  );
  f.memory.configureMaintenance({
    enabled: true,
    autoDrafts: true,
    model: 'chat',
  });
  await f.memory.scan();
  assert.equal(providerCalls, 0);
  assert.equal(f.memory.proposals().length, 0);
  assert.match(
    f.memory.maintenanceStatus().errors[0],
    /Original document changed/,
  );
  assert.equal(f.memory.get(note.id).revision, note.revision);
});

test('explicit indexing repairs a corrupt derived cache without changing accepted notes', async (t) => {
  const f = setup(t),
    note = f.memory.save({ title: 'Vehicle', body: 'Petrol powers the car.' });
  await f.memory.indexSemantic({ embedding: 'embed' });
  fs.writeFileSync(path.join(f.root, '.aiide/memory-index.json'), '{}');
  assert.throws(() => f.memory.semanticStatus());
  assert.equal(
    (await f.memory.indexSemantic({ embedding: 'embed' })).indexed,
    1,
  );
  assert.equal(f.memory.get(note.id).revision, note.revision);
});
