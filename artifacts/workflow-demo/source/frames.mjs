import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'assets');
const scenes = JSON.parse(fs.readFileSync(path.join(assets, 'timeline.json')));
const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9396', defaultViewport: null });
const page = await browser.newPage();
await page.setViewport({width:1920,height:1080,deviceScaleFactor:1});
const escape = text => text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
try {
  for (const [index, scene] of scenes.entries()) {
    const frames = [];
    for (let c = 0; c < scene.captions.length; c++) {
      const caption = scene.captions[c];
      const html = `<!doctype html><html><head><style>
      *{box-sizing:border-box}html,body{margin:0;width:1920px;height:1080px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;background:#0b1117;color:#eef4f8}
      body{background:radial-gradient(ellipse at 10% 12%,#143b39 0%,#0b171e 33%,#0b1117 65%)}
      .brand{position:absolute;left:54px;top:35px;font-size:14px;letter-spacing:3px;font-weight:700}.brand b{color:#6fe0c3;margin:0 7px}.header{position:absolute;left:420px;top:38px;color:#9aafb9;font-size:15px;letter-spacing:2px}.version{position:absolute;right:60px;top:35px;font-size:13px;letter-spacing:2px;padding:9px 13px;border:1px solid #34504f;border-radius:4px;color:#b8d0cd}
      .step{position:absolute;left:54px;top:148px;width:320px;color:#6fe0c3;font-size:13px;line-height:1.6;letter-spacing:2px;font-weight:bold}
      h1{position:absolute;left:50px;top:208px;width:350px;margin:0;font-size:49px;line-height:1.12;letter-spacing:-1.9px;font-weight:700;white-space:pre-line}
      .rule{position:absolute;left:54px;top:408px;width:64px;height:4px;background:#a4e9b3}.benefit{position:absolute;left:54px;top:450px;width:305px;font-size:23px;line-height:1.5;color:#b8cbd2}
      .label{position:absolute;left:54px;top:788px;width:302px;display:flex;gap:12px;font-size:12px;font-weight:bold;color:#9cd9cb;letter-spacing:1.4px;line-height:1.6}.dot{height:7px;width:7px;flex:none;border-radius:50%;background:#6fe0c3;margin-top:6px}
      .track{position:absolute;left:54px;top:929px;display:flex;gap:5px}.track i{display:block;height:3px;width:19px;background:#263b43}.track i.on{background:#6fe0c3}.counter{position:absolute;left:54px;top:951px;font-size:13px;color:#78929e;letter-spacing:2px}
      .screen{position:absolute;left:418px;top:88px;width:1444px;height:904px;background:#1e1e1e;border:2px solid #304347;box-shadow:0 25px 70px #0007}
      .caption{position:absolute;left:429px;top:1006px;width:1422px;height:63px;display:flex;align-items:center;justify-content:center;text-align:center;font-size:23px;line-height:1.35;color:#edf5f5;padding:0 18px}
      .footer{position:absolute;left:54px;bottom:27px;font-size:10px;letter-spacing:1.5px;color:#67818a}
      </style></head><body>
      <div class="brand">AI <b>/</b> ENGINEERING</div><div class="header">AN AI ENGINEER’S WORKFLOW</div><div class="version">PREVIEW 0.2</div>
      <div class="step">${escape(scene.section)}</div><h1>${escape(scene.title)}</h1><div class="rule"></div><div class="benefit">${escape(scene.benefit)}</div>
      <div class="label"><span class="dot"></span><span>${escape(scene.tag)}</span></div>
      <div class="track">${scenes.map((s,i)=>`<i class="${i<=index?'on':''}"></i>`).join('')}</div><div class="counter">${String(index+1).padStart(2,'0')} / ${scenes.length}</div>
      <div class="screen"></div><div class="caption">${escape(caption.text)}</div><div class="footer">BUILD. OBSERVE. UNDERSTAND.</div></body></html>`;
      await page.setContent(html);
      const file = `${scene.id}-frame-${c}.png`;
      await page.screenshot({path:path.join(assets,file)});
      const start = c === 0 ? 0 : caption.start;
      const end = scene.captions[c+1]?.start ?? scene.duration;
      frames.push(`file '${file}'\nduration ${(end-start).toFixed(3)}`);
    }
    frames.push(`file '${scene.id}-frame-${scene.captions.length-1}.png'`);
    fs.writeFileSync(path.join(assets,`${scene.id}-frames.txt`),frames.join('\n'));
  }
  console.log('Rendered all chapter and caption frames.');
} finally {
  await page.close();
  browser.disconnect();
}
