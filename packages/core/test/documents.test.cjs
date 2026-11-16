const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Documents } = require('../lib/documents');
const { Knowledge } = require('../lib/knowledge');
const { Rag } = require('../lib/rag');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-documents-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    documents: new Documents(root, path.resolve(__dirname, '../../..')),
  };
}

function pdf(root) {
  const script = `from pathlib import Path\nfrom pypdf import PdfWriter\nfrom pypdf.generic import NameObject,DictionaryObject,DecodedStreamObject\nimport sys\nr=Path(sys.argv[1]);w=PdfWriter()\nfor text in ('LOCAL DOCUMENT FIRST PAGE','SECOND PAGE EVIDENCE'):\n p=w.add_blank_page(width=600,height=800);f=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')});p[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):w._add_object(f)})});s=DecodedStreamObject();s.set_data(('BT /F1 30 Tf 50 700 Td ('+text+') Tj ET').encode());p[NameObject('/Contents')]=w._add_object(s)\nw.write(r/'source.pdf');w.encrypt('private');w.write(r/'encrypted.pdf')\n`;
  execFileSync('python3', ['-c', script, root]);
}

test('text extraction saves reviewed Markdown without overwriting or changing source', async (t) => {
  const { root, documents } = setup(t);
  fs.writeFileSync(path.join(root, 'notes.txt'), 'A source-backed decision');
  const preview = await documents.preview({ file: 'notes.txt' });
  assert.equal(preview.pages[0].text, 'A source-backed decision');
  const saved = documents.save({
    file: 'notes.txt',
    name: 'notes',
    reviewHash: preview.reviewHash,
  });
  assert.match(
    fs.readFileSync(path.join(root, saved.file), 'utf8'),
    /Source page 1/,
  );
  assert.throws(
    () =>
      documents.save({
        file: 'notes.txt',
        name: 'notes',
        reviewHash: preview.reviewHash,
      }),
    /exist/i,
  );
  fs.writeFileSync(path.join(root, 'notes.txt'), 'Changed');
  assert.throws(
    () =>
      documents.save({
        file: 'notes.txt',
        name: 'changed',
        reviewHash: preview.reviewHash,
      }),
    /changed/,
  );
  assert.ok(!fs.existsSync(path.join(root, 'documents', 'changed.md')));
  await assert.rejects(documents.preview({ file: '../outside.pdf' }));
  await assert.rejects(documents.preview({ file: '.env' }));
  fs.symlinkSync(path.join(root, 'notes.txt'), path.join(root, 'link.txt'));
  await assert.rejects(documents.preview({ file: 'link.txt' }), /Symbolic/);
});

