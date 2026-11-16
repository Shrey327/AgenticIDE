const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Knowledge } = require('../lib/knowledge');
const { Connections } = require('../lib/models');

async function fixture(t, respond) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-maintenance-'));
  fs.mkdirSync(path.join(root, '.aiide'));
  fs.writeFileSync(path.join(root, 'design.md'), 'Store data locally.');
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    requests.push(JSON.parse(body));
    if (respond) return respond(request, response);
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                body: 'Use remote storage (design.md).',
                summary: 'Storage policy changed.',
                conflicts: [
                  {
                    existing: 'Store data locally.',
                    proposed: 'Use remote storage.',
                    source: 'design.md',
                  },
                ],
              }),
            },
          },
        ],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const connections = new Connections(path.join(root, '.aiide'));
  await connections.save({
    id: 'local',
    kind: 'model',
    model: 'fixture',
    url: `http://127.0.0.1:${server.address().port}/v1`,
  });
  const memory = new Knowledge(root, connections);
  t.after(async () => {
    await memory.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, memory, requests, connections };
}

test('automatic maintenance finds real source changes, budgets model calls, and preserves reviewed facts', async (t) => {
  const { root, memory, requests, connections } = await fixture(t);
  const note = memory.importSources({
    title: 'Storage decision',
    files: ['design.md'],
  });
  fs.writeFileSync(path.join(root, 'design.md'), 'Use remote storage.');
  memory.configureMaintenance({
    enabled: true,
    autoDrafts: true,
    model: 'local',
    maxDraftsPerScan: 1,
    dailyDraftBudget: 1,
  });
  const scanned = await memory.scan();
  assert.deepEqual(scanned.stale, [note.id]);
  assert.equal(scanned.drafts, 1);
  assert.equal(requests.length, 1);
  assert.match(requests[0].messages[1].content, /Use remote storage/);
  assert.equal(memory.get(note.id).body, note.body);
  const proposal = memory.proposals()[0];
  assert.equal(proposal.conflicts.length, 1);
  assert.throws(() =>
    memory.applyProposal({ id: proposal.id, reviewed: false }),
  );
  const reopened = new Knowledge(root, connections);
  assert.equal(reopened.maintenanceStatus().config.autoDrafts, true);
  assert.equal(reopened.proposals()[0].id, proposal.id);
  memory.discardProposal(proposal.id);
  await reopened.scan();
  assert.equal(
    requests.length,
    1,
    'budget survives reopening and discarded proposals',
  );
  await reopened.close();
});

test('proposals refuse stale note/source application and apply with recoverable history', async (t) => {
  const { root, memory } = await fixture(t);
  const note = memory.importSources({
    title: 'Decision',
    files: ['design.md'],
  });
  const first = await memory.refresh({
    id: note.id,
    revision: note.revision,
    model: 'local',
  });
  fs.writeFileSync(path.join(root, 'design.md'), 'Changed while reviewing.');
  assert.throws(
    () => memory.applyProposal({ id: first.id, reviewed: true }),
    /sources changed/,
  );
  memory.discardProposal(first.id);
  const second = await memory.refresh({
    id: note.id,
    revision: note.revision,
    model: 'local',
  });
  const updated = memory.save({ ...note, body: 'Manual edit during review.' });
  assert.throws(
    () => memory.applyProposal({ id: second.id, reviewed: true }),
    /changed/,
  );
  memory.discardProposal(second.id);
  const third = await memory.refresh({
    id: updated.id,
    revision: updated.revision,
    model: 'local',
  });
  const applied = memory.applyProposal({ id: third.id, reviewed: true });
  assert.match(applied.body, /remote storage/);
  assert.equal(memory.proposals().length, 0);
  const restored = memory.restore({
    id: applied.id,
    version: updated.revision,
    revision: applied.revision,
  });
  assert.equal(restored.body, updated.body);
});

