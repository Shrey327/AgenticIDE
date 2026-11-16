const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Knowledge } = require('../lib/knowledge');

function fixture(t, connections = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-memory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'design.md'),
    '# Decision\nUse local storage.',
  );
  return { root, memory: new Knowledge(root, connections) };
}

test('memory persists portable Markdown, searches all terms and follows backlinks', (t) => {
  const { root, memory } = fixture(t);
  const first = memory.save({
    title: 'Storage decision',
    body: 'SQLite local storage',
  });
  const second = memory.save({
    title: 'Architecture',
    body: `See [[${first.id}]].`,
  });
  assert.equal(fs.existsSync(path.join(root, first.file)), true);
  const restored = new Knowledge(root, {});
  assert.equal(restored.get(first.id).body, first.body);
  assert.deepEqual(
    restored.list('local SQLite').map((note) => note.id),
    [first.id],
  );
  assert.equal(restored.list('local unknown').length, 0);
  assert.deepEqual(restored.get(first.id).backlinks, [
    { id: second.id, title: second.title },
  ]);
  assert.match(
    fs.readFileSync(path.join(root, first.file), 'utf8'),
    /^---\ntitle:/,
  );
});

test('memory updates and deletion require current revision; duplicate titles preserve both pages', (t) => {
  const { memory } = fixture(t);
  const first = memory.save({ title: 'Same', body: 'One' });
  const second = memory.save({ title: 'Same', body: 'Two' });
  assert.notEqual(first.id, second.id);
  assert.throws(
    () => memory.save({ id: first.id, title: 'Oops', body: 'Lost' }),
    /changed/,
  );
  const saved = memory.save({ ...first, body: 'Updated' });
  assert.throws(() => memory.save({ ...first, body: 'Stale' }), /changed/);
  assert.throws(() => memory.delete(first.id, first.revision), /changed/);
  memory.delete(saved.id, saved.revision);
  assert.equal(memory.list().length, 1);
  assert.throws(
    () => memory.save({ ...saved, body: 'Resurrection' }),
    /changed/,
  );
});

test('memory detects edits outside the IDE and reports broken links', (t) => {
  const { root, memory } = fixture(t);
  const note = memory.save({ title: 'Page', body: 'See [[missing-page]].' });
  fs.appendFileSync(path.join(root, note.file), '\nExternal edit');
  assert.throws(() => memory.save({ ...note, body: 'Overwritten' }), /changed/);
  assert.deepEqual(memory.get(note.id).missingLinks, ['missing-page']);
});

test('memory rejects traversal, symlinks, invalid revisions, and oversized UTF-8 bodies', (t) => {
  const { root, memory } = fixture(t);
  assert.throws(() => memory.get('../design'), /Invalid memory page ID/);
  assert.throws(
    () => memory.save({ title: 'Large', body: '🙂'.repeat(17000) }),
    /64 KB/,
  );
  const note = memory.save({ title: 'Safe', body: 'content' });
  fs.unlinkSync(path.join(root, note.file));
  fs.symlinkSync(path.join(root, 'design.md'), path.join(root, note.file));
  assert.throws(() => memory.get(note.id), /Symbolic links/);
  assert.throws(() => memory.list(), /regular files/);
});

test('direct memory reads reject non-regular files before reading content', (t) => {
  const { root, memory } = fixture(t);
  fs.mkdirSync(path.join(root, '.aiide-memory/directory.md'), {
    recursive: true,
  });
  assert.throws(() => memory.get('directory'), /regular files/);
});

test('memory refuses a symlinked storage directory', (t) => {
  const { root, memory } = fixture(t);
  fs.mkdirSync(path.join(root, 'elsewhere'));
  fs.symlinkSync(
    path.join(root, 'elsewhere'),
    path.join(root, '.aiide-memory'),
  );
  assert.throws(
    () => memory.save({ title: 'Bad', body: 'outside' }),
    /Symbolic links/,
  );
});

