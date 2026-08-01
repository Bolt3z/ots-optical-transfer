// ===========================================================================
// browser.test.mjs — Prova in un browser vero cio' che i test in Node non
// possono provare: canvas, getUserMedia, Web Worker, download.
//
// La camera e' finta ma il percorso e' quello vero: si costruisce un video
// YUV4MPEG2 con i QR che il trasmettitore ha davvero disegnato e si passa a
// Chrome con --use-file-for-fake-video-capture. getUserMedia, il video
// element, lo scanner e i worker girano tutti per davvero.
//
//   npm install                 # serve puppeteer-core
//   node test/browser.test.mjs  # oppure: npm run test:browser
//
// CHROME_PATH per indicare un binario diverso. ffmpeg, se presente, aggiunge la
// prova del percorso «da un video registrato» (quello che si usa su iPhone).
// ===========================================================================

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import puppeteer from 'puppeteer-core';

const HTML = path.resolve(new URL('../dist/ots.html', import.meta.url).pathname);
const CHROME = process.env.CHROME_PATH || [
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
  '/usr/bin/chromium-browser', '/snap/bin/chromium',
].find((p) => fs.existsSync(p));

if (!CHROME) { console.error('Chrome non trovato: imposta CHROME_PATH'); process.exit(1); }
if (!fs.existsSync(HTML)) { console.error('dist/ots.html manca: lancia prima node build.mjs'); process.exit(1); }

const VW = 800, VH = 600, VFPS = 10;      // il video finto della camera
const FILE_BYTES = 24 * 1024;             // incomprimibile: esercita la fontana
const WANT_FRAMES = 170;                  // abbastanza per un file intero e un po' di margine

let failures = 0;
const ok = (cond, what) => {
  console.log(`  ${cond ? 'ok  ' : 'FALLITO'} ${what}`);
  if (!cond) failures++;
  return cond;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ots-browser-'));
const sample = path.join(tmp, 'campione.bin');
fs.writeFileSync(sample, crypto.randomBytes(FILE_BYTES));
const sampleHash = crypto.createHash('sha256').update(fs.readFileSync(sample)).digest('hex');

const launch = (extra = []) => puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required', '--window-size=1000,900', ...extra],
});

// --------------------------------------------------------------- il bundle in Node
function loadOTS() {
  const html = fs.readFileSync(HTML, 'utf8');
  const s = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]).find((x) => x.includes('window.OTS ='));
  if (!s) throw new Error('bundle OTS non trovato in dist/ots.html');
  return new Function('window', 'document', s + '\nreturn window.OTS;')(
    { addEventListener() {} }, { getElementById: () => null });
}

