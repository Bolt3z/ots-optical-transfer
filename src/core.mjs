// ===========================================================================
// core.mjs — Nucleo del protocollo OTS. Logica pura: byte in, byte fuori.
// Nessun DOM, nessuna camera, nessun filesystem. Portabile ovunque.
//
// Questo file e' NORMATIVO: qualunque altra implementazione (Python, Kotlin,
// Swift, Rust) deve riprodurre esattamente il PRNG e il campionamento dei
// vicini, altrimenti i flussi non sono interoperabili.
// ===========================================================================

// --------------------------------------------------------------- PRNG (normativo)
// SplitMix32. Scelto perche' e' riproducibile in una decina di righe in
// qualunque linguaggio con interi a 32 bit. NON usare il PRNG di libreria.

export function mixSeed(session, esi) {
  let x = (session + Math.imul(esi, 0x9E3779B9)) | 0;
  x ^= x >>> 16; x = Math.imul(x, 0x21f0aaad);
  x ^= x >>> 15; x = Math.imul(x, 0x735a2d97);
  x ^= x >>> 15;
  return x | 0;
}

export function splitmix32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x9E3779B9) | 0;
    let t = a ^ (a >>> 16); t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15); t = Math.imul(t, 0x735a2d97);
    t = t ^ (t >>> 15);
    return (t >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------ distribuzione dei gradi
// Robust Soliton, c = 0.03, delta = 0.5 (ottimizzati sperimentalmente).

export function robustSolitonCdf(K, c = 0.03, delta = 0.5) {
  if (K <= 1) return [1.0];
  const rho = new Float64Array(K + 1);
  rho[1] = 1 / K;
  for (let i = 2; i <= K; i++) rho[i] = 1 / (i * (i - 1));

  const S = c * Math.log(K / delta) * Math.sqrt(K);
  let kd = Math.round(K / S);
  kd = Math.max(1, Math.min(K, kd));

  const tau = new Float64Array(K + 1);
  for (let i = 1; i < kd; i++) tau[i] = S / (K * i);
  tau[kd] = S > 1 ? (S * Math.log(S / delta)) / K : 1 / K;

  let Z = 0;
  for (let i = 1; i <= K; i++) Z += rho[i] + tau[i];

  const cdf = new Float64Array(K);
  let acc = 0;
  for (let i = 1; i <= K; i++) { acc += (rho[i] + tau[i]) / Z; cdf[i - 1] = acc; }
  cdf[K - 1] = 1.0;
  return cdf;
}

function sampleDegree(rnd, cdf) {
  const r = rnd();
  let lo = 0, hi = cdf.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < r) lo = m + 1; else hi = m; }
  return lo + 1;
}

/**
 * Vicini del simbolo `esi`. NORMATIVO: campionamento per rigetto su Set.
 * Encoder e decoder ricavano gli stessi indici dal solo ESI: la lista non
 * viaggia mai sul canale.
 */
export function symbolNeighbours(esi, K, sessionSeed, cdf) {
  const rnd = splitmix32(mixSeed(sessionSeed, esi));
  const d = Math.min(sampleDegree(rnd, cdf), K);
  const seen = new Set();
  while (seen.size < d) seen.add(Math.floor(rnd() * K) % K);
  return Array.from(seen);
}

// ---------------------------------------------------------------- codice fontana

export class LTEncoder {
  constructor(data, symbolSize, sessionSeed) {
    this.symbolSize = symbolSize;
    this.sessionSeed = sessionSeed | 0;
    this.K = Math.ceil(data.length / symbolSize) || 1;
    this.buf = new Uint8Array(this.K * symbolSize);
    this.buf.set(data);
    this.dataLen = data.length;
    this.cdf = robustSolitonCdf(this.K);
  }
  symbol(esi) {
    const nb = symbolNeighbours(esi, this.K, this.sessionSeed, this.cdf);
    const s = this.symbolSize;
    const out = this.buf.slice(nb[0] * s, nb[0] * s + s);
    for (let i = 1; i < nb.length; i++) {
      const off = nb[i] * s;
      for (let j = 0; j < s; j++) out[j] ^= this.buf[off + j];
    }
    return out;
  }
}

