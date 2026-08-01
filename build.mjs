// Assembla dist/ots.html: un unico file, zero dipendenze esterne.
import fs from 'fs';
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const strip = (s) => s.replace(/^export\s+(?=(function|class|const|let|var))/gm, '')
                      .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');

const core = strip(read('./src/core.mjs'));
const qr   = strip(read('./src/qrencode.mjs'));
const app  = read('./src/app.mjs');

// core e qrencode diventano un namespace globale OTS; app resta uno script classico.
const bundle = `
(function(){
"use strict";
${core}
${qr}
window.OTS = { mixSeed, splitmix32, robustSolitonCdf, symbolNeighbours,
  LTEncoder, LTDecoder, b45encode, b45decode, crc32,
  buildFrame, parseFrame, packManifest, unpackManifest, kForBlock,
  encodeQR, alnumCapacity, minVersionFor,
  T_MANIFEST, T_DATA, FRAME_OVERHEAD, VERSION };
})();
(function(){
"use strict";
${app}
})();
`;

const html = read('./src/index.html')
  .replace('/*JSQR*/', () => read('./vendor/jsQR.min.js'))
  .replace('/*OTS*/', () => bundle);

fs.mkdirSync(new URL('./dist/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('./dist/ots.html', import.meta.url), html);
console.log(`dist/ots.html scritto — ${(html.length/1024).toFixed(0)} kB`);
