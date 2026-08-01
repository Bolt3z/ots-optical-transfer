// ===========================================================================
// scanner.mjs — Da un <video> a testi QR.
//
// Misurato a 800x600 su questo codice: drawImage 0,4 ms, getImageData 1,6 ms,
// jsQR 39,7 ms. La decodifica e' tutto il costo, la lettura dei pixel niente.
// Da qui due scelte:
//
//  1. I pixel si leggono sul thread principale (2 ms) e al worker si manda solo
//     il buffer, trasferito senza copia. La variante con createImageBitmap +
//     OffscreenCanvas costava 15 ms in piu' per frame e pretendeva API che
//     Safari ha aggiunto tardi.
//  2. Non un worker ma due: con uno solo il thread principale resta a guardare
//     durante i 40 ms di jsQR e la latenza dello scambio di messaggi non si
//     nasconde. Con due, mentre uno decodifica l'altro riceve il frame dopo.
//     Si puo' fare perche' i frame OTS sono indipendenti: portano il proprio
//     ESI, quindi l'ordine in cui tornano non conta.
//
// Il worker nasce da un blob costruito col sorgente di jsQR preso dal tag
// <script type="text/plain">: una sola copia nel file, nessuna rete. Dove il
// worker non si puo' creare si decodifica sul thread principale: piu' scattoso,
// non rotto.
// ===========================================================================

const JSQR_OPTS = { inversionAttempts: "dontInvert" };
const ROI_MARGIN = 0.28;      // quanto allargare il riquadro agganciato
const ROI_MIN_FRAC = 0.14;    // mai ritagliare sotto questa frazione del lato
const ROI_GIVE_UP = 8;        // tentativi a vuoto prima di tornare a inquadratura piena
const ROI_SNAP = 32;          // le misure della regione si arrotondano a questo
const MAX_WORKERS = 2;        // oltre due si decodificano solo doppioni
const JOB_TIMEOUT = 5000;     // un worker muto non deve bloccare il suo posto

const WORKER_GLUE = `
self.onmessage = function (ev) {
  var d = ev.data;
  try {
    var r = self.jsQR(new Uint8ClampedArray(d.buf), d.w, d.h, ${JSON.stringify(JSQR_OPTS)});
    self.postMessage({ id: d.id, text: r ? r.data : null, loc: r ? r.location : null });
  } catch (e) {
    self.postMessage({ id: d.id, text: null, error: String((e && e.message) || e) });
  }
};
`;

/** Sorgente di jsQR: sta in un tag non eseguito, cosi' il thread principale non
 *  ne paga la compilazione quando la decodifica avviene nei worker. */
function jsqrSource() {
  const el = document.getElementById("jsqr-src");
  if (!el) throw new Error("sorgente jsQR mancante nel documento");
  return el.textContent;
}

let mainThreadJsQR = null;
function jsqrOnMainThread() {
  if (!mainThreadJsQR) {
    if (typeof self.jsQR !== "function") new Function(jsqrSource()).call(self);
    mainThreadJsQR = self.jsQR;
    if (typeof mainThreadJsQR !== "function") throw new Error("jsQR non si e' caricato");
  }
  return mainThreadJsQR;
}

export class Scanner {
  constructor() {
    this.mode = "main";
    this.workers = 0;         // quanti worker si sono davvero avviati
    this.pool = [];           // [{worker, busy}]
    this.onText = null;       // callback(testo) per ogni lettura riuscita
    this.roi = null;          // {x,y,w,h} in coordinate del video
    this.misses = 0;
    this.decodes = 0;         // tentativi
    this.reads = 0;           // tentativi andati a buon fine
    this.skipped = 0;         // frame saltati perche' tutti i worker occupati
    this.msTotal = 0;
    this._seq = 0;
    this._jobs = new Map();
    this._canvas = null;
    this._ctx = null;
  }

  /** Prova la via veloce. Non lancia: se i worker non nascono, si resta su main. */
  async start() {
    this.mode = "main";
    this.workers = 0;
    this.pool = [];
    this.roi = null;
    this.misses = 0;
    // Via d'uscita se un dispositivo ha un worker che si comporta male:
    // window.OTS_NO_WORKER = true prima di avviare la ricezione.
    if (self.OTS_NO_WORKER || typeof Worker !== "function") return this.mode;
    const want = Math.max(1, Math.min(MAX_WORKERS,
      (navigator.hardwareConcurrency || 2) - 1));
    let url = null;
    try {
      url = URL.createObjectURL(
        new Blob([jsqrSource(), "\n", WORKER_GLUE], { type: "text/javascript" }));
      for (let i = 0; i < want; i++) {
        const w = await this._spawn(url);
        if (w) this.pool.push({ worker: w, busy: false });
        else break;
      }
      this.workers = this.pool.length;
      if (this.pool.length) this.mode = "worker";
    } catch {
      /* si resta su main */
    } finally {
      // I worker restano validi dopo la revoca: il sorgente e' gia' stato letto.
      if (url) URL.revokeObjectURL(url);
    }
    return this.mode;
  }

  /** Crea un worker e lo mette alla prova: nato non basta, deve rispondere. */
  async _spawn(url) {
    let w;
    try { w = new Worker(url); } catch { return null; }
    const ok = await new Promise((res) => {
      const t = setTimeout(() => res(false), 4000);
      w.onerror = () => { clearTimeout(t); res(false); };
      w.onmessage = (ev) => {
        if (ev.data && ev.data.id === "ping") { clearTimeout(t); res(!ev.data.error); }
      };
      const buf = new Uint8ClampedArray(8 * 8 * 4).fill(255).buffer;
      w.postMessage({ id: "ping", buf, w: 8, h: 8 }, [buf]);
    });
    if (!ok) { w.terminate(); return null; }
    w.onmessage = (ev) => this._onResult(ev.data);
    w.onerror = () => {
      for (const [id, job] of this._jobs) {
        if (job.slot.worker === w) { this._jobs.delete(id); job.slot.busy = false; }
      }
    };
    return w;
  }