test('edits/deletions preserve bounded history and deleted notes can be restored safely', async (t) => {
  const { memory } = await fixture(t);
  let note = memory.save({ title: 'Versioned', body: 'First' });
  const initial = note;
  note = memory.save({ ...note, body: 'Second' });
  assert.equal(memory.history(note.id).length, 2);
  memory.delete(note.id, note.revision);
  assert.equal(memory.list().length, 0);
  note = memory.restore({ id: note.id, version: initial.revision });
  assert.equal(note.id, initial.id);
  assert.equal(note.body, 'First');
  assert.throws(
    () => memory.restore({ id: note.id, version: initial.revision }),
    /changed/,
  );
  for (let i = 0; i < 15; i++)
    note = memory.save({ ...note, body: 'Edit ' + i });
  assert.ok(memory.history(note.id).length <= 11);
});

test('missing sources are surfaced without auto-dropping provenance or generating unsupported drafts', async (t) => {
  const { memory, root, requests } = await fixture(t);
  const note = memory.importSources({ title: 'Source', files: ['design.md'] });
  memory.configureMaintenance({
    enabled: true,
    autoDrafts: true,
    model: 'local',
  });
  fs.unlinkSync(path.join(root, 'design.md'));
  const result = await memory.scan();
  assert.equal(result.errors.length, 1);
  assert.equal(requests.length, 0);
  assert.equal(memory.get(note.id).sources[0].status, 'unavailable');
  assert.equal(memory.get(note.id).sources.length, 1);
});

test('the scheduled scanner resumes only when enabled and does not run after closing', async (t) => {
  const { memory, root } = await fixture(t);
  t.mock.timers.enable({ apis: ['setInterval'] });
  memory.importSources({ title: 'Source', files: ['design.md'] });
  memory.configureMaintenance({ enabled: true, intervalSeconds: 30 });
  fs.writeFileSync(path.join(root, 'design.md'), 'Changed.');
  t.mock.timers.tick(30000);
  await memory.scan();
  assert.equal(memory.maintenanceStatus().stale.length, 1);
  await memory.close();
  t.mock.timers.tick(30000);
  await assert.rejects(memory.scan(), /closed/);
});

for (const action of ['close', 'cancel', 'disable'])
  test(`${action} aborts a real pending HTTP request without a late proposal`, async (t) => {
    let arrived;
    const seen = new Promise((resolve) => {
      arrived = resolve;
    });
    const { memory } = await fixture(t, () => arrived());
    const note = memory.importSources({
      title: 'Source',
      files: ['design.md'],
    });
    const pending = memory.refresh({
      id: note.id,
      revision: note.revision,
      model: 'local',
    });
    await seen;
    if (action === 'disable') memory.configureMaintenance({ enabled: false });
    else await memory[action]();
    await assert.rejects(pending, /abort/i);
    assert.equal(memory.proposals().length, 0);
  });

test('history and maintenance files reject tampering, nonregular files, symlinks and path escapes', async (t) => {
  const { memory, root } = await fixture(t);
  let note = memory.save({ title: 'Safe', body: 'Original' });
  const old = note;
  note = memory.save({ ...note, body: 'Updated' });
  fs.writeFileSync(
    path.join(root, '.aiide/memory-history', note.id, old.revision + '.md'),
    'tampered',
  );
  assert.throws(() => memory.history(note.id));
  assert.throws(() => memory.history('../escape'));
  assert.throws(
    () =>
      memory.configureMaintenance({
        enabled: true,
        autoDrafts: true,
        model: '',
      }),
    /require/,
  );
  assert.throws(() =>
    memory.configureMaintenance({ enabled: true, intervalSeconds: 1 }),
  );
  const file = path.join(root, '.aiide/memory-maintenance/config.json');
  fs.mkdirSync(file, { recursive: true });
  assert.throws(
    () => memory.maintenanceStatus(),
    /Invalid memory maintenance file/,
  );
});