test('actual PDF extraction preserves page provenance and rejects encrypted/oversized streams', async (t) => {
  const { root, documents } = setup(t);
  if (!(await documents.status()).pdf)
    return t.skip('pypdf optional runtime not installed');
  pdf(root);
  const preview = await documents.preview({
    file: 'source.pdf',
    firstPage: 2,
    pages: 1,
  });
  assert.equal(preview.totalPages, 2);
  assert.equal(preview.pages[0].page, 2);
  assert.match(preview.pages[0].text, /SECOND PAGE EVIDENCE/);
  const saved = documents.save({
    file: 'source.pdf',
    firstPage: 2,
    pages: 1,
    name: 'evidence',
    reviewHash: preview.reviewHash,
  });
  assert.match(
    fs.readFileSync(path.join(root, saved.file), 'utf8'),
    /source.pdf#page=2/,
  );
  const memory = new Knowledge(root, {});
  const note = memory.importSources({
    title: 'PDF evidence',
    files: [saved.file],
  });
  assert.equal(note.sources[0].status, 'current');
  fs.appendFileSync(path.join(root, 'source.pdf'), '\n% upstream revision\n');
  assert.equal(
    memory.get(note.id).sources[0].status,
    'changed',
    'unchanged extracted Markdown must flag a changed original PDF',
  );
  const rag = new Rag(root, {}, {});
  await assert.rejects(
    rag.ingest(
      {
        vector: 'db',
        embedding: 'model',
        collection: 'docs',
        file: saved.file,
        size: 800,
        overlap: 0,
      },
      'run',
    ),
    /Original document changed/,
  );
  const refreshed = await documents.preview({
    file: 'source.pdf',
    firstPage: 2,
    pages: 1,
  });
  const replacement = documents.save({
    file: 'source.pdf',
    firstPage: 2,
    pages: 1,
    name: 'evidence-refreshed',
    reviewHash: refreshed.reviewHash,
  });
  assert.equal(
    memory.importSources({
      title: 'Refreshed PDF evidence',
      files: [replacement.file],
    }).sources[0].status,
    'current',
  );
  await memory.close();

  await assert.rejects(
    documents.preview({ file: 'encrypted.pdf' }),
    /Encrypted/,
  );
  await assert.rejects(
    documents.preview({ file: 'source.pdf', firstPage: 3 }),
    /past the end/,
  );
  const bomb = `from pypdf import PdfReader,PdfWriter\nfrom pypdf.generic import NameObject,DecodedStreamObject\nimport sys\nfrom pathlib import Path\nr=Path(sys.argv[1]);w=PdfWriter();w.add_page(PdfReader(r/'source.pdf').pages[0]);s=DecodedStreamObject();s.set_data(b' '*5000000);w.pages[0][NameObject('/Contents')]=w._add_object(s);w.pages[0].compress_content_streams();w.write(r/'bomb.pdf')`;
  execFileSync('python3', ['-c', bomb, root]);
  await assert.rejects(
    documents.preview({ file: 'bomb.pdf' }),
    /limit|decompress|exceeds/i,
  );
});

test('actual local OCR reads a scanned page with installed native engine', async (t) => {
  const { root, documents } = setup(t);
  const status = await documents.status();
  if (!status.pdf || !status.ocr)
    return t.skip('optional installed local OCR engine unavailable');
  pdf(root);
  execFileSync('pdftoppm', [
    '-f',
    '1',
    '-l',
    '1',
    '-singlefile',
    '-scale-to',
    '1600',
    path.join(root, 'source.pdf'),
    path.join(root, 'scan'),
  ]);
  const scan =
    "from pypdf import PdfWriter\nfrom pypdf.generic import NameObject,DictionaryObject,NumberObject,DecodedStreamObject\nfrom pathlib import Path\nimport sys\nr=Path(sys.argv[1]);header,pixels=(r/'scan.ppm').read_bytes().split(b'\\n255\\n',1);width,height=map(int,header.splitlines()[-1].split());w=PdfWriter();p=w.add_blank_page(width=600,height=800);image=DecodedStreamObject();image.set_data(pixels);image.update({NameObject('/Type'):NameObject('/XObject'),NameObject('/Subtype'):NameObject('/Image'),NameObject('/Width'):NumberObject(width),NameObject('/Height'):NumberObject(height),NameObject('/ColorSpace'):NameObject('/DeviceRGB'),NameObject('/BitsPerComponent'):NumberObject(8)});p[NameObject('/Resources')]=DictionaryObject({NameObject('/XObject'):DictionaryObject({NameObject('/Im1'):w._add_object(image.flate_encode())})});s=DecodedStreamObject();s.set_data(b'q 600 0 0 800 0 0 cm /Im1 Do Q');p[NameObject('/Contents')]=w._add_object(s);w.write(r/'scan.pdf')";
  execFileSync('python3', ['-c', scan, root]);
  const raw = await documents.preview({ file: 'scan.pdf', pages: 1 });
  assert.equal(raw.pages[0].text.trim(), '');
  const extracted = await documents.preview({
    file: 'scan.pdf',
    pages: 1,
    ocr: true,
  });
  assert.match(extracted.pages[0].text, /LOCAL DOCUMENT FIRST PAGE/i);
  assert.match(extracted.pages[0].method, /ocr$/);
  const saved = documents.save({
    file: 'scan.pdf',
    pages: 1,
    ocr: true,
    name: 'scan-ocr',
    reviewHash: extracted.reviewHash,
  });
  assert.ok(fs.existsSync(path.join(root, saved.file)));
});
