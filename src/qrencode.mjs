// ===========================================================================
// qrencode.mjs — Encoder QR minimale, modalita' ALFANUMERICA, livello ECC L.
// Nessuna dipendenza. Restituisce una matrice di booleani (true = modulo scuro).
// Copre le versioni 1..40. Sufficiente per OTS, che usa solo Base45.
// ===========================================================================

const ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

// Codeword di correzione per blocco, livello L, indicizzato per versione 1..40
const ECC_PER_BLOCK_L = [-1,
  7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28,
  28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];

// Numero di blocchi ECC, livello L
const NUM_BLOCKS_L = [-1,
  1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8,
  8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25];

function numRawDataModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const na = Math.floor(ver / 7) + 2;
    r -= (25 * na - 10) * na - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}

function numDataCodewords(ver) {
  return Math.floor(numRawDataModules(ver) / 8)
    - ECC_PER_BLOCK_L[ver] * NUM_BLOCKS_L[ver];
}

function alignPositions(ver) {
  if (ver === 1) return [];
  const na = Math.floor(ver / 7) + 2;
  const size = ver * 4 + 17;
  const step = (ver === 32) ? 26 : Math.ceil((ver * 4 + 4) / (na * 2 - 2)) * 2;
  const res = [6];
  for (let pos = size - 7; res.length < na; pos -= step) res.splice(1, 0, pos);
  return res;
}

/** Numero massimo di caratteri alfanumerici per una data versione, ECC L. */
export function alnumCapacity(ver) {
  const bits = numDataCodewords(ver) * 8;
  const ccBits = ver <= 9 ? 9 : (ver <= 26 ? 11 : 13);
  const avail = bits - 4 - ccBits;
  if (avail < 0) return 0;
  // ogni coppia di caratteri costa 11 bit, un carattere spaiato ne costa 6
  const pairs = Math.floor(avail / 11);
  const rest = avail - pairs * 11;
  return pairs * 2 + (rest >= 6 ? 1 : 0);
}

/** Versione minima che contiene `n` caratteri alfanumerici. 0 se nessuna. */
export function minVersionFor(n) {
  for (let v = 1; v <= 40; v++) if (alnumCapacity(v) >= n) return v;
  return 0;
}

// --------------------------------------------------------------------- GF(256)
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1; if (x & 0x100) x ^= 0x11D;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

function rsGenerator(degree) {
  // Il divisore e' monico e la sua coefficiente di testa e' implicito:
  // l'array ha esattamente `degree` elementi, non degree+1.
  const g = new Uint8Array(degree);
  g[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      g[j] = gfMul(g[j], root);
      if (j + 1 < degree) g[j] ^= g[j + 1];
    }
    root = gfMul(root, 2);
  }
  return g;
}

function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const res = new Uint8Array(degree);
  for (const b of data) {
    const factor = b ^ res[0];
    res.copyWithin(0, 1); res[degree - 1] = 0;
    for (let i = 0; i < degree; i++) res[i] ^= gfMul(gen[i], factor);
  }
  return res;
}

// ------------------------------------------------------------------- bitstream
class BitBuf {
  constructor() { this.bits = []; }
  push(val, len) { for (let i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1); }
  get length() { return this.bits.length; }
}

function encodeAlnum(text, ver) {
  const bb = new BitBuf();
  bb.push(0b0010, 4);                                   // indicatore modalita'
  bb.push(text.length, ver <= 9 ? 9 : (ver <= 26 ? 11 : 13));
  for (let i = 0; i + 1 < text.length; i += 2) {
    const a = ALNUM.indexOf(text[i]), b = ALNUM.indexOf(text[i + 1]);
    if (a < 0 || b < 0) throw new Error("carattere non alfanumerico: " + text[i] + text[i + 1]);
    bb.push(a * 45 + b, 11);
  }
  if (text.length % 2) {
    const a = ALNUM.indexOf(text[text.length - 1]);
    if (a < 0) throw new Error("carattere non alfanumerico");
    bb.push(a, 6);
  }

  const capacity = numDataCodewords(ver) * 8;
  if (bb.length > capacity) throw new Error("dati troppo lunghi per la versione " + ver);
  bb.push(0, Math.min(4, capacity - bb.length));        // terminatore
  bb.push(0, (8 - bb.length % 8) % 8);                  // allinea al byte
  for (let pad = 0xEC; bb.length < capacity; pad ^= 0xEC ^ 0x11) bb.push(pad, 8);

  const out = new Uint8Array(bb.length / 8);
  bb.bits.forEach((bit, i) => { if (bit) out[i >>> 3] |= 0x80 >>> (i & 7); });
  return out;
}

function interleave(data, ver) {
  const numBlocks = NUM_BLOCKS_L[ver];
  const eccLen = ECC_PER_BLOCK_L[ver];
  const rawCw = Math.floor(numRawDataModules(ver) / 8);
  const shortLen = Math.floor(rawCw / numBlocks) - eccLen;
  const numShort = numBlocks - rawCw % numBlocks;

  const blocks = [], eccs = [];
  let off = 0;
  for (let i = 0; i < numBlocks; i++) {
    const len = shortLen + (i < numShort ? 0 : 1);
    const blk = data.subarray(off, off + len); off += len;
    blocks.push(blk); eccs.push(rsRemainder(blk, eccLen));
  }

  const out = new Uint8Array(rawCw);
  let k = 0;
  for (let i = 0; i < shortLen + 1; i++)
    for (let b = 0; b < numBlocks; b++)
      if (i < blocks[b].length) out[k++] = blocks[b][i];
  for (let i = 0; i < eccLen; i++)
    for (let b = 0; b < numBlocks; b++) out[k++] = eccs[b][i];
  return out;
}

