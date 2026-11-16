const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Rag, hash } = require('../lib');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-rag-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'source.md'), 'Safe source content');
  return root;
}

test('RAG previews validate UTF-8 and reject symlinks/directories before reading', (t) => {
  const root = temporary(t),
    rag = new Rag(root, {}, {});
  assert.equal(rag.preview('source.md', 100, 0)[0].text, 'Safe source content');
  fs.writeFileSync(path.join(root, 'invalid.md'), Buffer.from([255, 254]));
  assert.throws(() => rag.preview('invalid.md', 100, 0));
  fs.symlinkSync(path.join(root, 'source.md'), path.join(root, 'link.md'));
  assert.throws(() => rag.preview('link.md', 100, 0), /Symbolic/);
  fs.mkdirSync(path.join(root, 'directory.md'));
  assert.throws(() => rag.preview('directory.md', 100, 0), /regular/);
});

test('RAG refuses inventory filter violations and deletion without current confirmation', async (t) => {
  const root = temporary(t);
  let called = 0;
  const connections = {
    get: () => ({ kind: 'qdrant' }),
    request: async () => {
      called++;
      return {
        json: async () => ({
          result: {
            points: [
              {
                id: 'foreign',
                payload: {
                  aiide_rag_owner: 'aiide-rag-v1',
                  aiide_rag_workspace: 'other',
                },
              },
            ],
          },
        }),
      };
    },
  };
  const rag = new Rag(root, connections, {});
  await assert.rejects(
    rag.removeSource({
      id: 'db',
      collection: 'docs',
      sourceId: 'a'.repeat(64),
      revision: 'b'.repeat(64),
      confirmed: false,
    }),
  );
  assert.equal(called, 0);
  await assert.rejects(rag.sources('db', 'docs'), /ownership filter/);
  await assert.rejects(rag.sources('db', '../escape'), /Invalid collection/);
});

test('concurrent ingestion is rejected per canonical source and failed embeddings cannot delete data', async (t) => {
  const root = temporary(t);
  const requests = [];
  let rejectEmbedding;
  const connection = {
    get: (id) =>
      id === 'db'
        ? { kind: 'qdrant' }
        : { id, kind: 'model', model: 'embedding', url: 'http://localhost/v1' },
    request: async (...args) => {
      requests.push(args);
      return { json: async () => ({ result: { collections: [] } }) };
    },
    embed: () =>
      new Promise((resolve, reject) => {
        rejectEmbedding = reject;
      }),
  };
  const rag = new Rag(root, connection, { span: () => {} });
  const args = {
    vector: 'db',
    embedding: 'model',
    collection: 'docs',
    file: 'source.md',
    size: 100,
    overlap: 0,
  };
  const pending = rag.ingest(args, 'run');
  while (!rejectEmbedding)
    await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    rag.ingest({ ...args, file: 'alias/../source.md' }, 'second'),
    /being ingested/,
  );
  rejectEmbedding(new Error('Embedding unavailable'));
  await assert.rejects(pending, /Embedding unavailable/);
  assert.ok(
    requests.every((args) => args[1] === '/collections'),
    'no upsert/delete occurred before all embeddings succeeded',
  );
});

test('source inventory detects local changes and computes removal revision from observed generations', async (t) => {
  const root = temporary(t);
  let payload = {
    source: 'source.md',
    aiide_rag_owner: 'aiide-rag-v1',
    aiide_rag_workspace: hash(fs.realpathSync(root)),
    aiide_rag_source_id: 'a'.repeat(64),
    aiide_rag_generation: 'b'.repeat(64),
    aiide_rag_hash: hash('Safe source content'),
    aiide_rag_pending: false,
  };
  const requests = [];
  const connections = {
    get: () => ({ kind: 'qdrant' }),
    request: async (...args) => {
      requests.push(args);
      return {
        json: async () => ({
          result: {
            points: args[2]?.filter?.must?.some(
              (condition) =>
                condition.key === 'aiide_rag_workspace' &&
                condition.match.value !== payload.aiide_rag_workspace,
            )
              ? []
              : [{ id: 'point', payload }],
          },
        }),
      };
    },
  };
  const rag = new Rag(root, connections, {});
  payload.aiide_rag_workspace = rag.identity().id;
  const [first] = await rag.sources('db', 'docs');
  assert.equal(first.freshness, 'current');
  fs.writeFileSync(path.join(root, 'source.md'), 'Changed');
  assert.equal((await rag.sources('db', 'docs'))[0].freshness, 'changed');
  payload = { ...payload, aiide_rag_pending: true };
  const [second] = await rag.sources('db', 'docs');
  assert.notEqual(first.revision, second.revision);
  assert.equal(second.pending, 1);
  await assert.rejects(
    rag.removeSource({
      id: 'db',
      collection: 'docs',
      sourceId: first.sourceId,
      revision: first.revision,
      confirmed: true,
    }),
    /changed/,
  );
  assert.ok(!requests.some((args) => args[1].includes('/delete')));
});
