// Renders 1920x1080 chapter/caption frames (and full cards for non-UI scenes) from assets/timeline.json.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'assets');
const scenes = JSON.parse(fs.readFileSync(path.join(assets, 'timeline.json')));
const csv = fs.readFileSync(path.join(root, 'project/data/houses.csv'), 'utf8').trim().split('\n');
const escape = (text) => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const cards = {
  dataset: () => {
    const [head, ...rows] = csv.slice(0, 8).map((l) => l.split(','));
    return `<div class="card"><div class="kicker">THE DATASET · data/houses.csv</div>
      <h2>12,000 homes. 8 features. Predict the price.</h2>
      <table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>
      ${rows.map((r) => `<tr>${r.map((v, i) => `<td>${i === r.length - 1 ? '$' + Number(v).toLocaleString('en-US') : v}</td>`).join('')}</tr>`).join('')}</table>
      <div class="facts"><span>Model: scikit-learn GradientBoostingRegressor</span><span>80 / 20 train–validation split</span><span>Synthetic data from make_dataset.py · no download</span></div></div>`;
  },
  notebook: () => `<div class="card nb"><div class="kicker">A TYPICAL NOTEBOOK SESSION</div>
      <div class="cell"><div class="gutter">[7]</div><pre># edited from n_estimators=200, learning_rate=0.1, max_depth=3
model = GradientBoostingRegressor(n_estimators=300, learning_rate=0.2, max_depth=8)
model.fit(x_train, y_train)
print("R²:", r2_score(y_val, model.predict(x_val)))</pre></div>
      <div class="out">R²: 0.884</div>
      <div class="out"><s>R²: 0.905</s> <em>← the previous output, replaced when you re-ran the edited cell</em></div>
      <ul><li>Which parameters produced 0.905? Copy them into a doc.</li><li>Learning curves? Write plotting code.</li><li>Which saved file is the good model? Name it carefully.</li><li>Runtime restarted? Re-run everything.</li></ul></div>`,
  compare: () => {
    const rows = [
      ['Learning curves', 'Plot them yourself', 'Live, built in'],
      ['Experiment history', 'Lost on re-run unless saved', 'Every run saved, survives restarts'],
      ['Comparing runs', 'Copy numbers by hand', 'Overlaid curves + side-by-side'],
      ['Saved models', 'Wherever you put them', 'Linked to the run that made them'],
      ['Step timing → code', 'Add timers manually', 'Trace with jump to source'],
      ['Hosted GPU', 'Colab: free tier', 'Your machine or an SSH GPU host'],
    ];
    return `<div class="card"><div class="kicker">SAME CODE, DIFFERENT LOOP</div>
      <table class="cmp"><tr><th></th><th>Notebook (Colab / VS Code)</th><th>AI Engineering IDE</th></tr>
      ${rows.map(([a, b, c], i) => `<tr><td>${a}</td><td class="${i === 5 ? 'win' : ''}">${b}</td><td class="${i === 5 ? '' : 'win'}">${c}</td></tr>`).join('')}</table>
      <p class="fine">Experiment trackers like MLflow or W&amp;B can add history and comparison to notebooks with extra setup.</p></div>`;
  },
};

