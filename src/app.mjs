// ===========================================================================
// app.mjs — Strato adattatore: DOM, camera, file. La logica del protocollo
// sta tutta in core.mjs; qui si fa solo I/O e interfaccia.
// ===========================================================================

const SB_RAW = 4 * 1024 * 1024;   // byte non compressi per source block
const MANIFEST_EVERY = 16;        // un manifest ogni N frame
const PASS_OVERHEAD = 1.4;        // simboli emessi per blocco = K * questo

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();

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
    const blocks = [], hashes = [], lens = [];
    for (let i = 0; i < nSB; i++) {
      const raw = new Uint8Array(
        await file.slice(i * SB_RAW, Math.min((i + 1) * SB_RAW, file.size)).arrayBuffer());
      hashes.push(await sha256(raw));
      let payload = raw, flags = 0;
      if (opts.compress) {
        const z = await gzip(raw);
        if (z.length < raw.length) { payload = z; flags = 1; }
      }
      blocks.push({ payload, flags });
      lens.push(payload.length);
      $("tx-prep").textContent = `preparazione blocco ${i + 1}/${nSB}`;
    }
    // Il flag di compressione e' uniforme: se un blocco non guadagna, si accetta.
    const flags = blocks.some((b) => b.flags) ? 1 : 0;
    for (let i = 0; i < nSB; i++)
      if (!blocks[i].flags && flags) blocks[i].payload = await gzip(
        new Uint8Array(await file.slice(i * SB_RAW, Math.min((i + 1) * SB_RAW, file.size)).arrayBuffer()));
    blocks.forEach((b, i) => { lens[i] = b.payload.length; });

    const session = (Math.random() * 2 ** 32) >>> 0;
    const manifest = OTS.packManifest({
      origLen: file.size, sha256: await rootDigest(hashes),
      symbolSize: opts.symbolSize, flags, sbRawSize: SB_RAW,
      name: file.name.slice(0, 120), compressedLens: lens,
    });
    const encoders = blocks.map((b) => new OTS.LTEncoder(b.payload, opts.symbolSize, session));
    return {
      session, manifest, encoders, opts,
      totalK: encoders.reduce((a, e) => a + e.K, 0),
      compressedTotal: lens.reduce((a, b) => a + b, 0),
      origLen: file.size, name: file.name,
    };
  },

  start(plan) {
    this.plan = plan; this.running = true;
    let frameNo = 0, blockIdx = 0, esi = 0, emitted = 0, sent = 0;
    const t0 = performance.now();
    const period = 1000 / plan.opts.fps;

    const step = () => {
      if (!this.running) return;
      const e = plan.encoders[blockIdx];
      let frame;
      if (frameNo % MANIFEST_EVERY === 0) {
        frame = OTS.buildFrame(OTS.T_MANIFEST, plan.session, 0, 0, plan.manifest);
      } else {
        frame = OTS.buildFrame(OTS.T_DATA, plan.session, blockIdx, esi, e.symbol(esi));
        esi++; emitted++;
        if (emitted >= Math.ceil(e.K * PASS_OVERHEAD)) {
          emitted = 0; blockIdx = (blockIdx + 1) % plan.encoders.length;
        }
      }
      frameNo++; sent += frame.length;

      const text = OTS.b45encode(frame);
      const ver = plan.opts.version || OTS.minVersionFor(text.length);
      const { modules, size } = OTS.encodeQR(text, ver);
      const px = drawQR($("tx-canvas"), modules, size, plan.opts.stagePx);

      const el = performance.now() - t0;
      $("tx-stat-block").textContent = `${blockIdx + 1}/${plan.encoders.length}`;
      $("tx-stat-frame").textContent = frameNo;
      $("tx-stat-qr").textContent = `v${ver} · ${size}×${size} · ${px}px/mod`;
      $("tx-stat-rate").textContent = `${(sent / (el / 1000) / 1024).toFixed(1)} kB/s`;
      renderStrip($("tx-strip"), plan.encoders.length, (i) => i === blockIdx ? "on" : "");

      this.timer = setTimeout(step, period);
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
  stream: null, raf: null, running: false, st: null,

  reset() {
    this.st = {
      session: null, manifest: null, decoders: new Map(), seen: new Map(),
      done: new Map(), hashes: new Map(), frames: 0, bad: 0, t0: performance.now(),
    };
    $("rx-out").hidden = true;
    $("rx-strip").textContent = "";
  },

  async feed(raw) {
    const st = this.st;
    const f = OTS.parseFrame(raw);
    if (!f) { st.bad++; return; }
    if (st.session === null) st.session = f.session;
    else if (f.session !== st.session) return;
    st.frames++;

    if (f.type === OTS.T_MANIFEST) {
      if (!st.manifest) {
        st.manifest = OTS.unpackManifest(f.payload);
        $("rx-name").textContent = st.manifest.name;
        $("rx-size").textContent = fmtBytes(st.manifest.origLen);
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

    if (dec.addSymbol(f.esi, f.payload)) {
      let data = dec.result();
      if (m.flags & 1) { try { data = await gunzip(data); } catch { st.done.set(bi, null); return; } }
      st.done.set(bi, data);
      st.hashes.set(bi, await sha256(data));
      st.decoders.delete(bi); st.seen.delete(bi);
      if (st.done.size === m.compressedLens.length) await this.finish();
    }
  },

  paint() {
    const st = this.st, m = st.manifest;
    const n = m ? m.compressedLens.length : 0;
    const solved = [...st.decoders.values()].reduce((a, d) => a + d.progress, 0);
    const pct = n ? (st.done.size + solved) / n : 0;
    $("rx-pct").textContent = `${(pct * 100).toFixed(1)}%`;
    $("rx-blocks").textContent = n ? `${st.done.size}/${n}` : "—";
    $("rx-frames").textContent = `${st.frames} letti · ${st.bad} scartati`;
    const el = (performance.now() - st.t0) / 1000;
    $("rx-eta").textContent = pct > 0.02 ? fmtTime(el / pct - el) : "—";
    if (n) renderStrip($("rx-strip"), n, (i) =>
      st.done.has(i) ? "done" : (st.decoders.has(i) ? "part" : ""));
  },

  async finish() {
    const st = this.st, m = st.manifest, n = m.compressedLens.length;
    const parts = [];
    for (let i = 0; i < n; i++) parts.push(st.done.get(i));
    const root = await rootDigest(parts.map((_, i) => st.hashes.get(i)));
    const okHash = hex(root) === hex(m.sha256);
    const blob = new Blob(parts.map((p) => p), { type: "application/octet-stream" });

    this.stop();
    $("rx-out").hidden = false;
    $("rx-verdict").textContent = okHash ? "Integrità verificata" : "Digest non corrispondente";
    $("rx-verdict").className = okHash ? "verdict ok" : "verdict bad";
    const a = $("rx-download");
    a.href = URL.createObjectURL(blob);
    a.download = m.name.replace(/[^\w.\- ]+/g, "_") || "ricevuto.bin";
    a.textContent = `Scarica ${a.download} (${fmtBytes(blob.size)})`;
  },

  async scanLoop(source, w, h) {
    const cv = $("rx-work"), ctx = cv.getContext("2d", { willReadFrequently: true });
    const tick = async () => {
      if (!this.running) return;
      if (source.readyState >= 2 && source.videoWidth) {
        if (cv.width !== source.videoWidth) { cv.width = source.videoWidth; cv.height = source.videoHeight; }
        ctx.drawImage(source, 0, 0, cv.width, cv.height);
        const img = ctx.getImageData(0, 0, cv.width, cv.height);
        const r = window.jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
        if (r) {
          try { await this.feed(OTS.b45decode(r.data)); } catch { this.st.bad++; }
        }
        this.paint();
      }
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  },

  async startCamera() {
    this.reset();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
    } catch (err) {
      $("rx-error").hidden = false;
      $("rx-error").textContent =
        "Camera non disponibile: " + err.name +
        ". Su iPhone il file locale non può usare la camera — usa «Da un video registrato».";
      return;
    }
    const v = $("rx-video");
    v.srcObject = this.stream; v.hidden = false;
    await v.play();
    this.running = true;
    this.scanLoop(v);
  },

  async startVideoFile(file) {
    this.reset();
    const v = $("rx-video");
    v.srcObject = null; v.src = URL.createObjectURL(file);
    v.hidden = false; v.muted = true; v.playsInline = true;
    await v.play();
    this.running = true;
    v.onended = () => { this.running = false; this.paint(); };
    this.scanLoop(v);
  },

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    const v = $("rx-video");
    if (v) { v.pause(); v.srcObject = null; }
  },
};

// ======================================================================== avvio
window.addEventListener("DOMContentLoaded", () => {
  $("tab-send").onclick = () => setMode("send");
  $("tab-recv").onclick = () => setMode("recv");

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
      stagePx: Math.min(520, window.innerWidth - 48),
    };
    try {
      const plan = await TX.prepare(f, opts);
      $("tx-prep").hidden = true; $("tx-setup").hidden = true; $("tx-live").hidden = false;
      $("tx-stat-k").textContent = `${plan.totalK} blocchi · ${fmtBytes(plan.compressedTotal)}`;
      // frame per giro completo = simboli (K*PASS_OVERHEAD) + manifest intercalati
      const framesPerPass = plan.totalK * 1.4 * (MANIFEST_EVERY / (MANIFEST_EVERY - 1));
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
