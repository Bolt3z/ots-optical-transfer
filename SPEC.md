# OTS — Specifica di consegna

Documento per chi continua lo sviluppo (umano o Claude Code).
Riferimento concettuale: `BIBBIA-trasferimento-offline.md`.

---

## 1. Cosa c'è, e cosa è stato verificato

| Componente | File | Stato |
|---|---|---|
| PRNG normativo SplitMix32 | `src/core.mjs` | ✅ verificato identico all'implementazione Python |
| Codice fontana LT | `src/core.mjs` | ✅ overhead 1.09–1.18× per K ≥ 512 |
| Piano sistematico per K ≤ 64 | `src/core.mjs` | ✅ overhead 1.000× per K = 2, 5, 20, 64 |
| Base45 (RFC 9285) | `src/core.mjs` | ✅ roundtrip su lunghezze 0–199 |
| Framing + CRC32 | `src/core.mjs` | ✅ tollera padding in coda, rileva corruzione |
| Manifest + source block | `src/core.mjs` | ✅ roundtrip; 10 casi di input malformato respinti |
| Encoder QR (alfanumerico, ECC L, v1–40) | `src/qrencode.mjs` | ✅ 80/80 letti da ZBar; 66/80 bit-identici a `segno` |
| Decoder QR | `vendor/jsQR.min.js` | ✅ 9/9 versioni sui codici prodotti dal nostro encoder |
| Trasmettitore (UI, canvas, loop) | `src/app.mjs` | ✅ canvas rileggibile da un decoder QR, zero richieste di rete |
| Ricevitore camera (`getUserMedia`) | `src/app.mjs`, `src/scanner.mjs` | ✅ camera finta Y4M in Chrome: file ricevuto byte-identico |
| Ricevitore da video registrato | `src/app.mjs` | ✅ mp4 H.264 in Chrome: file ricevuto byte-identico |
| Decodifica in Web Worker + ROI | `src/scanner.mjs` | ✅ provata sia con worker sia col ripiego su thread principale |
| Catena completa protocollo | `test/e2e.test.mjs` | ✅ 4 scenari, incl. 3 source block e 35% di perdita |

Lo strato DOM/camera, che nella consegna precedente non era **mai stato eseguito**, ora è
provato in un Chrome vero da `test/browser.test.mjs`: il trasmettitore disegna, i suoi QR
diventano un video YUV4MPEG2 passato a Chrome come camera finta, e il file che esce dal
download viene confrontato byte per byte con l'originale.