// =============================================== fase 1: il trasmettitore, davvero
async function phaseTransmit() {
  console.log('\n[1] trasmettitore in Chrome');
  const browser = await launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 900 });

  const errors = [], network = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith('file://') && !u.startsWith('data:') && !u.startsWith('blob:')) network.push(u);
  });

  await page.goto('file://' + HTML, { waitUntil: 'load' });
  ok(await page.evaluate(() => typeof window.OTS) === 'object', 'namespace OTS presente');
  ok(await page.evaluate(() => typeof window.jsQR) === 'undefined',
    'jsQR non compilato sul thread principale all avvio');
  ok(await page.evaluate(() => (document.getElementById('jsqr-src') || {}).textContent.length) > 10000,
    'sorgente jsQR presente per i worker');

  // si registra cosa il trasmettitore chiede davvero all'encoder QR
  await page.evaluate(() => {
    window.__frames = [];
    const orig = window.OTS.encodeQR;
    window.OTS.encodeQR = function (text, ver) {
      window.__frames.push(text);
      return orig.call(this, text, ver);
    };
  });

  await page.click('#tab-send');
  await (await page.$('#tx-file')).uploadFile(sample);
  await page.select('#tx-version', '25');
  await page.select('#tx-fps', '15');
  await page.select('#tx-symsize', '600');
  await page.click('#tx-go');

  let live = true;
  try {
    await page.waitForFunction(() => !document.getElementById('tx-live').hidden, { timeout: 20000 });
  } catch {
    live = false;
    console.log('    tx-prep dice:', await page.$eval('#tx-prep', (e) => e.textContent));
  }
  ok(live, 'il pannello di trasmissione si apre');
  if (!live) { await browser.close(); return null; }

  await page.waitForFunction((n) => window.__frames.length >= n, { timeout: 60000 }, WANT_FRAMES);

  // la prova piu' importante: il canvas disegnato e' rileggibile da un decoder QR
  const canvas = await page.evaluate(() => {
    new Function(document.getElementById('jsqr-src').textContent).call(self);
    const cv = document.getElementById('tx-canvas');
    const img = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
    const r = self.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    return {
      w: cv.width, read: !!r,
      parses: r ? !!window.OTS.parseFrame(window.OTS.b45decode(r.data)) : false,
    };
  });
  ok(canvas.w > 0, `canvas disegnato (${canvas.w}px)`);
  ok(canvas.read, 'un decoder QR rilegge il canvas del trasmettitore');
  ok(canvas.parses, 'il frame riletto dal canvas si decodifica');

  const stream = await page.evaluate(() => {
    const O = window.OTS, types = {}; let bad = 0;
    for (const t of window.__frames) {
      let p = null;
      try { p = O.parseFrame(O.b45decode(t)); } catch { /* conteggiato sotto */ }
      if (p) types[p.type] = (types[p.type] || 0) + 1; else bad++;
    }
    return { types, bad, n: window.__frames.length };
  });
  ok(stream.bad === 0, `tutti i ${stream.n} frame emessi sono validi`);
  ok(stream.types[1] > 0, `manifest intercalati (${stream.types[1] || 0})`);
  ok(stream.types[2] > 0, `frame di dati (${stream.types[2] || 0})`);

  const frames = await page.evaluate(() => window.__frames);
  await page.click('#tx-stop');
  await new Promise((r) => setTimeout(r, 200));
  ok(await page.evaluate(() => !document.getElementById('tx-setup').hidden),
    'dopo Ferma si torna alle impostazioni');

  ok(network.length === 0, `nessuna richiesta di rete${network.length ? ': ' + network.join(', ') : ''}`);
  ok(errors.length === 0, `nessun errore in console${errors.length ? ': ' + errors[0] : ''}`);

  await browser.close();
  return frames;
}

// ============================================== il video finto per la camera finta
function writeY4M(frames) {
  const OTS = loadOTS();
  const fd = fs.openSync(path.join(tmp, 'cam.y4m'), 'w');
  // writeSync e non uno stream: il Buffer si riusa, quindi la scrittura deve
  // finire prima di mutarlo (con createWriteStream i frame uscivano identici).
  const w = (b) => fs.writeSync(fd, typeof b === 'string' ? Buffer.from(b) : b);
  w(`YUV4MPEG2 W${VW} H${VH} F${VFPS}:1 Ip A1:1 C420jpeg\n`);
  const Y = Buffer.alloc(VW * VH);
  const U = Buffer.alloc((VW >> 1) * (VH >> 1), 128);
  const V = Buffer.alloc((VW >> 1) * (VH >> 1), 128);
  let px = 0;
  for (const text of frames) {
    const { modules, size } = OTS.encodeQR(text, 25);
    const border = 4, total = size + 2 * border;
    px = Math.floor(Math.min(VW, VH) / total);
    const dim = px * total, ox = (VW - dim) >> 1, oy = (VH - dim) >> 1;
    Y.fill(140);                                                   // stanza grigia
    for (let y = 0; y < dim; y++) Y.fill(235, (oy + y) * VW + ox, (oy + y) * VW + ox + dim);
    for (let my = 0; my < size; my++) {
      for (let mx = 0; mx < size; mx++) {
        if (!modules[my][mx]) continue;
        for (let dy = 0; dy < px; dy++) {
          const row = (oy + (border + my) * px + dy) * VW + ox + (border + mx) * px;
          Y.fill(20, row, row + px);
        }
      }
    }
    w('FRAME\n'); w(Y); w(U); w(V);
  }
  fs.closeSync(fd);
  console.log(`    ${frames.length} frame ${VW}x${VH} @${VFPS}fps, ${px}px per modulo`);
  return px;
}

