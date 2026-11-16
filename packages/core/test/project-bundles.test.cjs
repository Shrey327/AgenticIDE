const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ProjectBundles } = require('../lib/project-bundles');
const { saveProject, loadProject } = require('../lib/project');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-bundle-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  saveProject(root, {
    version: 1,
    name: 'Shared experiment',
    environment: { python: '/personal/environment/python' },
    commands: { train: ['python', 'danger.py'] },
    services: { chat: 'private-connection' },
    connections: ['private-connection'],
  });
  fs.writeFileSync(path.join(root, 'README.md'), 'Experiment sources');
  return {
    root,
    bundles: new ProjectBundles(root, path.resolve(__dirname, '../../..')),
  };
}

test('project bundles round-trip reviewed files and sanitize host settings without executing', async (t) => {
  const { root, bundles } = setup(t);
  fs.mkdirSync(path.join(root, '.aiide-memory'));
  fs.writeFileSync(
    path.join(root, '.aiide-memory', 'decision.md'),
    'Use held-out seeds',
  );
  fs.writeFileSync(
    path.join(root, 'main.py'),
    'raise RuntimeError("must never run on import")',
  );
  const files = ['README.md', '.aiide-memory/decision.md', 'main.py'];
  const preview = bundles.preview({ files });
  assert.equal(preview.files.length, 4);
  assert.ok(!preview.manifest.includes('/personal'));
  const exported = await bundles.export({
    files,
    reviewHash: preview.reviewHash,
  });
  const inspected = await bundles.inspect({ file: exported.file });
  const imported = await bundles.import({
    file: exported.file,
    name: 'shared-copy',
    reviewHash: inspected.reviewHash,
  });
  assert.equal(
    fs.readFileSync(path.join(imported.root, 'README.md'), 'utf8'),
    'Experiment sources',
  );
  assert.deepEqual(loadProject(imported.root).commands, {});
  assert.deepEqual(loadProject(imported.root).services, {});
  assert.deepEqual(loadProject(imported.root).connections, []);
  assert.ok(
    fs.existsSync(path.join(imported.root, '.aiide', 'bundle-source.json')),
  );
  await assert.rejects(
    bundles.import({
      file: exported.file,
      name: 'shared-copy',
      reviewHash: inspected.reviewHash,
    }),
    /exists/,
  );
  assert.equal(
    fs.readFileSync(path.join(imported.root, 'main.py'), 'utf8'),
    'raise RuntimeError("must never run on import")',
  );
});

test('project bundles exclude protected paths and require fresh source/archive review', async (t) => {
  const { root, bundles } = setup(t);
  fs.writeFileSync(path.join(root, '.env'), 'must not share');
  assert.throws(() => bundles.preview({ files: ['.env'] }), /Protected/);
  fs.symlinkSync(path.join(root, 'README.md'), path.join(root, 'link.md'));
  assert.throws(() => bundles.preview({ files: ['link.md'] }), /Symbolic/);
  assert.throws(() => bundles.preview({ files: ['../outside'] }));
  const files = ['README.md'],
    preview = bundles.preview({ files });
  fs.writeFileSync(path.join(root, 'README.md'), 'Changed');
  await assert.rejects(
    bundles.export({ files, reviewHash: preview.reviewHash }),
    /changed/,
  );
  const current = bundles.preview({ files });
  const exported = await bundles.export({
    files,
    reviewHash: current.reviewHash,
  });
  await assert.rejects(
    bundles.import({
      file: exported.file,
      name: 'wrong-review',
      reviewHash: '0'.repeat(64),
    }),
    /changed/,
  );
  assert.ok(!fs.existsSync(path.join(root, 'wrong-review')));
  const reviewHash = (await bundles.inspect({ file: exported.file }))
    .reviewHash;
  const concurrent = await Promise.allSettled([
    bundles.import({
      file: exported.file,
      name: 'concurrent-copy',
      reviewHash,
    }),
    bundles.import({
      file: exported.file,
      name: 'concurrent-copy',
      reviewHash,
    }),
  ]);
  assert.equal(
    concurrent.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    concurrent.filter((result) => result.status === 'rejected').length,
    1,
  );
  assert.equal(
    fs.readFileSync(path.join(root, 'concurrent-copy', 'README.md'), 'utf8'),
    'Changed',
  );
});