test('malformed user-edited memory is reported without hiding intact pages or blocking saves', (t) => {
  const { root, memory } = fixture(t);
  const first = memory.save({ title: 'Intact', body: 'Good content' });
  fs.writeFileSync(
    path.join(root, '.aiide-memory/broken.md'),
    'No frontmatter',
  );
  assert.equal(memory.get(first.id).body, 'Good content');
  assert.match(
    memory.list().find((note) => note.id === 'broken').error,
    /frontmatter/,
  );
  assert.equal(
    memory.save({ title: 'Another', body: 'Still works' }).title,
    'Another',
  );
});

test('compilation sends only selected text and returns an unsaved reviewable draft with provenance', async (t) => {
  const requests = [];
  const connections = {
    get: () => ({ kind: 'model', model: 'fixture-model' }),
    request: async (...args) => {
      requests.push(args);
      return {
        json: async () => ({
          choices: [{ message: { content: 'Use local storage (design.md).' } }],
        }),
      };
    },
  };
  const { root, memory } = fixture(t, connections);
  const draft = await memory.compile({
    title: 'Storage',
    files: ['design.md', 'design.md'],
    model: 'local',
  });
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0][2].messages[1].content).sources, [
    { file: 'design.md', text: '# Decision\nUse local storage.' },
  ]);
  assert.equal(fs.existsSync(path.join(root, '.aiide-memory')), false);
  assert.match(draft.sources[0].hash, /^[a-f0-9]{64}$/);
  const note = memory.save(draft);
  assert.equal(note.sources[0].status, 'current');
  fs.writeFileSync(path.join(root, 'design.md'), 'Use remote storage instead.');
  assert.equal(memory.get(note.id).sources[0].status, 'changed');
  fs.unlinkSync(path.join(root, 'design.md'));
  assert.equal(memory.get(note.id).sources[0].status, 'unavailable');
});

test('compilation blocks secrets, path escapes, oversized sources and invalid model output', async (t) => {
  let requested = false;
  const { root, memory } = fixture(t, {
    get: () => ({ kind: 'model', model: 'fixture' }),
    request: async () => {
      requested = true;
      return { json: async () => ({ choices: [] }) };
    },
  });
  fs.writeFileSync(path.join(root, 'secrets.md'), 'do not send');
  fs.symlinkSync(path.join(root, 'design.md'), path.join(root, 'link.md'));
  fs.writeFileSync(path.join(root, 'large.md'), 'a'.repeat(128001));
  fs.writeFileSync(path.join(root, 'invalid.md'), Buffer.from([0xff, 0xfe]));
  for (const file of [
    'secrets.md',
    '../escape.md',
    'link.md',
    'large.md',
    'invalid.md',
  ])
    await assert.rejects(
      memory.compile({ title: 'Bad', files: [file], model: 'fixture' }),
    );
  assert.equal(requested, false);
  await assert.rejects(
    memory.compile({ title: 'Bad', files: ['design.md'], model: 'fixture' }),
    /did not return/,
  );
  assert.equal(memory.list().length, 0);
});

test('memory source hashes preserve draft provenance when sources change during review', async (t) => {
  const { root, memory } = fixture(t, {
    get: () => ({ kind: 'model', model: 'fixture' }),
    request: async () => ({
      json: async () => ({ choices: [{ message: { content: 'Draft' } }] }),
    }),
  });
  const draft = await memory.compile({
    title: 'Draft',
    files: ['design.md'],
    model: 'fixture',
  });
  fs.writeFileSync(path.join(root, 'design.md'), 'Changed while reviewing');
  assert.equal(memory.save(draft).sources[0].status, 'changed');
  const saved = memory.list()[0];
  fs.unlinkSync(path.join(root, 'design.md'));
  assert.equal(
    memory.save({ ...memory.get(saved.id), body: 'Source was removed' })
      .sources[0].status,
    'unavailable',
  );
});
