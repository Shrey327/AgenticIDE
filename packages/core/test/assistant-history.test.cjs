const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Assistant } = require('../lib/assistant');
const { Drafts } = require('../lib/drafts');
const { Store } = require('../lib/store');

test('assistant history survives a new instance, preserves completed status, and supports explicit deletion', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-chat-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const connections = { get: () => ({kind:'model',model:'fixture'}), request: async () => ({json: async () => ({choices:[{message:{role:'assistant',content:'Verified answer'}}]})}) };
  const store = new Store(path.join(root, 'history.sqlite')), sandbox = {root};
  t.after(() => store.close());
  const assistant = new Assistant(connections, sandbox, store);
  const chat = await assistant.start('fixture', 'Explain this experiment');
  for (let i=0;i<100 && assistant.status(chat.id).status==='running';i++) await new Promise(resolve=>setTimeout(resolve,5));
  await assistant.stop();
  const restored = new Assistant(connections, sandbox, store);
  assert.equal(restored.status(chat.id).status, 'completed');
  assert.equal(restored.status(chat.id).text, 'Verified answer');
  assert.equal(restored.list()[0].title, 'Explain this experiment');
  assert.equal(store.run(chat.id).status, 'completed');
  assert.equal(store.spans(chat.id).items[0].name, 'assistant.model');
  restored.delete(chat.id);
  assert.deepEqual(new Assistant(connections,sandbox,store).list(), []);
});

test('workspace drafts persist with bounded safe paths and reject unsupported versions', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-drafts-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const drafts = new Drafts(root);
  drafts.save('assistant',{prompt:'Keep this unsent request',model:'local'});
  assert.equal(new Drafts(root).get('assistant').prompt,'Keep this unsent request');
  assert.throws(()=>drafts.get('../escape'));
  assert.throws(()=>drafts.save('assistant',{prompt:'x'.repeat(256000)}),/256 KB/);
  fs.writeFileSync(path.join(root,'.aiide/drafts/assistant.json'),'{"version":2,"data":{}}');
  assert.throws(()=>drafts.get('assistant'));
});