const style = `*{box-sizing:border-box}html,body{margin:0;width:1920px;height:1080px;overflow:hidden;font-family:-apple-system,"Helvetica Neue",Arial,sans-serif;background:#050505;color:#f2f2f2}
body{background:radial-gradient(ellipse at 8% 10%,#1c1c1c 0%,#0a0a0a 38%,#050505 70%)}
.brand{position:absolute;left:54px;top:35px;font-size:14px;letter-spacing:3px;font-weight:700}.brand b{color:#8a8a8a;margin:0 7px}
.header{position:absolute;left:420px;top:38px;color:#8a8a8a;font-size:15px;letter-spacing:2px}
.version{position:absolute;right:60px;top:32px;font-size:13px;letter-spacing:2px;padding:9px 13px;border:1px solid #333;border-radius:6px;color:#bbb}
.step{position:absolute;left:54px;top:148px;width:330px;color:#fff;font-size:13px;line-height:1.6;letter-spacing:2px;font-weight:700;opacity:.65}
h1{position:absolute;left:50px;top:208px;width:350px;margin:0;font-size:49px;line-height:1.12;letter-spacing:-1.9px;font-weight:700;white-space:pre-line}
.rule{position:absolute;left:54px;top:408px;width:64px;height:4px;background:#fff}
.benefit{position:absolute;left:54px;top:450px;width:315px;font-size:23px;line-height:1.5;color:#b5b5b5}
.label{position:absolute;left:54px;top:788px;width:310px;display:flex;gap:12px;font-size:12px;font-weight:700;color:#bdbdbd;letter-spacing:1.4px;line-height:1.6}
.dot{height:7px;width:7px;flex:none;border-radius:50%;background:#fff;margin-top:6px}
.track{position:absolute;left:54px;top:929px;display:flex;gap:5px}.track i{display:block;height:3px;width:26px;background:#262626}.track i.on{background:#fff}
.counter{position:absolute;left:54px;top:951px;font-size:13px;color:#777;letter-spacing:2px}
.screen{position:absolute;left:418px;top:88px;width:1444px;height:904px;background:#000;border:2px solid #2a2a2a;border-radius:6px;box-shadow:0 25px 70px #000a;overflow:hidden}
.caption{position:absolute;left:429px;top:1006px;width:1422px;height:63px;display:flex;align-items:center;justify-content:center;text-align:center;font-size:23px;line-height:1.35;color:#f2f2f2;padding:0 18px}
.footer{position:absolute;left:54px;bottom:27px;font-size:10px;letter-spacing:1.5px;color:#666}
.card{padding:70px 80px;height:100%;display:flex;flex-direction:column;justify-content:center}
.kicker{font-size:15px;letter-spacing:2.5px;color:#8a8a8a;font-weight:700;margin-bottom:18px}
.card h2{font-size:46px;letter-spacing:-1.2px;margin:0 0 36px;font-weight:700}
table{border-collapse:collapse;font-size:21px;width:100%}th{text-align:left;color:#8a8a8a;font-weight:600;font-size:16px;padding:12px 14px;border-bottom:1px solid #333}
td{padding:13px 14px;border-bottom:1px solid #1e1e1e;font-variant-numeric:tabular-nums}
.facts{display:flex;gap:16px;margin-top:34px;flex-wrap:wrap}.facts span{border:1px solid #333;border-radius:999px;padding:10px 18px;font-size:18px;color:#ccc}
.nb .cell{display:flex;gap:18px;background:#0f0f0f;border:1px solid #2a2a2a;border-radius:10px;padding:18px 22px;margin-top:14px}
.nb .gutter{color:#666;font-family:Menlo,monospace;font-size:19px;padding-top:2px}
.nb pre{margin:0;font-family:Menlo,monospace;font-size:19px;line-height:1.55;color:#e6e6e6;white-space:pre-wrap}
.nb .out{font-family:Menlo,monospace;font-size:21px;padding:10px 0 4px 64px;color:#fff}.nb .out s{color:#777}.nb .out em{font-family:-apple-system,Arial;font-style:normal;color:#ff8a7a;font-size:18px;margin-left:12px}
.nb ul{margin:26px 0 0;padding-left:26px;font-size:22px;line-height:1.75;color:#c8c8c8}
.cmp td{font-size:22px;padding:18px 14px}.cmp td:first-child{color:#bbb;font-weight:600;width:24%}.cmp th{font-size:17px}
.cmp td.win{color:#fff;font-weight:600}.cmp td:not(.win):not(:first-child){color:#8a8a8a}
.fine{font-size:16px;color:#777;margin-top:26px}`;

const browser = await puppeteer.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
try {
  for (const [index, scene] of scenes.entries()) {
    const frames = [];
    for (let c = 0; c < scene.captions.length; c++) {
      const caption = scene.captions[c];
      await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${style}</style></head><body>
      <div class="brand">AI <b>/</b> ENGINEERING</div><div class="header">HOUSE PRICE PREDICTION · NOTEBOOK VS WORKSPACE</div><div class="version">PREVIEW 0.2.1</div>
      <div class="step">${escape(scene.section)}</div><h1>${escape(scene.title)}</h1><div class="rule"></div><div class="benefit">${escape(scene.benefit)}</div>
      <div class="label"><span class="dot"></span><span>${escape(scene.tag)}</span></div>
      <div class="track">${scenes.map((s, i) => `<i class="${i <= index ? 'on' : ''}"></i>`).join('')}</div><div class="counter">${String(index + 1).padStart(2, '0')} / ${scenes.length}</div>
      <div class="screen">${scene.card ? cards[scene.card]() : ''}</div><div class="caption">${escape(caption.text)}</div>
      <div class="footer">REAL UI RECORDING · SYNTHETIC DATA · LOCAL CPU</div></body></html>`);
      const file = `${scene.id}-frame-${c}.png`;
      await page.screenshot({ path: path.join(assets, file) });
      const start = c === 0 ? 0 : caption.start;
      const end = scene.captions[c + 1]?.start ?? scene.duration;
      frames.push(`file '${file}'\nduration ${(end - start).toFixed(3)}`);
    }
    frames.push(`file '${scene.id}-frame-${scene.captions.length - 1}.png'`);
    fs.writeFileSync(path.join(assets, `${scene.id}-frames.txt`), frames.join('\n'));
  }
  console.log('Rendered frames for', scenes.length, 'scenes');
} finally {
  await browser.close();
}
