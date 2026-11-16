const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { upstreamDocument } = require('../lib/source-provenance');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-upstream-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const marker = (file, hash) =>
  `<!-- aiide-document-source-v1:${Buffer.from(JSON.stringify({ file, hash })).toString('base64url')} -->\n# Reviewed extraction`;

test('document hints detect original changes and exact legacy extraction headers remain supported', (t) => {
  const root = setup(t);
  fs.writeFileSync(path.join(root, 'paper.pdf'), 'Original evidence');
  const text = marker('paper.pdf', sha('Original evidence'));
  assert.equal(upstreamDocument(root, text).status, 'current');
  const legacy = `# evidence\n\nSource: paper.pdf\n\nSHA-256: ${sha('Original evidence')}\n\n## Page 1\n\nExtracted text`;
  assert.equal(upstreamDocument(root, legacy).status, 'current');
  fs.writeFileSync(path.join(root, 'paper.pdf'), 'Revised evidence');
  assert.equal(upstreamDocument(root, text).status, 'changed');
  assert.equal(upstreamDocument(root, legacy).status, 'changed');
  assert.equal(
    upstreamDocument(root, 'Ordinary Markdown with Source: paper.pdf'),
    undefined,
  );
});

test('untrusted source metadata cannot read protected/outside/symlink/large files and respects scan budget', (t) => {
  const root = setup(t);
  fs.writeFileSync(path.join(root, 'paper.pdf'), 'evidence');
  fs.symlinkSync(path.join(root, 'paper.pdf'), path.join(root, 'link.pdf'));
  fs.writeFileSync(path.join(root, 'large.pdf'), '');
  fs.truncateSync(path.join(root, 'large.pdf'), 26 * 1024 * 1024);
  for (const file of [
    '../outside.pdf',
    '.env.pdf',
    'link.pdf',
    'large.pdf',
    'missing.pdf',
  ])
    assert.equal(
      upstreamDocument(root, marker(file, sha('evidence'))).status,
      'unavailable',
      file,
    );
  assert.equal(
    upstreamDocument(root, marker('paper.pdf', sha('evidence')), {
      cache: new Map(),
      bytes: 256 * 1024 * 1024,
    }).status,
    'unavailable',
  );
  assert.equal(
    upstreamDocument(root, '<!-- aiide-document-source-v1:eyJmaWxlIjoxfQ -->\n')
      .status,
    'unavailable',
  );
});

test(
  'named-pipe upstream hints cannot block memory freshness inspection',
  { skip: process.platform === 'win32' },
  (t) => {
    const root = setup(t);
    execFileSync('mkfifo', [path.join(root, 'pipe.pdf')]);
    const module = path.resolve(__dirname, '../lib/source-provenance.js');
    const script = `const result=require(process.argv[1]).upstreamDocument(process.argv[2],process.argv[3]);if(result.status!=='unavailable')process.exit(2);`;
    execFileSync(
      process.execPath,
      ['-e', script, module, root, marker('pipe.pdf', sha('evidence'))],
      { timeout: 1500 },
    );
  },
);

test('one scan hashes an original only once even when exports carry different recorded revisions', (t) => {
  const root = setup(t);
  fs.writeFileSync(path.join(root, 'paper.pdf'), 'evidence');
  const checks = { cache: new Map(), bytes: 0 };
  assert.equal(
    upstreamDocument(root, marker('paper.pdf', sha('evidence')), checks).status,
    'current',
  );
  assert.equal(
    upstreamDocument(root, marker('paper.pdf', sha('old evidence')), checks)
      .status,
    'changed',
  );
  assert.equal(checks.bytes, Buffer.byteLength('evidence'));
});
