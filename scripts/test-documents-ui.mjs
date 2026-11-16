import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import puppeteer from 'puppeteer';
import { Documents } from '../packages/core/lib/documents.js';
import { Rag } from '../packages/core/lib/rag.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiide-document-ui-'));
const documents = new Documents(root, process.cwd());
fs.writeFileSync(
  path.join(root, 'source.txt'),
  'Page source for the actual document UI',
);
const { outputFiles } = await build({
  stdin: {
    contents: `
import React from 'react';import {createRoot} from 'react-dom/client';
import {DocumentsPanel} from './packages/theia-extension/src/browser/documents-panel.tsx';
const perform=async fn=>{try{await fn();}catch(error){window.failure=String(error);}};
createRoot(document.getElementById('root')).render(<DocumentsPanel call={(op,args)=>window.request(op,args)} perform={perform}/>);
`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  alias: { '@theia/core/shared/react': 'react' },
});
const browser = await puppeteer.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH ||
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined),
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage();
  await page.exposeFunction('request', (operation, args) => {
    if (operation === 'documents.status') return documents.status();
    if (operation === 'documents.preview') return documents.preview(args);
    if (operation === 'documents.save') return documents.save(args);
    throw new Error('Unexpected operation ' + operation);
  });
  await page.setContent('<main id="root"></main>');
  await page.addScriptTag({ content: outputFiles[0].text });
  const field = async (label, value) =>
    page.evaluate(
      (label, value) => {
        const node = [...document.querySelectorAll('label')]
          .find((node) => node.textContent.trim().startsWith(label))
          .querySelector('input');
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        ).set.call(node, value);
        node.dispatchEvent(new Event('input', { bubbles: true }));
      },
      label,
      value,
    );
  const click = async (text) => {
    await page.waitForFunction(
      (text) =>
        [...document.querySelectorAll('button')].some(
          (node) => node.textContent === text && !node.disabled,
        ),
      {},
      text,
    );
    await page.evaluate(
      (text) =>
        [...document.querySelectorAll('button')]
          .find((node) => node.textContent === text && !node.disabled)
          .click(),
      text,
    );
  };
  await page.waitForSelector('input[placeholder="data/research.pdf"]');
  await field('Source document path', 'source.txt');
  await click('Preview extracted text');
  await page.waitForFunction(() =>
    document.body.textContent.includes(
      'Page source for the actual document UI',
    ),
  );
  await field('New Markdown filename', 'reviewed-source');
  await click('Save reviewed Markdown');
  await page.waitForFunction(() =>
    document.body.textContent.includes('Saved documents/reviewed-source.md'),
  );
  const chunks = new Rag(root, {}, {}).preview(
    'documents/reviewed-source.md',
    500,
    20,
  );
  assert.ok(chunks.some((chunk) => chunk.text.includes('actual document UI')));
  fs.writeFileSync(path.join(root, 'source.txt'), 'Changed after review');
  await click('Save reviewed Markdown');
  await page.waitForFunction(() =>
    window.failure?.includes('changed after review'),
  );
  assert.match(
    fs.readFileSync(path.join(root, 'documents/reviewed-source.md'), 'utf8'),
    /actual document UI/,
  );
  console.log(
    'PASS: real document panel → actual extraction → reviewed Markdown → real RAG chunks; stale source rejected',
  );
} finally {
  await browser.close();
  fs.rmSync(root, { recursive: true, force: true });
}