test('project bundles reject malicious ZIP paths, links, duplicates, quotas and corrupt provenance', async (t) => {
  const { root, bundles } = setup(t);
  const script = `import json,sys,zipfile,stat\nfrom pathlib import Path\nroot=Path(sys.argv[1])\nfor mode in ('traversal','absolute','backslash','symlink','duplicate','quota','integrity','commands'):\n file=root/(mode+'.zip')\n with zipfile.ZipFile(file,'w') as z:\n  if mode=='symlink':\n   i=zipfile.ZipInfo('link');i.external_attr=(stat.S_IFLNK|0o777)<<16;z.writestr(i,'outside')\n  elif mode=='duplicate':\n   z.writestr('a.md','a');z.writestr('A.md','b')\n  elif mode=='quota':\n   for i in range(2002):z.writestr(str(i),'')\n  elif mode=='integrity':\n   z.writestr('.aiide/project.yaml','{}');z.writestr('aiide-bundle.json',json.dumps({'format':'aiide-project-bundle-v1','files':[{'file':'.aiide/project.yaml','size':2,'sha256':'0'*64}]}))\n  elif mode=='commands':\n   import hashlib\n   c=json.dumps({'version':1,'name':'bad','commands':{'run':['bad']}});z.writestr('.aiide/project.yaml',c);z.writestr('aiide-bundle.json',json.dumps({'format':'aiide-project-bundle-v1','files':[{'file':'.aiide/project.yaml','size':len(c),'sha256':hashlib.sha256(c.encode()).hexdigest()}]}))\n  else:z.writestr({'traversal':'../escape','absolute':'/escape','backslash':'..\\\\escape'}[mode],'data')\n`;
  execFileSync('python3', ['-I', '-c', script, root]);
  for (const file of [
    'traversal',
    'absolute',
    'backslash',
    'symlink',
    'duplicate',
    'quota',
    'integrity',
    'commands',
  ])
    await assert.rejects(bundles.inspect({ file: file + '.zip' }));
  const bomb =
    "import sys,zipfile\nfrom pathlib import Path\nr=Path(sys.argv[1])\nwith zipfile.ZipFile(r/'bomb.zip','w',compression=zipfile.ZIP_DEFLATED) as z:\n with z.open('oversized.bin','w') as f:\n  for _ in range(65):f.write(b'0'*1048576)\nwith zipfile.ZipFile(r/'encrypted.zip','w') as z:z.writestr('safe.md','content')\nf=r/'encrypted.zip';b=bytearray(f.read_bytes());i=b.index(b'PK\\x03\\x04');b[i+6]|=1;i=b.index(b'PK\\x01\\x02');b[i+8]|=1;f.write_bytes(b)\nwith zipfile.ZipFile(r/'prefix.zip','w') as z:z.writestr('file','a');z.writestr('file/child','b')\nwith zipfile.ZipFile(r/'case-state.zip','w') as z:z.writestr('.AIIDE/connections.json','{}')\n";
  execFileSync('python3', ['-I', '-c', bomb, root]);
  await assert.rejects(bundles.inspect({ file: 'bomb.zip' }), /size limit/);
  await assert.rejects(bundles.inspect({ file: 'encrypted.zip' }), /encrypted/);
  await assert.rejects(bundles.inspect({ file: 'prefix.zip' }), /directory/);
  await assert.rejects(
    bundles.inspect({ file: 'case-state.zip' }),
    /Protected/,
  );
});

test(
  'closing sharing cancels active helpers before they can publish delayed work',
  { timeout: 10000 },
  async (t) => {
    const { root } = setup(t);
    const assets = path.join(root, 'resources');
    fs.mkdirSync(path.join(assets, 'python'), { recursive: true });
    fs.writeFileSync(
      path.join(assets, 'python/project_bundle.py'),
      'import json,os,sys,time\nfrom pathlib import Path\nr=json.load(sys.stdin)\np=Path(r["archive"])\np.with_suffix(".pid").write_text(str(os.getpid()))\ntime.sleep(1)\np.with_suffix(".mutation").write_text("published after close")\nprint(json.dumps({"ok":True,"result":{}}))\n',
    );
    const bundles = new ProjectBundles(root, assets);
    t.after(() => bundles.close());
    const pending = [];
    for (const name of ['first', 'second']) {
      fs.writeFileSync(path.join(root, name + '.zip'), 'fixture');
      pending.push(
        assert.rejects(bundles.inspect({ file: name + '.zip' }), /cancelled/),
      );
    }
    for (
      let i = 0;
      i < 100 &&
      !['first', 'second'].every((name) =>
        fs.existsSync(path.join(root, name + '.pid')),
      );
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(
      ['first', 'second'].every((name) =>
        fs.existsSync(path.join(root, name + '.pid')),
      ),
    );
    await bundles.close();
    await Promise.all(pending);
    await assert.rejects(bundles.inspect({ file: 'first.zip' }), /closed/);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.ok(
      ['first', 'second'].every(
        (name) => !fs.existsSync(path.join(root, name + '.mutation')),
      ),
    );
  },
);