// ---------------------------------------------------------------------- matrice
function drawFunctionPatterns(mod, fn, ver, size) {
  const setFn = (x, y, v) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    mod[y][x] = v; fn[y][x] = true;
  };
  // timing
  for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
  // finder + separatori
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]])
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        setFn(cx + dx, cy + dy, d !== 2 && d !== 4);
      }
  // allineamento
  const ap = alignPositions(ver);
  for (let i = 0; i < ap.length; i++)
    for (let j = 0; j < ap.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) ||
          (i === ap.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          setFn(ap[j] + dx, ap[i] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  // info di versione (v >= 7)
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1;
      const a = size - 11 + i % 3, b = Math.floor(i / 3);
      setFn(a, b, bit); setFn(b, a, bit);
    }
  }
  setFn(8, size - 8, true);                       // modulo scuro
  // Riserva le celle dell'informazione di formato: DEVONO essere marcate come
  // funzionali prima di piazzare i codeword, altrimenti i dati ci finiscono
  // dentro e tutta la sequenza slitta.
  drawFormatBits(mod, fn, 0, size);
}

function drawFormatBits(mod, fn, mask, size) {
  const data = (0b01 << 3) | mask;                // 01 = livello L
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const put = (x, y, v) => { mod[y][x] = v; fn[y][x] = true; };
  for (let i = 0; i <= 5; i++) put(8, i, ((bits >>> i) & 1) === 1);
  put(8, 7, ((bits >>> 6) & 1) === 1);
  put(8, 8, ((bits >>> 7) & 1) === 1);
  put(7, 8, ((bits >>> 8) & 1) === 1);
  for (let i = 9; i < 15; i++) put(14 - i, 8, ((bits >>> i) & 1) === 1);
  for (let i = 0; i < 8; i++) put(size - 1 - i, 8, ((bits >>> i) & 1) === 1);
  for (let i = 8; i < 15; i++) put(8, size - 15 + i, ((bits >>> i) & 1) === 1);
}

function drawCodewords(mod, fn, cw, size) {
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && i < cw.length * 8) {
          mod[y][x] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
  }
}

const MASK_FN = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => x * y % 2 + x * y % 3 === 0,
  (x, y) => (x * y % 2 + x * y % 3) % 2 === 0,
  (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0,
];

function penalty(mod, size) {
  let p = 0;
  const runPenalty = (run) => run >= 5 ? 3 + (run - 5) : 0;
  for (let y = 0; y < size; y++) {
    let run = 1;
    for (let x = 1; x < size; x++) {
      if (mod[y][x] === mod[y][x - 1]) run++;
      else { p += runPenalty(run); run = 1; }
    }
    p += runPenalty(run);
  }
  for (let x = 0; x < size; x++) {
    let run = 1;
    for (let y = 1; y < size; y++) {
      if (mod[y][x] === mod[y - 1][x]) run++;
      else { p += runPenalty(run); run = 1; }
    }
    p += runPenalty(run);
  }
  for (let y = 0; y < size - 1; y++)
    for (let x = 0; x < size - 1; x++) {
      const c = mod[y][x];
      if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) p += 3;
    }
  const PAT = [true, false, true, true, true, false, true];
  const hasPat = (get, i) => {
    for (let k = 0; k < 7; k++) if (get(i + k) !== PAT[k]) return false;
    return true;
  };
  const quiet = (get, i, from, to) => {
    for (let k = from; k < to; k++) if (get(i + k) !== false) return false;
    return true;
  };
  for (let y = 0; y < size; y++)
    for (let x = 0; x <= size - 7; x++) {
      const get = (i) => (i < 0 || i >= size) ? false : mod[y][i];
      if (hasPat(get, x) && (quiet(get, x, -4, 0) || quiet(get, x, 7, 11))) p += 40;
    }
  for (let x = 0; x < size; x++)
    for (let y = 0; y <= size - 7; y++) {
      const get = (i) => (i < 0 || i >= size) ? false : mod[i][x];
      if (hasPat(get, y) && (quiet(get, y, -4, 0) || quiet(get, y, 7, 11))) p += 40;
    }
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (mod[y][x]) dark++;
  const total = size * size;
  p += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
  return p;
}

/**
 * Codifica una stringa alfanumerica in una matrice QR.
 * @param {string} text  solo caratteri di ALNUM
 * @param {number} [version]  se omessa, si sceglie la minima
 * @returns {{modules: boolean[][], size: number, version: number}}
 */
export function encodeQR(text, version) {
  const ver = version || minVersionFor(text.length);
  if (!ver) throw new Error("testo troppo lungo anche per la versione 40");
  const size = ver * 4 + 17;

  const data = encodeAlnum(text, ver);
  const cw = interleave(data, ver);

  const mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  drawFunctionPatterns(mod, fn, ver, size);
  drawCodewords(mod, fn, cw, size);

  let best = null, bestPen = Infinity;
  for (let m = 0; m < 8; m++) {
    const trial = mod.map(r => r.slice());
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++)
        if (!fn[y][x] && MASK_FN[m](x, y)) trial[y][x] = !trial[y][x];
    drawFormatBits(trial, fn.map(r => r.slice()), m, size);
    const p = penalty(trial, size);
    if (p < bestPen) { bestPen = p; best = trial; }
  }
  return { modules: best, size, version: ver };
}

export const ALPHANUMERIC = ALNUM;
