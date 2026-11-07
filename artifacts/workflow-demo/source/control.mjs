import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9396', defaultViewport: null });
const page = (await browser.pages()).find(p => p.url().startsWith('http://127.0.0.1:3096'));
assert.ok(page, 'The isolated demo IDE must be open');
await page.setViewport({width:1440,height:900,deviceScaleFactor:1});
const delay = ms => new Promise(r => setTimeout(r, ms));
const click = async (text, selector = 'button') => {
  const target = await page.waitForFunction((text, selector) => [...document.querySelectorAll(selector)].find(e => e.textContent.includes(text) && !e.disabled), {}, text, selector);
  const el = target.asElement();
  await el.evaluate(e => e.scrollIntoView({ block: 'center' }));
  await delay(300);
  const box = await el.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
  await delay(250);
  await el.click();
  await delay(600);
};
const tab = text => click(text, '.aiide-tabs button');
const field = async (label, value) => {
  const handle = await page.evaluateHandle(label => [...document.querySelectorAll('.aiide label')].find(e => e.textContent.trim().startsWith(label))?.querySelector('input,textarea,select'), label);
  const el = handle.asElement();
  assert.ok(el, 'Missing field: ' + label);
  await el.evaluate(e => e.scrollIntoView({block:'center'}));
  if (await el.evaluate(e => e.tagName) === 'SELECT') await el.select(value);
  else {
    await el.click();
    await el.evaluate(e => {
      const prototype = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(e, '');
      e.dispatchEvent(new Event('input', {bubbles:true}));
    });
    await delay(150);
    await el.type(value, {delay:35});
  }
  await delay(500);
};
const shot = async name => {
  await delay(700);
  await page.screenshot({ path: `artifacts/workflow-demo/assets/${name}.png` });
};
const top = async () => {
  await page.$eval('.aiide-widget', e => {e.scrollTop = 0;});
  await delay(700);
};
const focus = async selector => {
  await page.$eval(selector, e => e.scrollIntoView({block:e.clientHeight > 600 ? 'start' : 'center'}));
  await delay(900);
};
const record = async (name, seconds, action) => {
  await page.evaluate(() => {
    if (document.getElementById('demo-cursor')) return;
    const cursor = document.createElement('div');
    cursor.id = 'demo-cursor';
    cursor.style = 'position:fixed;z-index:999999;left:100px;top:100px;width:22px;height:28px;pointer-events:none;filter:drop-shadow(0 2px 2px #0009)';
    cursor.innerHTML = '<svg viewBox="0 0 22 28"><path d="M2 2 L2 23 L7 18 L12 26 L16 24 L11 16 L19 16 Z" fill="white" stroke="#192f31" stroke-width="1.5"/></svg>';
    document.body.append(cursor);
    document.addEventListener('mousemove',e => {cursor.style.left=e.clientX+'px';cursor.style.top=e.clientY+'px';});
  });
  const started = Date.now();
  const recorder = await page.screencast({path:`artifacts/workflow-demo/assets/${name}.webm`,fps:20,quality:20,ffmpegPath:'/opt/zerobrew/prefix/bin/ffmpeg'});
  try {
    await delay(900);
    await action();
    await delay(Math.max(800, seconds*1000-(Date.now()-started)));
  } finally { await recorder.stop(); }
  await shot(name);
  console.log('Recorded',name,Math.round((Date.now()-started)/1000)+'s');
};
try {
  await eval(`(async () => { ${process.argv[2]} })()`);
} finally {
  browser.disconnect();
}
