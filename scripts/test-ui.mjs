import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
const url = process.env.AIIDE_TEST_URL || 'http://127.0.0.1:3080';
const browser = process.env.AIIDE_ELECTRON_URL
  ? await puppeteer.connect({ browserURL: process.env.AIIDE_ELECTRON_URL })
  : await puppeteer.launch({
      headless: true,
      executablePath:
        process.env.CHROME_PATH ||
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : undefined),
      args: ['--no-sandbox'],
      defaultViewport: { width: 1440, height: 1000 },
    });
const page = process.env.AIIDE_ELECTRON_URL
  ? (await browser.pages()).find((p) => p.url().startsWith('http')) ||
    (await browser.pages())[0]
  : await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const click = async (text) => {
  await page.waitForFunction(
    (t) =>
      [...document.querySelectorAll('button')].some((b) =>
        b.textContent.includes(t),
      ),
    {},
    text,
  );
  await page.evaluate(
    (t) =>
      [...document.querySelectorAll('button')]
        .find((b) => b.textContent.includes(t))
        .click(),
    text,
  );
};
const engineeringTab = '[id="shell-tab-aiide.workbench"]';
const closeEngineering = async () => {
  await page.click(`${engineeringTab} .lm-TabBar-tabCloseIcon`);
  await page.waitForSelector(engineeringTab, { hidden: true });
};
const connectEngineering = async () => {
  await page.click(engineeringTab);
  await page.waitForSelector('.aiide-welcome, .aiide-tabs');
  if (await page.$('.aiide-welcome')) await click('Open engineering workspace');
  await page.waitForSelector('.aiide-tabs');
};
try {
  if (!process.env.AIIDE_ELECTRON_URL)
    await page.goto(url, { waitUntil: 'networkidle2' });
  await page.waitForSelector('[id="shell-tab-aiide.workbench"]');
  await page.click('[id="shell-tab-aiide.workbench"]');
  await page.waitForFunction(
    () =>
      document.querySelector('.aiide') ||
      [...document.querySelectorAll('button')].some((b) =>
        b.textContent.includes('Yes, I trust'),
      ),
  );
  await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .find((b) => b.textContent.includes('Yes, I trust'))
      ?.click(),
  );
  await page.waitForSelector('[id="status-bar-aiide.open"]');
  await closeEngineering();
  await page.click('[id="status-bar-aiide.open"]');
  await page.waitForSelector(engineeringTab);
  await page.click('[id="status-bar-aiide.open"]');
  assert.ok(
    await page.$(engineeringTab),
    'Opening twice must keep the tab open',
  );
  await closeEngineering();
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.down(modifier);
  await page.keyboard.down('Alt');
  await page.keyboard.press('KeyE');
  await page.keyboard.up('Alt');
  await page.keyboard.up(modifier);
  await page.waitForSelector(engineeringTab);
  if (!process.env.AIIDE_ELECTRON_URL) {
    await closeEngineering();
    const viewMenu = (
      await page.evaluateHandle(() =>
        [...document.querySelectorAll('.lm-MenuBar-itemLabel')].find(
          (item) => item.textContent === 'View',
        ),
      )
    ).asElement();
    await viewMenu.click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.lm-Menu-itemLabel')].some(
        (item) => item.textContent === 'Open AI Engineering',
      ),
    );
    const openItem = (
      await page.evaluateHandle(() =>
        [...document.querySelectorAll('.lm-Menu-itemLabel')].find(
          (item) => item.textContent === 'Open AI Engineering',
        ),
      )
    ).asElement();
    await openItem.click();
    await page.waitForSelector(engineeringTab);
  }
  await closeEngineering();
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector(engineeringTab);
  await page.click(engineeringTab);
  // Trusted projects open straight into the workspace; the welcome screen
  // only appears for untrusted folders.
  await page.waitForSelector('.aiide-welcome, .aiide-tabs');
  const welcome = Boolean(await page.$('.aiide-welcome'));
  if (welcome)
    assert.equal(
      await page.$$eval(
        '.aiide-feature-grid .aiide-card',
        (cards) => cards.length,
      ),
      4,
    );
  if (welcome && !process.env.AIIDE_ELECTRON_URL) {
    await click('Open recent…');
    await page.waitForSelector('#quick-input-container .quick-input-widget', {
      visible: true,
    });
    await page.keyboard.press('Escape');
    await click('Open folder…');
    await page.waitForSelector('#theia-dialog-shell', { visible: true });
    await page.keyboard.press('Escape');
    await page.waitForSelector('#theia-dialog-shell', { hidden: true });
  }
  console.log(
    'PASS: permanent entry reopens tab; closed tab returns with restored layout',
  );
  await page.waitForSelector('.aiide-welcome, .aiide-tabs');
  if (await page.$('.aiide-welcome')) await click('Open engineering workspace');
  await page.waitForSelector('.aiide-tabs');
  await page.evaluate(() =>
    document.querySelector('.aiide-tabs [data-tab="Runs"]').click(),
  );
  await click('Run locally');
  await page.waitForFunction(() =>
    document.querySelector('tr.selected .aiide-badge.completed'),
  );
  await click('Trace ↗');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.aiide-span')].some((e) =>
      e.textContent.includes('example.pipeline'),
    ),
  );
  const spans = await page.$$eval('.aiide-span', (elements) =>
    elements.map((e) => e.innerText),
  );
  assert.ok(
    spans.some((text) => text.includes('example.pipeline')),
    'Python trace must be visible',
  );
  assert.deepEqual(errors, []);
  await page.screenshot({
    path: process.env.AIIDE_SCREENSHOT || '/tmp/aiide-traces.png',
  });
  await page.click('.aiide-span');
  await click('Open source');
  await page.waitForSelector('.monaco-editor');
  await page.click('[id="status-bar-aiide.open"]');
  await click('Runs');
  const savedRuns = await page.$$eval(
    '.aiide-table-wrap tbody tr td:first-child',
    (cells) => cells.map((cell) => cell.textContent),
  );
  assert.ok(savedRuns.length > 0);
  await closeEngineering();
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector(engineeringTab);
  await connectEngineering();
  await click('View previous runs');
  assert.deepEqual(
    await page.$$eval('.aiide-table-wrap tbody tr td:first-child', (cells) =>
      cells.map((cell) => cell.textContent),
    ),
    savedRuns,
    'Previous runs survive restoring a layout without the Engineering tab',
  );
  assert.deepEqual(errors, []);
  console.log('PASS: reopening project → previous runs preserved');
  console.log('PASS: UI → Python → Collector → SQLite → trace panel', spans);
} catch (error) {
  console.error(
    error.message,
    await page.$eval('body', (element) => element.innerText),
  );
  await page.screenshot({ path: '/tmp/aiide-ui-failure.png' });
  process.exitCode = 1;
} finally {
  if (process.env.AIIDE_ELECTRON_URL) browser.disconnect();
  else await browser.close();
}