  /** `mode`, `workers` e `roi` restano come erano: il resoconto si legge DOPO
   *  che la ricezione e' finita, e azzerarli lo svuoterebbe di senso.
   *  Li ripulisce `start()`. */
  stop() {
    for (const s of this.pool) s.worker.terminate();
    this.pool = [];
    for (const job of this._jobs.values()) clearTimeout(job.timer);
    this._jobs.clear();
    this.onText = null;
  }

  get roiActive() { return this.roi !== null; }
  get avgMs() { return this.decodes ? this.msTotal / this.decodes : 0; }
  get busy() { return this.pool.length > 0 && this.pool.every((s) => s.busy); }

  /** Regione da leggere: il riquadro agganciato, allargato e limitato al video.
   *  Le misure si arrotondano a multipli di ROI_SNAP perche' il riquadro balla
   *  di qualche pixel a ogni frame: senza arrotondamento la canvas cambierebbe
   *  dimensione in continuazione, e ridimensionarla ne azzera il contenuto. */
  _region(vw, vh) {
    if (!this.roi) return { x: 0, y: 0, w: vw, h: vh };
    const m = ROI_MARGIN;
    let { x, y, w, h } = this.roi;
    x -= w * m; y -= h * m; w *= 1 + 2 * m; h *= 1 + 2 * m;
    const minSide = Math.min(vw, vh) * ROI_MIN_FRAC;
    if (w < minSide) { x -= (minSide - w) / 2; w = minSide; }
    if (h < minSide) { y -= (minSide - h) / 2; h = minSide; }
    w = Math.max(1, Math.min(vw, Math.ceil(w / ROI_SNAP) * ROI_SNAP));
    h = Math.max(1, Math.min(vh, Math.ceil(h / ROI_SNAP) * ROI_SNAP));
    x = Math.max(0, Math.min(vw - w, Math.round(x)));
    y = Math.max(0, Math.min(vh - h, Math.round(y)));
    return { x, y, w, h };
  }

  /** Aggiorna la ROI dai quattro angoli restituiti da jsQR. */
  _learn(loc, reg) {
    if (!loc) {
      if (++this.misses >= ROI_GIVE_UP) { this.roi = null; this.misses = 0; }
      return;
    }
    this.misses = 0;
    const pts = [loc.topLeftCorner, loc.topRightCorner, loc.bottomLeftCorner, loc.bottomRightCorner]
      .filter((p) => p && isFinite(p.x) && isFinite(p.y));
    if (pts.length < 3) return;
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    this.roi = {
      x: reg.x + Math.min(...xs), y: reg.y + Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
    };
  }

  /** Legge i pixel della regione. Sul thread principale costa un paio di ms. */
  _pixels(video, reg) {
    if (!this._canvas) {
      this._canvas = document.createElement("canvas");
      this._ctx = this._canvas.getContext("2d", { willReadFrequently: true });
    }
    const cv = this._canvas;
    if (cv.width !== reg.w || cv.height !== reg.h) { cv.width = reg.w; cv.height = reg.h; }
    this._ctx.drawImage(video, reg.x, reg.y, reg.w, reg.h, 0, 0, reg.w, reg.h);
    return this._ctx.getImageData(0, 0, reg.w, reg.h);
  }

  /**
   * Manda un frame a decodificare, se c'e' posto. Non aspetta il risultato:
   * arriva su `onText`. Restituisce false se il frame e' stato saltato, cosi'
   * il chiamante sa che sta arrivando piu' video di quanto si riesca a leggere.
   */
  pump(video) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return false;
    const slot = this.pool.find((s) => !s.busy);
    if (this.pool.length && !slot) { this.skipped++; return false; }

    const reg = this._region(vw, vh);
    let img;
    try { img = this._pixels(video, reg); } catch { return false; }
    const t0 = performance.now();

    if (!slot) {                          // ripiego: si decodifica qui e ora
      let out = null;
      try { out = this._decodeMain(img); } catch { out = null; }
      this._finish(out, reg, t0);
      return true;
    }
    slot.busy = true;
    const id = ++this._seq;
    const timer = setTimeout(() => {
      const job = this._jobs.get(id);
      if (!job) return;
      this._jobs.delete(id);
      job.slot.busy = false;
      this._finish(null, job.reg, job.t0);
    }, JOB_TIMEOUT);
    this._jobs.set(id, { slot, reg, t0, timer });
    // Il buffer si trasferisce, non si copia: dopo questa riga img.data e' vuoto.
    slot.worker.postMessage({ id, buf: img.data.buffer, w: img.width, h: img.height },
      [img.data.buffer]);
    return true;
  }

  _onResult(data) {
    const job = this._jobs.get(data.id);
    if (!job) return;                     // scaduto, o arrivato dopo lo stop
    this._jobs.delete(data.id);
    clearTimeout(job.timer);
    job.slot.busy = false;
    this._finish(data, job.reg, job.t0);
  }

  _finish(out, reg, t0) {
    this.decodes++;
    this.msTotal += performance.now() - t0;
    this._learn(out && out.loc, reg);
    if (out && out.text) {
      this.reads++;
      if (this.onText) this.onText(out.text);
    }
  }

  _decodeMain(img) {
    const r = jsqrOnMainThread()(img.data, img.width, img.height, JSQR_OPTS);
    return { text: r ? r.data : null, loc: r ? r.location : null };
  }
}
