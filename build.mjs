// Assembla dist/ots.html: un unico file, zero dipendenze esterne.
import fs from 'fs';
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const strip = (s) => s.replace(/^export\s+(?=(function|class|const|let|var))/gm, '')
                      .replace(/^export\s+\{[^}]*\};?\s*$/gm, '');

const core    = strip(read('./src/core.mjs'));
const qr      = strip(read('./src/qrencode.mjs'));
const scanner = strip(read('./src/scanner.mjs'));
const app     = read('./src/app.mjs');
const jsqr    = read('./vendor/jsQR.min.js');

// jsQR finisce dentro un tag <script type="text/plain">: se il suo sorgente
// contenesse "</script" il parser HTML chiuderebbe il tag a meta'.
if (/<\/script/i.test(jsqr)) throw new Error('jsQR contiene </script: serve un escape');

// core e qrencode diventano un namespace globale OTS; scanner e app condividono
// lo stesso ambito privato, cosi' app vede Scanner senza doverlo esportare.
const bundle = `
(function(){
"use strict";
${core}
${qr}
window.OTS = { mixSeed, splitmix32, robustSolitonCdf, symbolNeighbours,
  LTEncoder, LTDecoder, b45encode, b45decode, crc32,
  buildFrame, parseFrame, packManifest, unpackManifest, kForBlock,
  encodeQR, alnumCapacity, minVersionFor,
  T_MANIFEST, T_DATA, FRAME_OVERHEAD, VERSION, SYSTEMATIC_UP_TO };
})();
(function(){
"use strict";
${scanner}
${app}
})();
`;

// Apache 2.0 chiede che le attribuzioni viaggino col codice, e questo file
// viene ridistribuito da solo: l'intestazione e' l'unico posto dove metterle.
const banner = `<!--
  OTS — Optical Transfer Stream · https://github.com/Bolt3z/ots-optical-transfer
  Copyright (c) 2026 Edoardo Besana — licenza MIT.

  Include jsQR, copyright (c) 2016 Cosmo Wolfe, licenza Apache 2.0:
  https://github.com/cozmo/jsQR — testo della licenza in vendor/jsQR.LICENSE.

  File unico e autosufficiente: non fa nessuna richiesta di rete.
-->
`;

const html = banner + read('./src/index.html')
  .replace('/*JSQR*/', () => jsqr)
  .replace('/*OTS*/', () => bundle);

fs.mkdirSync(new URL('./dist/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('./dist/ots.html', import.meta.url), html);
console.log(`dist/ots.html scritto — ${(html.length / 1024).toFixed(0)} kB`);