export class LTDecoder {
  constructor(K, symbolSize, dataLen, sessionSeed) {
    this.K = K; this.symbolSize = symbolSize; this.dataLen = dataLen;
    this.sessionSeed = sessionSeed | 0;
    this.cdf = robustSolitonCdf(K);
    this.solved = new Map();          // idx -> Uint8Array
    this.pending = new Map();         // esi -> {nb:Set, val:Uint8Array}
    this.received = 0;
  }
  get complete() { return this.solved.size === this.K; }
  get progress() { return this.solved.size / this.K; }

  addSymbol(esi, payload) {
    if (this.complete || this.pending.has(esi)) return this.complete;
    this.received++;
    const nb = new Set(symbolNeighbours(esi, this.K, this.sessionSeed, this.cdf));
    const val = payload.slice();
    for (const i of Array.from(nb)) {
      const s = this.solved.get(i);
      if (s) { for (let j = 0; j < val.length; j++) val[j] ^= s[j]; nb.delete(i); }
    }
    if (nb.size === 0) return this.complete;
    this.pending.set(esi, { nb, val });
    this._peel();
    return this.complete;
  }

  _peel() {
    const queue = [];
    for (const [e, p] of this.pending) if (p.nb.size === 1) queue.push(e);
    while (queue.length) {
      const esi = queue.pop();
      const entry = this.pending.get(esi);
      if (!entry || entry.nb.size !== 1) continue;
      this.pending.delete(esi);
      const idx = entry.nb.values().next().value;
      if (this.solved.has(idx)) continue;
      this.solved.set(idx, entry.val);
      for (const [other, p] of this.pending) {
        if (!p.nb.has(idx)) continue;
        p.nb.delete(idx);
        for (let j = 0; j < p.val.length; j++) p.val[j] ^= entry.val[j];
        if (p.nb.size === 0) this.pending.delete(other);
        else if (p.nb.size === 1) queue.push(other);
      }
    }
  }

  result() {
    if (!this.complete) return null;
    const out = new Uint8Array(this.K * this.symbolSize);
    for (let i = 0; i < this.K; i++) out.set(this.solved.get(i), i * this.symbolSize);
    return out.subarray(0, this.dataLen);
  }
}

// ------------------------------------------------------------------------ Base45
const B45 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const B45R = (() => { const m = {}; for (let i = 0; i < 45; i++) m[B45[i]] = i; return m; })();

export function b45encode(data) {
  let out = "";
  let i = 0;
  for (; i + 1 < data.length; i += 2) {
    let n = (data[i] << 8) | data[i + 1];
    const c = n % 45; n = (n - c) / 45;
    const d = n % 45; const e = (n - d) / 45;
    out += B45[c] + B45[d] + B45[e];
  }
  if (i < data.length) {
    const n = data[i], c = n % 45, d = (n - c) / 45;
    out += B45[c] + B45[d];
  }
  return out;
}

export function b45decode(s) {
  const rem = s.length % 3;
  if (rem === 1) throw new Error("lunghezza Base45 non valida");
  const out = new Uint8Array(Math.floor(s.length / 3) * 2 + (rem === 2 ? 1 : 0));
  let k = 0, i = 0;
  for (; i + 2 < s.length; i += 3) {
    const a = B45R[s[i]], b = B45R[s[i + 1]], c = B45R[s[i + 2]];
    if (a === undefined || b === undefined || c === undefined) throw new Error("carattere Base45 non valido");
    const n = a + b * 45 + c * 2025;
    if (n > 0xFFFF) throw new Error("Base45 fuori intervallo");
    out[k++] = n >>> 8; out[k++] = n & 0xFF;
  }
  if (rem === 2) {
    const a = B45R[s[i]], b = B45R[s[i + 1]];
    if (a === undefined || b === undefined) throw new Error("carattere Base45 non valido");
    const n = a + b * 45;
    if (n > 0xFF) throw new Error("Base45 fuori intervallo");
    out[k++] = n;
  }
  return out;
}

