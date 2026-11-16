const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const {
  saveProject,
  ensurePrivateState,
  privateStateStatus,
} = require('../lib/project');

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-private-git-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  git('init');
  return { root, git };
}
test('new project Git staging excludes runtime data while retaining public configuration', (t) => {
  const { root, git } = project(t);
  saveProject(root, { version: 1, name: 'private metadata' });
  fs.writeFileSync(
    path.join(root, '.aiide/workspace.sqlite'),
    'private test history',
  );
  fs.mkdirSync(path.join(root, '.aiide/drafts'));
  fs.writeFileSync(
    path.join(root, '.aiide/drafts/assistant.json'),
    'private test draft',
  );
  git('add', '.');
  const files = git('ls-files', '-z').split('\0').filter(Boolean);
  assert.deepEqual(files, ['.aiide/.gitignore', '.aiide/project.yaml']);
  assert.deepEqual(privateStateStatus(root).trackedPrivate, []);
});
test('existing tracked private files are reported without changing the Git index or user ignore rules', (t) => {
  const { root, git } = project(t);
  fs.writeFileSync(path.join(root, '.gitignore'), 'custom-policy\n');
  saveProject(root, { version: 1, name: 'existing metadata' });
  const file = path.join(root, '.aiide/workspace.sqlite');
  fs.writeFileSync(file, 'history must remain local');
  git('add', '-f', '.aiide/workspace.sqlite');
  const before = git('ls-files', '--stage');
  fs.writeFileSync(
    path.join(root, '.aiide/.gitignore'),
    '# existing user policy\n*\n',
  );
  ensurePrivateState(root);
  assert.equal(
    fs.readFileSync(path.join(root, '.gitignore'), 'utf8'),
    'custom-policy\n',
  );
  assert.equal(
    fs.readFileSync(path.join(root, '.aiide/.gitignore'), 'utf8'),
    '# existing user policy\n*\n',
  );
  assert.equal(git('ls-files', '--stage'), before);
  assert.deepEqual(privateStateStatus(root).trackedPrivate, [
    '.aiide/workspace.sqlite',
  ]);
  assert.equal(fs.readFileSync(file, 'utf8'), 'history must remain local');
});

test('oversized project updates preserve the last readable configuration', (t) => {
  const { root } = project(t);
  saveProject(root, { version: 1, name: 'keep this' });
  const file = path.join(root, '.aiide/project.yaml'),
    before = fs.readFileSync(file, 'utf8');
  const commands = Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [
      'command' + i,
      Array(100).fill('x'.repeat(2000)),
    ]),
  );
  assert.throws(
    () => saveProject(root, { version: 1, name: 'too large', commands }),
    /2 MB/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  fs.writeFileSync(file, ' '.repeat(2 * 1024 * 1024 + 1));
  assert.throws(() => require('../lib/project').loadProject(root), /2 MB/);
});

test('privacy inspection never executes a repository fsmonitor hook', (t) => {
  const { root, git } = project(t);
  saveProject(root, { version: 1, name: 'untrusted Git metadata' });
  git('add', '.aiide/project.yaml');
  const marker = path.join(root, 'hook-ran'),
    hook = path.join(root, 'fsmonitor');
  fs.writeFileSync(hook, '#!/bin/sh\ntouch ' + JSON.stringify(marker) + '\n');
  fs.chmodSync(hook, 0o755);
  git('config', 'core.fsmonitor', hook);
  privateStateStatus(root);
  assert.equal(fs.existsSync(marker), false);
});