function makeMp4() {
  try {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', path.join(tmp, 'cam.y4m'),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', path.join(tmp, 'cam.mp4')],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    return true;
  } catch { return false; }
}

// ================================================== fase 2 e 3: il ricevitore, davvero
async function phaseReceive(mode, { noWorker = false } = {}) {
  const label = `${mode}${noWorker ? ' (senza worker)' : ''}`;
  console.log(`\n[${mode === 'cam' ? 2 : 3}] ricevitore — ${label}`);
  const extra = mode === 'cam'
    ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
       `--use-file-for-fake-video-capture=${path.join(tmp, 'cam.y4m')}`]
    : [];
  const browser = await launch(extra);
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const dl = path.join(tmp, 'dl-' + mode + (noWorker ? '-main' : ''));
  fs.mkdirSync(dl, { recursive: true });
  const cdp = await page.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior',
    { behavior: 'allowAndName', downloadPath: dl, eventsEnabled: true });

  await page.goto('file://' + HTML, { waitUntil: 'load' });
  if (noWorker) await page.evaluate(() => { window.OTS_NO_WORKER = true; });
  await page.click('#tab-recv');

  if (mode === 'cam') await page.click('#rx-cam');
  else await (await page.$('#rx-videofile')).uploadFile(path.join(tmp, 'cam.mp4'));

  const t0 = Date.now();
  let done = false, err = '', last = null;
  while (Date.now() - t0 < 120000) {
    await new Promise((r) => setTimeout(r, 1000));
    last = await page.evaluate(() => ({
      err: document.getElementById('rx-error').hidden ? '' : document.getElementById('rx-error').textContent,
      pct: document.getElementById('rx-pct').textContent,
      engine: document.getElementById('rx-engine').textContent,
      session: document.getElementById('rx-session').textContent,
      out: !document.getElementById('rx-out').hidden,
      verdict: document.getElementById('rx-verdict').textContent,
    }));
    if (last.err) { err = last.err; break; }
    if (last.out) { done = true; break; }
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  if (!ok(done, `completato in ${secs}s${err ? ' — errore: ' + err : ''}`)) {
    console.log('    ultimo stato:', JSON.stringify(last));
    await browser.close();
    return;
  }
  console.log(`    motore: ${last.engine}, sessione ${last.session}`);
  ok(last.verdict === 'Integrità verificata', `digest verificato (${last.verdict})`);
  ok(noWorker ? last.engine.startsWith('main') : last.engine.startsWith('worker'),
    `motore atteso: ${noWorker ? 'main' : 'worker'}`);

  await page.click('#rx-download');
  await new Promise((r) => setTimeout(r, 1500));
  const got = fs.readdirSync(dl);
  if (ok(got.length === 1, `un file scaricato (${got.length})`)) {
    const buf = fs.readFileSync(path.join(dl, got[0]));
    const h = crypto.createHash('sha256').update(buf).digest('hex');
    ok(buf.length === FILE_BYTES, `dimensione ${buf.length} = ${FILE_BYTES}`);
    ok(h === sampleHash, 'byte identici all originale');
  }
  ok(errors.length === 0, `nessun errore in console${errors.length ? ': ' + errors[0] : ''}`);
  await browser.close();
}

// ============================================================================ via
console.log(`OTS — prova in browser reale\n  chrome: ${CHROME}\n  lavoro: ${tmp}`);
try {
  const frames = await phaseTransmit();
  if (frames) {
    console.log('\n    costruzione del video finto per la camera');
    writeY4M(frames);
    await phaseReceive('cam');
    await phaseReceive('cam', { noWorker: true });
    if (makeMp4()) await phaseReceive('video');
    else console.log('\n[3] ricevitore da video registrato — saltato (ffmpeg assente)');
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} PROVE FALLITE` : '\nTUTTE LE PROVE IN BROWSER OK');
process.exit(failures ? 1 : 0);