// ------------------------------------------------------------------------- CRC32
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf, start = 0, end = buf.length) {
  let c = 0xFFFFFFFF;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ------------------------------------------------------------------------ framing
export const MAGIC0 = 0x4F, MAGIC1 = 0x54;   // "OT"
export const VERSION = 1;
export const T_MANIFEST = 1, T_DATA = 2;
export const FRAME_OVERHEAD = 20;

/*  offset len  campo
     0     2   MAGIC "OT"
     2     1   VERSION
     3     1   TYPE
     4     4   SESSION_ID
     8     2   BLOCK_IDX     indice del source block
    10     4   ESI
    14     2   LEN
    16   LEN   PAYLOAD
  16+LEN   4   CRC32                                          */

export function buildFrame(type, session, blockIdx, esi, payload) {
  const out = new Uint8Array(FRAME_OVERHEAD + payload.length);
  const dv = new DataView(out.buffer);
  out[0] = MAGIC0; out[1] = MAGIC1; out[2] = VERSION; out[3] = type;
  dv.setUint32(4, session >>> 0);
  dv.setUint16(8, blockIdx);
  dv.setUint32(10, esi >>> 0);
  dv.setUint16(14, payload.length);
  out.set(payload, 16);
  dv.setUint32(16 + payload.length, crc32(out, 0, 16 + payload.length));
  return out;
}

export function parseFrame(raw) {
  if (raw.length < FRAME_OVERHEAD) return null;
  if (raw[0] !== MAGIC0 || raw[1] !== MAGIC1 || raw[2] !== VERSION) return null;
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const len = dv.getUint16(14);
  // I decoder QR restituiscono spesso padding in coda: LEN e' l'unica verita'.
  if (raw.length < 16 + len + 4) return null;
  if (dv.getUint32(16 + len) !== crc32(raw, 0, 16 + len)) return null;
  return {
    type: raw[3],
    session: dv.getUint32(4),
    blockIdx: dv.getUint16(8),
    esi: dv.getUint32(10),
    payload: raw.subarray(16, 16 + len),
  };
}

// ----------------------------------------------------------------------- manifest
/*   0   8  origLen (float64 per semplicita', valori interi esatti < 2^53)
     8  32  sha256 del file originale
    40   2  symbolSize
    42   2  nSourceBlocks
    44   1  flags   bit0 = gzip
    45   4  sbRawSize   byte non compressi per source block
    49   2  nameLen
    51   N  name (UTF-8)
  51+N 4*nSB compressedLen[i]                                        */

export function packManifest(m) {
  const name = new TextEncoder().encode(m.name);
  const out = new Uint8Array(51 + name.length + 4 * m.compressedLens.length);
  const dv = new DataView(out.buffer);
  dv.setFloat64(0, m.origLen);
  out.set(m.sha256, 8);
  dv.setUint16(40, m.symbolSize);
  dv.setUint16(42, m.compressedLens.length);
  out[44] = m.flags;
  dv.setUint32(45, m.sbRawSize);
  dv.setUint16(49, name.length);
  out.set(name, 51);
  m.compressedLens.forEach((L, i) => dv.setUint32(51 + name.length + 4 * i, L));
  return out;
}

export function unpackManifest(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const origLen = dv.getFloat64(0);
  const sha256 = b.subarray(8, 40);
  const symbolSize = dv.getUint16(40);
  const nSB = dv.getUint16(42);
  const flags = b[44];
  const sbRawSize = dv.getUint32(45);
  const nameLen = dv.getUint16(49);
  const name = new TextDecoder().decode(b.subarray(51, 51 + nameLen));
  const compressedLens = [];
  for (let i = 0; i < nSB; i++) compressedLens.push(dv.getUint32(51 + nameLen + 4 * i));
  // Limiti difensivi: questo e' input non fidato (chiunque puo' mostrare un QR).
  if (symbolSize < 16 || symbolSize > 4096) throw new Error("symbolSize fuori intervallo");
  if (nSB < 1 || nSB > 20000) throw new Error("nSourceBlocks fuori intervallo");
  if (!(origLen >= 0 && origLen < 2 ** 45)) throw new Error("origLen fuori intervallo");
  return { origLen, sha256, symbolSize, flags, sbRawSize, name, compressedLens };
}

export const kForBlock = (compressedLen, symbolSize) =>
  Math.max(1, Math.ceil(compressedLen / symbolSize));