**Resta non verificato su hardware reale:** una camera fisica che mette a fuoco e regola
l'esposizione da sola, Safari su iPhone, e `applyConstraints` per bloccare fuoco ed
esposizione (il codice applica solo ciò che il dispositivo dichiara di supportare, ma nessun
dispositivo vero l'ha ancora confermato).

### Test

```bash
npm install                       # puppeteer-core, solo per i test in browser
npm run build                     # assembla dist/ots.html
node test/core.test.mjs           # fontana, piano sistematico, base45, framing, manifest
node test/e2e.test.mjs            # catena completa sul bundle costruito (~4 min)
node test/browser.test.mjs        # canvas, camera finta, worker, download in Chrome vero
node test/qr-sweep.mjs            # genera QR di tutte e 40 le versioni
```

---

## 2. Il protocollo (normativo)

### 2.1 Frame

Big-endian. 20 byte di overhead.

```
 off  len  campo
  0    2   MAGIC        0x4F 0x54 ("OT")
  2    1   VERSION      0x01
  3    1   TYPE         0x01 MANIFEST | 0x02 DATA
  4    4   SESSION_ID   uint32 casuale per sessione
  8    2   BLOCK_IDX    indice del source block
 10    4   ESI          Encoding Symbol ID
 14    2   LEN          lunghezza del payload
 16  LEN   PAYLOAD
16+LEN 4   CRC32        (poly 0xEDB88320) su [0 .. 16+LEN)
```

**Regola inderogabile:** tagliare su `LEN` *prima* di verificare il CRC. I decoder QR
restituiscono byte di padding in coda; ignorarlo fa scartare frame validi.

### 2.2 Manifest (payload dei frame TYPE=1)

```
 off  len  campo
  0    8   origLen        float64, valore intero
  8   32   digest         SHA-256 a blocchi (vedi 2.4)
 40    2   symbolSize
 42    2   nSourceBlocks
 44    1   flags          bit0 = gzip
 45    4   sbRawSize      byte non compressi per source block
 49    2   nameLen
 51    N   name           UTF-8
51+N  4·nSB compressedLen[i]
```

`K_i = max(1, ceil(compressedLen[i] / symbolSize))`.

Trasmesso una volta ogni 16 frame. Il manifest **non consuma un ESI**.

### 2.3 PRNG e vicini — NORMATIVO

Qualunque porting deve riprodurre questo esattamente, o i flussi non sono interoperabili.

```js
mixSeed(session, esi):
    x = (session + imul(esi, 0x9E3779B9)) | 0
    x ^= x >>> 16;  x = imul(x, 0x21f0aaad)
    x ^= x >>> 15;  x = imul(x, 0x735a2d97)
    x ^= x >>> 15
    return x

splitmix32(seed) → next():
    a = (a + 0x9E3779B9) | 0
    t = a ^ (a >>> 16);  t = imul(t, 0x21f0aaad)
    t ^= t >>> 15;       t = imul(t, 0x735a2d97)
    t ^= t >>> 15
    return (t >>> 0) / 4294967296

symbolNeighbours(esi, K, session):
    rnd = splitmix32(mixSeed(session, esi))
    d   = min(sampleDegree(rnd, robustSolitonCdf(K)), K)
    Set vuoto; finché |Set| < d: aggiungi floor(rnd()*K) % K
    ritorna gli elementi in ordine di inserimento
```

Robust Soliton con **c = 0.03, δ = 0.5**.

⚠️ La CDF usa `Math.log` in virgola mobile. Due runtime potrebbero differire di 1 ULP e,
con probabilità trascurabile ma non nulla, scegliere un grado diverso al confine. Per
un'interoperabilità stretta fra linguaggi, calcolare la CDF in virgola fissa. Python e
JavaScript sono stati verificati identici su 48 casi.

### 2.4 Digest a blocchi

`digest = SHA256( SHA256(blocco₀) ‖ SHA256(blocco₁) ‖ … )` sui blocchi **non compressi**.

Scelto invece dell'hash del file intero perché è calcolabile in streaming: nessuno dei due
lati deve mai tenere il file completo in memoria.

---

## 3. Priorità di lavoro

### Fatto (era P0 e P1)
- ✅ Provato in Chrome desktop, invio e ricezione, con test automatico ripetibile.
- ✅ Ripiego pulito quando `CompressionStream` manca: la compressione si disattiva da sola,
  e un ricevitore senza `DecompressionStream` lo dice invece di fallire in silenzio.
- ✅ Decodifica in Web Worker. Contrariamente all'ipotesi iniziale, il costo non era
  `getImageData` (1,6 ms) ma `jsQR` (39,7 ms a 800×600): i pixel si leggono sul thread
  principale e al worker si trasferisce solo il buffer. Due worker, perché con uno la
  latenza dello scambio di messaggi non si nasconde.
- ✅ Ritaglio della regione d'interesse dopo il primo aggancio, con ritorno a inquadratura
  piena dopo 8 tentativi a vuoto.
- ✅ `requestVideoFrameCallback` dove c'è: un frame, un tentativo. Prima, con
  `requestAnimationFrame`, lo stesso frame si decodificava due o tre volte — 106 tentativi
  invece di 44 per lo stesso file.
- ⚠️ `applyConstraints` per bloccare fuoco ed esposizione: scritto, **disattivato per
  default**. Su iPhone il blocco scatta esattamente quando arriva il primo manifest, e se il
  dispositivo fissa il fuoco nel momento sbagliato da lì in poi ogni frame è sfocato — il
  sintomo osservato è «legge qualche frame, poi nessun codice leggibile». Un'ottimizzazione
  non verificata non deve poter rompere il caso base: si abilita con
  `window.OTS_LOCK_CAMERA = true`.
- ✅ Cane da guardia su `requestVideoFrameCallback`: se le callback non arrivano entro 1,2 s
  si passa a `requestAnimationFrame` e non si torna indietro. Alcuni Safari smettono di
  chiamarla su uno stream della camera, e il ciclo di scansione si fermava in silenzio.
  `test/browser.test.mjs` riproduce il guasto (callback che scatta tre volte e poi tace).
- ✅ La percentuale misura i **simboli raccolti**, non la frazione risolta dal peeling: con
  K = 4000 solo lo 0,4% dei simboli ha grado 1, quindi l'indicatore restava a 0,0% per quasi
  tutto il trasferimento e l'app sembrava rotta. C'è anche un campo con i conteggi veri.
- ✅ Versione QR predefinita su `automatica`. Il default precedente (v25 con 600 byte per
  simbolo) produceva 930 caratteri in un codice che ne contiene 1853: il QR più difficile da
  leggere alla velocità di uno facile.
- ✅ Piano sistematico per K ≤ 64: overhead 1.000× invece di 1.6–1.9×.
- ✅ `unpackManifest`: limiti su `compressedLens`, `sbRawSize`, lunghezza del buffer, e
  controlli **prima** di allocare.
- ✅ Il ricevitore distingue «non vedo nessun codice» da «trasmettitore fermo».
- ✅ `TX.prepare` non comprime più due volte: la decisione su gzip si prende sul primo
  source block e vale per tutti, perché il formato ha un solo bit di flag.

### P1 — Quel che resta del ricevitore
1. **Sostituire jsQR con `zxing-wasm`.** È il collo di bottiglia: 39,7 ms su 42 a 800×600.
   Su iPhone il confronto è brutale — l'app Fotocamera usa un rilevatore accelerato in
   hardware, e Safari **non lo espone alle pagine web** (niente `BarcodeDetector`, che invece
   Chrome su Android ha). WebAssembly è l'unico modo di recuperare terreno: tipicamente 2–5×,
   e più robusto sui codici densi. Attenzione all'aspettativa: il tempo di trasferimento è
   governato da `byte per frame × fps`, quindi un decoder più veloce serve a non perdere
   frame e a poter alzare densità e fps, non a moltiplicare la banda.
2. Usare `BarcodeDetector` dove esiste (Android Chrome): motore nativo, a costo zero.
3. Provare su hardware vero: Android Chrome, e verificare se `applyConstraints` su qualche
   dispositivo blocchi fuoco ed esposizione senza rompere la messa a fuoco (vedi §1).

### P2 — File grandi
3. **Il ricevitore tiene tutti i blocchi in RAM.** Oltre ~100 MB il tab muore. Passare alla
   File System Access API (`showSaveFilePicker` + `createWritable`) per scrivere ogni
   source block su disco appena si completa; ripiegare su IndexedDB dove non c'è.
4. Ripresa fra sessioni: salvare i blocchi completati e riprendere.
5. Derivare il `SESSION_ID` dal digest del file invece che a caso: due trasmissioni dello
   stesso file generano lo stesso flusso, quindi le ricezioni parziali si sommano.

### P3 — Velocità
6. Affiancare più QR sullo schermo (tiling). `jsQR` legge un solo codice per immagine:
   serve ritagliare le celle della griglia e decodificarle separatamente, oppure passare a
   un decoder multi-simbolo. Con un pool di worker la struttura c'è già.
7. Sostituire LT con RaptorQ (RFC 6330). Guadagno ~15%, interessa solo `core.mjs`.
8. Canale di ritorno bidirezionale: il ricevitore mostra un QR piccolo con i blocchi
   mancanti, il trasmettitore salta quelli già completi.

### P4 — Sicurezza
9. Cifratura XChaCha20-Poly1305 (via `libsodium-wrappers`) prima del codice fontana.
10. Il file scaricato va trattato come non fidato. Non aprirlo né mostrarne l'anteprima.

---

## 4. Vincoli da non violare

- **Un solo file, nessuna rete.** `dist/ots.html` deve restare apribile da `file://` con la
  rete staccata. Niente CDN, niente font remoti, niente fetch.
- **`core.mjs` non deve conoscere il DOM.** È il modulo che verrà portato su altre
  piattaforme: se ci entra `document` o `canvas`, il porting diventa una riscrittura.
- **Non cambiare il formato del frame senza alzare `VERSION`.**
- **Testare sempre con dati casuali incomprimibili.** Il testo ripetitivo si comprime così
  tanto che K diventa 1 e il codice fontana non viene mai esercitato davvero.

## 5. Difetti noti

- La scelta della maschera QR differisce da `segno` in 14 casi su 80. Funzionalmente
  irrilevante (ZBar e jsQR leggono tutto), ma la funzione di penalità potrebbe non essere
  esattamente conforme allo standard. Verificare se si vuole la conformità formale.
- Il flag gzip è unico per tutto il file: su un file misto (metà già compressa, metà testo)
  la decisione presa sul primo source block è sbagliata per gli altri. Per farlo per blocco
  serve un bit nel frame, quindi `VERSION` 2.
- `SB_RAW` è fisso a 4 MB: `TX.prepare` tiene in RAM tutti i payload preparati, quindi un
  file grande sta interamente in memoria anche in trasmissione, non solo in ricezione.
- Il piano sistematico per K ≤ 64 scandisce fino a `600·K + 8000` ESI cercando simboli di
  grado 1. Costa qualche millisecondo alla preparazione e, se non copre tutti gli indici,
  si ripiega silenziosamente sulla fontana pura. Non è mai capitato nei test, ma può.
- `avgMs` nel resoconto è la latenza per tentativo, non il tempo di CPU: con due worker in
  volo comprende l'attesa in coda, quindi appare più alto del costo reale di jsQR.
- La ROI si impara dagli angoli dell'ultimo codice letto: se ci sono due schermi
  trasmittenti nell'inquadratura, il riquadro rimbalza fra i due.
