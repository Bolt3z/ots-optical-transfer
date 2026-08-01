// ===========================================================================
// app.mjs — Strato adattatore: DOM, camera, file. La logica del protocollo
// sta tutta in core.mjs; qui si fa solo I/O e interfaccia.
// ===========================================================================

const SB_RAW = 4 * 1024 * 1024;   // byte non compressi per source block
const MANIFEST_EVERY = 16;        // un manifest ogni N frame
const PASS_OVERHEAD = 1.4;        // simboli emessi per blocco = K * questo
const NO_CODE_MS = 3000;          // silenzio oltre il quale diciamo "non vedo nulla"
const STALLED_MS = 6000;          // leggiamo, ma niente di nuovo: TX fermo

// gzip vive dietro CompressionStream, che Safari ha solo dal 16.4. Senza di
// esso non si fallisce: si trasmette non compresso.
const HAS_GZIP = typeof CompressionStream === "function";
const HAS_GUNZIP = typeof DecompressionStream === "function";

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------- utilita'
async function gzip(u8) {
  const s = new Blob([u8]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function gunzip(u8) {
  const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function sha256(u8) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", u8));
}
/** Digest a blocchi: sha256 della concatenazione degli sha256 dei source block.
 *  Calcolabile in streaming da entrambi i lati, senza tenere il file in RAM. */
async function rootDigest(blockHashes) {
  const cat = new Uint8Array(blockHashes.length * 32);
  blockHashes.forEach((h, i) => cat.set(h, i * 32));
  return sha256(cat);
}
const fmtBytes = (n) =>
  n < 1024 ? `${n} B`
    : n < 1048576 ? `${(n / 1024).toFixed(1)} kB`
      : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB`
        : `${(n / 1073741824).toFixed(2)} GB`;
const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) return "—";
  const m = Math.floor(s / 60);
  return m ? `${m}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`;
};
const hex = (u8) => Array.from(u8).map((b) => b.toString(16).padStart(2, "0")).join("");

function setMode(mode) {
  for (const m of ["send", "recv"]) {
    $(`panel-${m}`).hidden = m !== mode;
    $(`tab-${m}`).setAttribute("aria-selected", String(m === mode));
  }
  if (mode !== "send") TX.stop();
  if (mode !== "recv") RX.stop();
}

/** Larghezza utile del palco, ricalcolata a ogni frame: il telefono ruota. */
function stageWidth() {
  const el = $("tx-canvas").parentElement;
  const w = el ? el.clientWidth : 0;
  return Math.max(160, Math.min(w || (window.innerWidth - 48), 720));
}

/** Disegna una matrice QR su canvas, con quiet zone. */
function drawQR(canvas, modules, size, cssPx) {
  const border = 4;
  const total = size + 2 * border;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const px = Math.max(1, Math.floor((cssPx * dpr) / total));   // px interi: niente moire'
  const dim = px * total;
  if (canvas.width !== dim) { canvas.width = dim; canvas.height = dim; }
  canvas.style.width = canvas.style.height = `${dim / dpr}px`;
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, dim, dim);
  ctx.fillStyle = "#000";
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if (modules[y][x]) ctx.fillRect((x + border) * px, (y + border) * px, px, px);
  return px;
}

/** Barra segmentata: un segmento per source block. E' il display principale. */
function renderStrip(el, n, state) {
  if (el.childElementCount !== n) {
    el.textContent = "";
    for (let i = 0; i < n; i++) el.appendChild(document.createElement("i"));
  }
  [...el.children].forEach((seg, i) => {
    seg.className = state(i);
    seg.style.flexGrow = "1";
  });
}

// ======================================================================= INVIO
const TX = {
  timer: null, running: false, plan: null,

  async prepare(file, opts) {
    const nSB = Math.max(1, Math.ceil(file.size / SB_RAW));
    const wanted = opts.compress && HAS_GZIP;
    const blocks = [], hashes = [], lens = [];
    // Il formato ha UN solo bit di gzip per tutto il file, quindi la decisione
    // si prende sul primo blocco e vale per tutti. Comprimere ogni blocco per
    // poi ricomprimere quelli che non guadagnavano era il difetto precedente.
    let useGzip = wanted;
    for (let i = 0; i < nSB; i++) {
      const raw = new Uint8Array(
        await file.slice(i * SB_RAW, Math.min((i + 1) * SB_RAW, file.size)).arrayBuffer());
      hashes.push(await sha256(raw));
      let payload = raw;
      if (wanted && (i === 0 || useGzip)) {
        const z = await gzip(raw);
        if (i === 0) useGzip = z.length < raw.length * 0.98;
        if (useGzip) payload = z;
      }
      blocks.push(payload);
      lens.push(payload.length);
      $("tx-prep").textContent = `preparazione blocco ${i + 1}/${nSB}`;
    }

    const session = (Math.random() * 2 ** 32) >>> 0;
    const manifest = OTS.packManifest({
      origLen: file.size, sha256: await rootDigest(hashes),
      symbolSize: opts.symbolSize, flags: useGzip ? 1 : 0, sbRawSize: SB_RAW,
      name: file.name.slice(0, 120), compressedLens: lens,
    });
    const encoders = blocks.map((b) => new OTS.LTEncoder(b, opts.symbolSize, session));
    return {
      session, manifest, encoders, opts, gzip: useGzip,
      systematic: encoders.filter((e) => e.plan).length,
      totalK: encoders.reduce((a, e) => a + e.K, 0),
      compressedTotal: lens.reduce((a, b) => a + b, 0),
      origLen: file.size, name: file.name,
    };
  },

  start(plan) {
    this.plan = plan; this.running = true;
    let frameNo = 0, blockIdx = 0, emitted = 0, sent = 0;
    const t0 = performance.now();
    const period = 1000 / plan.opts.fps;

    const step = () => {
      if (!this.running) return;
      const e = plan.encoders[blockIdx];
      let frame;
      if (frameNo % MANIFEST_EVERY === 0) {
        frame = OTS.buildFrame(OTS.T_MANIFEST, plan.session, 0, 0, plan.manifest);
      } else {
        // L'ESI lo scegle l'encoder: per K piccolo emette prima simboli di grado 1.
        const esi = e.nextEsi();
        frame = OTS.buildFrame(OTS.T_DATA, plan.session, blockIdx, esi, e.symbol(esi));
        emitted++;
        if (emitted >= Math.ceil(e.K * PASS_OVERHEAD)) {
          emitted = 0; blockIdx = (blockIdx + 1) % plan.encoders.length;
        }
      }
      frameNo++; sent += frame.length;

      const text = OTS.b45encode(frame);
      const ver = plan.opts.version || OTS.minVersionFor(text.length);
      const { modules, size } = OTS.encodeQR(text, ver);
      const px = drawQR($("tx-canvas"), modules, size, stageWidth());

      const el = performance.now() - t0;
      $("tx-stat-block").textContent = `${blockIdx + 1}/${plan.encoders.length}`;
      $("tx-stat-frame").textContent = frameNo;
      $("tx-stat-qr").textContent = `v${ver} · ${size}×${size} · ${px}px/mod`;
      $("tx-stat-rate").textContent = `${(sent / (el / 1000) / 1024).toFixed(1)} kB/s`;
      renderStrip($("tx-strip"), plan.encoders.length, (i) => i === blockIdx ? "on" : "");

      // Passo ancorato al tempo assoluto: una catena di setTimeout accumula ritardo.
      const due = t0 + frameNo * period;
      this.timer = setTimeout(step, Math.max(0, due - performance.now()));
    };
    step();
  },

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    $("tx-live").hidden = true; $("tx-setup").hidden = false;
  },
};

// ==================================================================== RICEZIONE
const RX = {
  stream: null, raf: null, rvfc: null, painter: null, running: false, st: null,
  scanner: null, videoUrl: null, dlUrl: null, locked: "", queue: Promise.resolve(),

  reset() {
    const now = performance.now();
    this.st = {
      session: null, manifest: null, decoders: new Map(), seen: new Map(),
      done: new Map(), hashes: new Map(), frames: 0, bad: 0, fresh: 0,
      t0: now, lastRead: now, lastFresh: now, note: null,
    };
    this.locked = "";
    $("rx-out").hidden = true;
    $("rx-error").hidden = true;
    $("rx-hint").hidden = true;
    $("rx-strip").textContent = "";
    for (const id of ["rx-name", "rx-size", "rx-session", "rx-engine", "rx-eta", "rx-blocks"])
      $(id).textContent = "—";
    $("rx-pct").textContent = "0%";
    if (this.dlUrl) { URL.revokeObjectURL(this.dlUrl); this.dlUrl = null; }
  },

  fail(msg) {
    $("rx-error").hidden = false;
    $("rx-error").textContent = msg;
  },

  async feed(raw) {
    const st = this.st;
    const f = OTS.parseFrame(raw);
    if (!f) { st.bad++; return; }
    if (st.session === null) {
      st.session = f.session;
      // Mostrarlo serve: se i due lati non concordano, si vede subito.
      $("rx-session").textContent = f.session.toString(16).padStart(8, "0");
    } else if (f.session !== st.session) return;
    st.frames++;

    if (f.type === OTS.T_MANIFEST) {
      if (!st.manifest) {
        const m = OTS.unpackManifest(f.payload);
        if ((m.flags & 1) && !HAS_GUNZIP) {
          this.fail("Il file arriva compresso con gzip, ma questo browser non ha "
            + "DecompressionStream. Ritrasmetti togliendo la spunta «Comprimi».");
          this.stop();
          return;
        }
        st.manifest = m;
        st.fresh++; st.lastFresh = performance.now();
        $("rx-name").textContent = m.name;
        $("rx-size").textContent = fmtBytes(m.origLen);
      }
      return;
    }
    if (!st.manifest) return;
    const m = st.manifest, bi = f.blockIdx;
    if (bi >= m.compressedLens.length || st.done.has(bi)) return;

    let dec = st.decoders.get(bi);
    if (!dec) {
      const K = OTS.kForBlock(m.compressedLens[bi], m.symbolSize);
      dec = new OTS.LTDecoder(K, m.symbolSize, m.compressedLens[bi], st.session);
      st.decoders.set(bi, dec); st.seen.set(bi, new Set());
    }
    const seen = st.seen.get(bi);
    if (seen.has(f.esi)) return;
    seen.add(f.esi);
    st.fresh++; st.lastFresh = performance.now();

    if (dec.addSymbol(f.esi, f.payload)) {
      let data = dec.result();
      if (m.flags & 1) {
        try { data = await gunzip(data); }
        catch { st.done.set(bi, null); return; }
      }
      st.done.set(bi, data);
      st.hashes.set(bi, await sha256(data));
      st.decoders.delete(bi); st.seen.delete(bi);
      if (st.done.size === m.compressedLens.length) await this.finish();
    }
  },

  /** Distingue «non vedo codici» da «li vedo ma il trasmettitore e' fermo».
   *  Senza questo il ricevitore resta muto e non si capisce cosa aggiustare. */
  health() {
    const st = this.st, now = performance.now();
    if (!this.running) return "";
    if (now - st.lastRead > NO_CODE_MS) {
      return "Nessun codice leggibile. Avvicina o allontana la camera, alza la "
        + "luminosità dello schermo trasmittente, o scegli una versione QR più bassa.";
    }
    if (now - st.lastFresh > STALLED_MS) {
      return "Leggo sempre lo stesso codice: il trasmettitore sembra fermo.";
    }
    if (!st.manifest && now - st.t0 > 4000) {
      return `Codici letti, manifest non ancora arrivato: passa una volta ogni `
        + `${MANIFEST_EVERY} frame, dagli qualche secondo.`;
    }
    return "";
  },

  paint() {
    const st = this.st;
    if (!st) return;
    const m = st.manifest;
    const n = m ? m.compressedLens.length : 0;
    const solved = [...st.decoders.values()].reduce((a, d) => a + d.progress, 0);
    const pct = n ? (st.done.size + solved) / n : 0;
    $("rx-pct").textContent = `${(pct * 100).toFixed(1)}%`;
    $("rx-blocks").textContent = n ? `${st.done.size}/${n}` : "—";
    $("rx-frames").textContent = `${st.frames} letti · ${st.bad} scartati`;
    const el = (performance.now() - st.t0) / 1000;
    $("rx-eta").textContent = pct > 0.02 ? fmtTime(el / pct - el) : "—";

    const sc = this.scanner;
    $("rx-engine").textContent = sc && sc.decodes
      ? `${sc.mode}${sc.workers > 1 ? "×" + sc.workers : ""} · ${sc.avgMs.toFixed(0)} ms`
        + `${sc.roiActive ? " · ROI" : ""}${this.locked ? " · " + this.locked : ""}`
      : "—";

    const note = this.health();
    if (note !== st.note) {
      st.note = note;
      $("rx-hint").textContent = note;
      $("rx-hint").hidden = !note;
    }
    if (n) renderStrip($("rx-strip"), n, (i) =>
      st.done.has(i) ? "done" : (st.decoders.has(i) ? "part" : ""));
  },

  async finish() {
    const st = this.st, m = st.manifest, n = m.compressedLens.length;
    const parts = [];
    for (let i = 0; i < n; i++) parts.push(st.done.get(i));
    this.stop();
    if (parts.some((p) => !p)) {
      this.fail("Un source block non si è decompresso: ritrasmetti.");
      return;
    }
    const root = await rootDigest(parts.map((_, i) => st.hashes.get(i)));
    const okHash = hex(root) === hex(m.sha256);
    const blob = new Blob(parts, { type: "application/octet-stream" });

    $("rx-out").hidden = false;
    $("rx-verdict").textContent = okHash ? "Integrità verificata" : "Digest non corrispondente";
    $("rx-verdict").className = okHash ? "verdict ok" : "verdict bad";
    const a = $("rx-download");
    if (this.dlUrl) URL.revokeObjectURL(this.dlUrl);
    this.dlUrl = URL.createObjectURL(blob);
    a.href = this.dlUrl;
    a.download = m.name.replace(/[^\w.\- ]+/g, "_") || "ricevuto.bin";
    a.textContent = `Scarica ${a.download} (${fmtBytes(blob.size)})`;
    // stop() ha fermato il disegno periodico: senza questo l'ultima percentuale
    // mostrata resta quella di un istante prima della fine (visto: 95,1%).
    this.paint();
  },

  /** Le letture arrivano dai worker in ordine qualunque e `feed` e' asincrona:
   *  si accodano su una catena di promesse, cosi' due non si sovrappongono mai
   *  sullo stesso stato. L'ordine fra loro non conta: ogni frame porta il suo ESI. */
  handle(text) {
    if (!this.running || !this.st) return;
    this.st.lastRead = performance.now();
    this.queue = this.queue.then(async () => {
      if (!this.running || !this.st) return;
      const wasBlind = !this.st.manifest;
      try { await this.feed(OTS.b45decode(text)); } catch { this.st.bad++; }
      if (wasBlind && this.st.manifest) await this.lockCamera();
    }).catch(() => { /* un frame andato male non ferma la coda */ });
  },

  scanLoop(source) {
    this.queue = Promise.resolve();
    this.scanner.onText = (text) => this.handle(text);

    // requestVideoFrameCallback scatta una volta per frame davvero presentato:
    // con requestAnimationFrame si rileggerebbe lo stesso frame piu' volte,
    // bruciando batteria per decodificare doppioni.
    const rvfc = typeof source.requestVideoFrameCallback === "function";
    const tick = () => {
      if (!this.running) return;
      if (source.readyState >= 2 && source.videoWidth) this.scanner.pump(source);
      if (!this.running) return;
      if (rvfc) this.rvfc = source.requestVideoFrameCallback(tick);
      else this.raf = requestAnimationFrame(tick);
    };
    tick();
    // Il disegno va avanti anche se i frame non arrivano: e' cosi' che si vede
    // il messaggio «non vedo nessun codice» invece del nulla.
    this.painter = setInterval(() => this.paint(), 300);
  },

  /** Lo schermo trasmittente e' immobile: una camera che continua a rifare fuoco
   *  ed esposizione fa solo danni. Blocchiamo quello che il dispositivo dichiara
   *  di saper bloccare, e mostriamo cos'e' passato davvero. */
  async lockCamera() {
    const track = this.stream && this.stream.getVideoTracks()[0];
    if (!track || typeof track.getCapabilities !== "function") return;
    let caps = {};
    try { caps = track.getCapabilities() || {}; } catch { return; }
    const adv = [];
    const has = (k, v) => Array.isArray(caps[k]) && caps[k].includes(v);
    if (has("focusMode", "manual")) adv.push({ focusMode: "manual" });
    if (has("exposureMode", "manual")) adv.push({ exposureMode: "manual" });
    if (has("whiteBalanceMode", "manual")) adv.push({ whiteBalanceMode: "manual" });
    if (!adv.length) return;
    try {
      await track.applyConstraints({ advanced: adv });
      this.locked = "fisso " + adv.map((a) => Object.keys(a)[0].replace("Mode", "")).join("/");
    } catch { /* dichiarava di poterlo fare e non poteva: pazienza */ }
  },

  async startScanner() {
    if (!this.scanner) this.scanner = new Scanner();
    await this.scanner.start();
  },

  async startCamera() {
    this.reset();
    await this.startScanner();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 }, height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
    } catch (err) {
      this.fail("Camera non disponibile: " + err.name + ". "
        + (window.isSecureContext
          ? "Controlla il permesso della camera per questa pagina."
          : "La pagina non è in contesto sicuro: servila in HTTPS.")
        + " Su iPhone una pagina aperta da file locale non può usare la camera: "
        + "usa «Da un video registrato», oppure apri la pagina via HTTPS.");
      return;
    }
    const v = $("rx-video");
    v.srcObject = this.stream; v.hidden = false;
    try { await v.play(); }
    catch (err) { this.fail("Il video non parte: " + err.name); return; }
    this.running = true;
    this.scanLoop(v);
  },

  async startVideoFile(file) {
    this.reset();
    await this.startScanner();
    const v = $("rx-video");
    v.srcObject = null;
    if (this.videoUrl) URL.revokeObjectURL(this.videoUrl);
    this.videoUrl = URL.createObjectURL(file);
    v.src = this.videoUrl;
    v.hidden = false; v.muted = true; v.playsInline = true;
    try { await v.play(); }
    catch (err) {
      this.fail("Il video non parte: " + err.name + ". Toccalo per avviarlo a mano.");
      return;
    }
    this.running = true;
    v.onended = () => {
      const wasRunning = this.running;
      this.running = false;
      this.paint();
      if (!wasRunning || !this.st) return;
      if (!this.st.manifest) {
        this.fail("Video finito senza leggere un manifest. Riprendi lo schermo più "
          + "da vicino, a fuoco, con tutto il codice dentro l'inquadratura.");
      } else if ($("rx-out").hidden) {
        this.fail("Video finito prima di completare il file: riprendi più a lungo, "
          + "la trasmissione va in ciclo continuo.");
      }
    };
    this.scanLoop(v);
  },

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    clearInterval(this.painter);
    const v = $("rx-video");
    if (v && this.rvfc && typeof v.cancelVideoFrameCallback === "function") {
      v.cancelVideoFrameCallback(this.rvfc);
    }
    this.rvfc = null;
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    if (this.scanner) this.scanner.stop();
    if (v) { v.pause(); v.srcObject = null; }
  },
};

// ======================================================================== avvio
window.addEventListener("DOMContentLoaded", () => {
  $("tab-send").onclick = () => setMode("send");
  $("tab-recv").onclick = () => setMode("recv");

  if (!HAS_GZIP) {
    $("tx-compress").checked = false;
    $("tx-compress").disabled = true;
    $("tx-compress-note").hidden = false;
  }

  $("tx-file").onchange = () => {
    const f = $("tx-file").files[0];
    $("tx-go").disabled = !f;
    $("tx-filename").textContent = f ? `${f.name} · ${fmtBytes(f.size)}` : "Nessun file scelto";
  };

  $("tx-go").onclick = async () => {
    const f = $("tx-file").files[0];
    if (!f) return;
    $("tx-go").disabled = true; $("tx-prep").hidden = false;
    const verSel = +$("tx-version").value;
    const opts = {
      fps: +$("tx-fps").value,
      version: verSel || 0,
      symbolSize: +$("tx-symsize").value,
      compress: $("tx-compress").checked,
    };
    try {
      const plan = await TX.prepare(f, opts);
      $("tx-prep").hidden = true; $("tx-setup").hidden = true; $("tx-live").hidden = false;
      $("tx-stat-k").textContent = `${plan.totalK} simboli · ${fmtBytes(plan.compressedTotal)}`
        + (plan.gzip ? " gzip" : "");
      // frame per giro completo = simboli (K*PASS_OVERHEAD) + manifest intercalati
      const framesPerPass = plan.totalK * PASS_OVERHEAD * (MANIFEST_EVERY / (MANIFEST_EVERY - 1));
      $("tx-stat-eta").textContent = fmtTime(framesPerPass / opts.fps);
      TX.start(plan);
    } catch (err) {
      $("tx-prep").textContent = "Errore: " + err.message;
      $("tx-go").disabled = false;
    }
  };
  $("tx-stop").onclick = () => TX.stop();

  $("rx-cam").onclick = () => RX.startCamera();
  $("rx-videofile").onchange = () => {
    const f = $("rx-videofile").files[0];
    if (f) RX.startVideoFile(f);
  };
  $("rx-stop").onclick = () => { RX.stop(); RX.paint(); };

  setMode("send");
});

// Appiglio per diagnosticare da telefono, dove una console comoda non c'e'.
window.OTS_DEBUG = { TX, RX, caps: { gzip: HAS_GZIP, gunzip: HAS_GUNZIP } };
