const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Knowledge } = require('../lib/knowledge');
const { hash } = require('../lib/security');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-wiki-graph-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const memory = new Knowledge(root, {
    request: () => {
      throw new Error('graph must not call providers');
    },
    embed: () => {
      throw new Error('graph must not call providers');
    },
  });
  t.after(() => memory.close());
  return { root, memory };
}

test('saved note graph exposes bounded metadata, incoming/outgoing links and missing/stale/unreadable markers', (t) => {
  const { root, memory } = setup(t);
  fs.writeFileSync(path.join(root, 'decision.md'), 'Original decision');
  const target = memory.save({
    title: 'API <contract>',
    body: 'Private full note body',
    sources: [{ file: 'decision.md', hash: hash('Original decision') }],
  });
  const selected = memory.save({
    title: 'Design',
    body: `[[${target.id}]] [[missing-page]] [[broken]]`,
  });
  const incoming = memory.save({
    title: 'Runbook',
    body: `[[${selected.id}]]`,
  });
  fs.writeFileSync(
    path.join(root, '.aiide-memory/broken.md'),
    'Invalid frontmatter',
  );
  fs.writeFileSync(path.join(root, 'decision.md'), 'Changed decision');
  const graph = memory.graph(selected.id);
  assert.equal(graph.selected, selected.id);
  assert.equal(graph.nodes.length, 5);
  assert.equal(graph.nodes.find((node) => node.id === target.id).stale, true);
  assert.equal(
    graph.nodes.find((node) => node.id === 'missing-page').missing,
    true,
  );
  assert.equal(
    graph.nodes.find((node) => node.id === 'broken').unreadable,
    true,
  );
  assert.ok(
    graph.edges.some(
      (edge) => edge.source === incoming.id && edge.target === selected.id,
    ),
  );
  assert.ok(
    graph.edges.some(
      (edge) => edge.source === selected.id && edge.target === target.id,
    ),
  );
  assert.ok(
    graph.nodes.every((node) => !('body' in node) && !('sources' in node)),
  );
  assert.equal(JSON.stringify(graph).includes('Private full note body'), false);
  assert.throws(() => memory.graph('../outside'), /Invalid memory page ID/);
});

test('large wiki maps cap at twelve neighbors while retaining both directions and truthful omission count', (t) => {
  const { memory } = setup(t),
    outgoing = [];
  for (let i = 0; i < 20; i++)
    outgoing.push(memory.save({ title: 'Reference ' + i, body: 'Body' }));
  const selected = memory.save({
    title: 'Hub',
    body: outgoing.map((note) => `[[${note.id}]]`).join(' '),
  });
  for (let i = 0; i < 15; i++)
    memory.save({ title: 'Backlink ' + i, body: `[[${selected.id}]]` });
  const graph = memory.graph(selected.id);
  assert.equal(graph.nodes.length, 13);
  assert.equal(graph.omitted, 23);
  assert.ok(graph.edges.some((edge) => edge.source === selected.id));
  assert.ok(graph.edges.some((edge) => edge.target === selected.id));
  assert.equal(
    new Set(graph.nodes.map((node) => node.id)).size,
    graph.nodes.length,
  );
  assert.ok(
    graph.edges.every(
      (edge) =>
        graph.nodes.some((node) => node.id === edge.source) &&
        graph.nodes.some((node) => node.id === edge.target),
    ),
  );
});
