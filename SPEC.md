# OTS — Specifica di consegna

Documento per chi continua lo sviluppo (umano o Claude Code).
Riferimento concettuale: `BIBBIA-trasferimento-offline.md` nella cartella superiore.

---

## 1. Cosa c'è, e cosa è stato verificato

| Componente | File | Stato |
|---|---|---|
| PRNG normativo SplitMix32 | `src/core.mjs` | ✅ verificato identico all'implementazione Python |
| Codice fontana LT | `src/core.mjs` | ✅ overhead 1.16–1.20× per K ≥ 512 |
| Base45 (RFC 9285) | `src/core.mjs` | ✅ roundtrip su lunghezze 0–199 |
| Framing + CRC32 | `src/core.mjs` | ✅ tollera padding in coda, rileva corruzione |
| Manifest + source block | `src/core.mjs` | ✅ roundtrip |
| Encoder QR (alfanumerico, ECC L, v1–40) | `src/qrencode.mjs` | ✅ 80/80 letti da ZBar; 66/80 bit-identici a `segno` |
| Decoder QR | `vendor/jsQR.min.js` | ✅ 9/9 versioni sui codici prodotti dal nostro encoder |
| Trasmettitore (UI, canvas, loop) | `src/app.mjs` | ⚠️ mai eseguito in un browser reale |
| Ricevitore camera (`getUserMedia`) | `src/app.mjs` | ⚠️ mai eseguito in un browser reale |
| Ricevitore da video registrato | `src/app.mjs` | ⚠️ mai eseguito in un browser reale |
| Catena completa protocollo | `test/e2e.test.mjs` | ✅ 4 scenari, incl. 3 source block e 35% di perdita |

**Da leggere con attenzione:** tutta la logica di protocollo è testata a fondo; tutto lo strato
DOM/camera è stato scritto ma **mai eseguito**, perché l'ambiente di sviluppo non aveva un
browser. La prima cosa da fare è aprire `dist/ots.html` e correggere ciò che si rompe.

### Test

```bash
node build.mjs                    # assembla dist/ots.html
cd test
node core.test.mjs                # fountain, base45, framing, manifest
node e2e.test.mjs                 # catena completa sul bundle costruito (~4 min)
node qr-sweep.mjs                 # genera QR di tutte e 40 le versioni
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

### P0 — Farlo funzionare davvero (prima cosa)
1. Aprire `dist/ots.html` in Chrome desktop, provare invio e ricezione con webcam.
2. Correggere gli errori dello strato DOM. Punti sospetti: dimensione del canvas rispetto
   al `devicePixelRatio`, `video.play()` che richiede un gesto dell'utente, `getImageData`
   su canvas grandi (lento).
3. Verificare che `CompressionStream('gzip')` sia presente; in caso contrario disattivare
   la compressione con un fallback pulito.
4. Provare su Android Chrome e su iPhone (percorso «da video registrato»).

### P1 — Prestazioni del ricevitore
5. Spostare la decodifica in un **Web Worker**: adesso `jsQR` gira sul thread principale e
   a 1080p costa 15–30 ms per frame, che compete con il rendering.
6. Ritagliare la regione d'interesse dopo il primo aggancio (dimezza il tempo di decodifica).
7. Bloccare esposizione e bilanciamento del bianco via `MediaStreamTrack.applyConstraints`
   dove supportato.
8. Valutare `zxing-wasm` al posto di jsQR: è più robusto sui codici densi.

### P2 — File grandi
9. **Il ricevitore tiene tutti i blocchi in RAM.** Oltre ~100 MB il tab muore. Passare alla
   File System Access API (`showSaveFilePicker` + `createWritable`) per scrivere ogni
   source block su disco appena si completa; ripiegare su IndexedDB dove non c'è.
10. Ripresa fra sessioni: salvare i blocchi completati e riprendere.
11. Derivare il `SESSION_ID` dal digest del file invece che a caso: due trasmissioni dello
    stesso file generano lo stesso flusso, quindi le ricezioni parziali si sommano.

### P3 — Velocità
12. Affiancare più QR sullo schermo (tiling). `jsQR` legge un solo codice per immagine:
    serve ritagliare le celle della griglia e decodificarle separatamente, oppure passare a
    un decoder multi-simbolo.
13. Sostituire LT con RaptorQ (RFC 6330). Guadagno ~15%, interessa solo `core.mjs`.
14. Canale di ritorno bidirezionale: il ricevitore mostra un QR piccolo con i blocchi
    mancanti, il trasmettitore salta quelli già completi.

### P4 — Sicurezza
15. Cifratura XChaCha20-Poly1305 (via `libsodium-wrappers`) prima del codice fontana.
16. Il file scaricato va trattato come non fidato. Non aprirlo né mostrarne l'anteprima.
17. Rivedere i limiti difensivi in `unpackManifest`: ci sono, vanno estesi a `compressedLens`.

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
- `TX.prepare` comprime due volte i blocchi in cui gzip non conviene. Sistemare.
- Nessuna gestione del caso `K = 1` o `K = 2`, dove il codice fontana ha overhead pessimo
  (misurato 1.9× per K = 2). Sotto K ≈ 20 conviene emettere i blocchi in ciclo semplice.
- Il ricevitore non distingue «trasmissione ferma» da «canale pessimo»: aggiungere un
  timeout che lo dica.
