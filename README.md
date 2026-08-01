# OTS — Optical Transfer Stream

[![CI](https://github.com/Bolt3z/ots-optical-transfer/actions/workflows/ci.yml/badge.svg)](https://github.com/Bolt3z/ots-optical-transfer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Trasferisce file fra due dispositivi con la sola luce: uno schermo mostra una sequenza di
codici QR, una camera li guarda. Nessuna rete, nessun cavo, nessun account, nessun server.

`dist/ots.html` è un **unico file** che contiene tutto — protocollo, encoder QR, decoder,
interfaccia. Aprilo e funziona, anche con il Wi-Fi staccato.

**Provalo subito:** <https://ots.besana.dev/>

## Provalo in un minuto

1. Apri la pagina sul PC → scheda **Invia** → scegli un file → *Avvia trasmissione*.
2. Apri la stessa pagina sul telefono → scheda **Ricevi** → *Usa la camera*.
3. Inquadra lo schermo da 30–50 cm. Al 100% scarica il file.

Luminosità dello schermo al massimo. **Parti da un file piccolo**, non da un video: un file
da 2 MB richiede diversi minuti.

La manopola della velocità è **«Byte per simbolo»**; la versione QR lasciala su `automatica`,
che sceglie sempre il codice più piccolo capace di contenere il frame, cioè il più facile da
leggere.

| Byte per simbolo | QR | Velocità utile @12 fps |
|---|---|---|
| 256 | v11 · 61×61 | ~2,4 kB/s — luce difficile, più distanza |
| 600 | v17 · 85×85 | ~5,6 kB/s — buon punto di partenza |
| 1200 | v25 · 117×117 | ~11,2 kB/s — serve fuoco buono e stare vicino |

Il ricevitore dice cosa non va invece di restare muto: distingue «non vedo nessun codice» da
«leggo sempre lo stesso, il trasmettitore è fermo», e mostra quale motore di decodifica sta
usando, quanti ms costa ogni tentativo e quanti simboli ha raccolto sul totale.

**La percentuale conta i simboli raccolti, non i byte ricostruiti.** In un codice fontana
non si ricostruisce quasi nulla finché non si è vicini al totale, e poi si completa di colpo:
con un file grande, un indicatore basato sulla ricostruzione resterebbe a 0,0% per quasi
tutto il trasferimento.

## Su iPhone

Safari **non concede la camera a una pagina aperta da file locale**. Tre strade:

1. **Apri la pagina da GitHub Pages** (il link sopra): è HTTPS, quindi la camera funziona.
   Una volta caricata, la pagina non usa più la rete — puoi mettere il telefono in modalità
   aereo e continuare. È la strada consigliata.
2. **Registra un video** dello schermo trasmittente con l'app Fotocamera, poi caricalo nel
   campo «da un video registrato». Funziona anche da file locale, e spesso decodifica più in
   fretta del tempo reale. **Caricalo sull'iPhone stesso**, vedi sotto.
3. **Usa l'iPhone come trasmettitore**: mostrare i QR non richiede alcun permesso.

### Il video registrato: dove caricarlo

Il contenitore `.MOV` non è un problema — i browser lo leggono, perché condivide la struttura
ISO-BMFF con `.mp4`. Il problema è il **codec**: con Impostazioni › Fotocamera › Formati su
«Alta efficienza» l'iPhone registra in **HEVC/H.265**, che Safari legge ma **Chrome su Linux
e Firefox no**.

Quindi: carica il video **sull'iPhone**, dove Safari lo apre nativamente. Se invece lo vuoi
decodificare sul PC, hai due strade:

```bash
ffmpeg -i IMG_0001.MOV -c:v libx264 -crf 20 -an video.mp4   # converti
```

oppure metti Formati su «Massima compatibilità» e rigira il video.

Se carichi un video che il browser non sa aprire, l'app te lo dice entro mezzo secondo con
l'istruzione per rimediare — non resta a fissare il vuoto.

Il video viene **riletto automaticamente** finché serve: i frame persi al primo giro — worker
occupati, sfocature, riflessi — si recuperano al secondo, e il codice fontana non ha bisogno
che arrivino in ordine. Se un giro intero non aggiunge nessun simbolo nuovo, il video contiene
troppi pochi frame distinti e l'app lo dice: riprendi più a lungo, la trasmissione va in ciclo
continuo.

**Su iPhone serve un tocco per far partire il video, e non è un difetto.** La scelta del file
avviene nella schermata nativa di Foto, che non concede alla pagina un'attivazione utente:
Safari rifiuta `play()` programmatico qualunque sia l'ordine delle chiamate. L'app mostra un
pulsante *Avvia la lettura*, che è l'unico gesto che Safari accetta. Per evitare il tocco:
disattiva Risparmio energetico, oppure metti la Riproduzione automatica su «Consenti tutto»
nelle impostazioni del sito in Safari.

Su Android Chrome la camera funziona anche da `file://`.

## Su PC, senza rete

Scarica `dist/ots.html` e aprilo con un doppio clic: funziona da `file://`, camera compresa
(verificato su Chrome). Se preferisci servirlo in locale, con Python non serve installare
niente:

```bash
python3 -m http.server 8000 --directory dist
# poi apri http://localhost:8000/ots.html
```

## Come funziona

Il canale ottico perde frame in continuazione: un riflesso, una mano che trema, la camera che
rifà il fuoco. Chiedere la ritrasmissione richiederebbe un canale di ritorno, che non c'è.
Quindi il trasmettitore non manda i pezzi del file: manda **combinazioni XOR** di pezzi,
scelte da un codice fontana (LT, Luby Transform). Il ricevitore ne raccoglie un po' più di
quanti servano, in qualunque ordine, e ricostruisce tutto. Nessuna ritrasmissione, nessuna
sincronizzazione, nessun canale di ritorno.

Encoder e decoder ricavano quali pezzi sono stati combinati dal solo indice del simbolo,
tramite un PRNG concordato: la lista non viaggia mai sul canale.

```
file → source block da 4 MB → gzip → codice fontana LT → frame + CRC32 → Base45 → QR
```

Formato dei frame e parti normative: [`SPEC.md`](SPEC.md).
Il perché delle scelte: [`BIBBIA-trasferimento-offline.md`](BIBBIA-trasferimento-offline.md).

## Prestazioni

| Configurazione | Velocità utile |
|---|---|
| Webcam 720p, QR v20 | 6–9 kB/s |
| Webcam 1080p, QR v25 @12 fps | 12–25 kB/s |
| Telefono 4K, QR v25 @12 fps | 40–60 kB/s |

Un file da 10 MB richiede fra 3 e 25 minuti secondo l'hardware. Sopra i 200 MB serve prima il
lavoro descritto in [`SPEC.md`](SPEC.md) §3.

Overhead del codice fontana, misurato: **1.09–1.18×** per K ≥ 512, e **1.00×** per K ≤ 64,
dove il trasmettitore sceglie ESI sistematici invece di affidarsi alla fontana pura (che a
K = 2 arrivava a 3.5× nel caso peggiore).

Nel ricevitore la decodifica QR costa circa 40 ms per frame a 800×600 e la lettura dei pixel
2 ms: tutto il tempo è in jsQR. Per questo la decodifica sta in un paio di Web Worker e il
thread principale si limita a leggere i pixel, mentre
[`requestVideoFrameCallback`](https://developer.mozilla.org/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)
fa in modo che ogni frame si decodifichi una volta sola invece di tre.

Resta il limite più grosso, e vale dirlo chiaramente: l'app Fotocamera dell'iPhone legge un QR
istantaneamente perché usa un rilevatore accelerato in hardware, e **Safari non lo espone alle
pagine web** — non esiste `BarcodeDetector` su iOS. Una pagina web su iPhone non può usare
quel motore. La strada per recuperare è `zxing-wasm` (§1 di `SPEC.md`), oppure il percorso «da
un video registrato», che usa l'ottica di Apple per riprendere e poi decodifica senza vincoli
di tempo reale.

## Sviluppo

```
src/core.mjs       protocollo: PRNG, fontana LT, Base45, framing, manifest — nessun DOM
src/qrencode.mjs   encoder QR alfanumerico, ECC L, versioni 1–40
src/scanner.mjs    da <video> a testi QR: pool di worker, ritaglio della regione utile
src/app.mjs        interfaccia: canvas, camera, file
src/index.html     struttura e stile
vendor/jsQR.min.js decoder QR (Apache 2.0)
build.mjs          assembla dist/ots.html
python/            implementazione di riferimento del protocollo
test/              test in Node e in Chrome
```

```bash
npm install                    # solo per i test in browser (puppeteer-core)
npm run build                  # ricostruisce dist/ots.html
npm test                       # protocollo + catena completa (~4 min)
npm run test:browser           # canvas, camera finta, worker, download in Chrome vero
```

`test/browser.test.mjs` usa il Chrome già installato (`CHROME_PATH` per indicarne un altro).
Costruisce un video YUV4MPEG2 con i QR che il trasmettitore ha **davvero** disegnato e lo
passa a Chrome come camera finta: `getUserMedia`, il video element, lo scanner, i worker e il
download girano per davvero, e il file ricevuto viene confrontato byte per byte. Prova anche
il ripiego senza worker; con `ffmpeg` presente aggiunge il percorso «da video registrato»,
quello che si usa su iPhone.

### Regole da non violare

- **Un solo file, nessuna rete.** `dist/ots.html` deve restare apribile da `file://` con la
  rete staccata. Niente CDN, niente font remoti, niente `fetch`. Il test in browser lo
  verifica: qualunque richiesta di rete lo fa fallire.
- **`core.mjs` non deve conoscere il DOM.** È il modulo che verrà portato su altre
  piattaforme: se ci entra `document`, il porting diventa una riscrittura.
- **Non cambiare il formato del frame senza alzare `VERSION`.**
- **Testare con dati casuali incomprimibili.** Il testo ripetitivo si comprime così tanto che
  K diventa 1 e il codice fontana non viene mai esercitato davvero.
- `dist/ots.html` è versionato e la CI verifica che corrisponda ai sorgenti: chi lo scarica
  deve usare esattamente la versione provata.

## Sicurezza

Il file ricevuto arriva da un canale non autenticato: **chiunque può mostrare un QR**. Il
digest nel manifest prova che il flusso è arrivato integro, non che venga da chi credi. Non
c'è cifratura: chi riprende lo schermo legge il contenuto. Il manifest viene validato con
limiti espliciti prima di allocare qualunque cosa, ma il file scaricato va trattato come non
fidato — controllalo prima di aprirlo.

## Licenza

MIT, vedi [`LICENSE`](LICENSE). Include jsQR di Cosmo Wolfe, Apache 2.0: vedi
[`NOTICE`](NOTICE) e [`vendor/jsQR.LICENSE`](vendor/jsQR.LICENSE).
