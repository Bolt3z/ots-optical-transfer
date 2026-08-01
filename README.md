# OTS — Optical Transfer Stream

Trasferisce file fra due dispositivi con la sola luce: uno schermo mostra una sequenza di
codici QR, una camera li guarda. Nessuna rete, nessun cavo, nessun account, nessun server.

`dist/ots.html` è un **unico file** che contiene tutto. Aprilo e funziona, anche con il
Wi-Fi staccato.

## Provalo in un minuto

1. Apri `dist/ots.html` sul PC → scheda **Invia** → scegli un file → Avvia trasmissione.
2. Apri lo stesso file sul telefono o su un secondo PC → scheda **Ricevi** → Usa la camera.
3. Inquadra lo schermo da 30–50 cm. Quando arriva al 100% scarica il file.

Luminosità dello schermo al massimo. Se la lettura è incerta, abbassa la versione QR o gli fps.

## Su iPhone

Safari **non concede la camera a una pagina aperta da file locale**. Tre strade:

1. **Registra un video** dello schermo trasmittente con l'app Fotocamera, poi caricalo nel
   campo «da un video registrato». Funziona identico e spesso decodifica più in fretta del
   tempo reale. È il percorso consigliato.
2. **Usa l'iPhone come trasmettitore**: mostrare i QR non richiede alcun permesso.
3. **Servi la pagina in HTTPS** (anche da GitHub Pages): allora la camera funziona. Una volta
   caricata, la pagina non usa più la rete.

Su Android Chrome la camera funziona anche da `file://`.

## Sviluppo

```
src/core.mjs       protocollo: PRNG, fontana LT, Base45, framing, manifest — nessun DOM
src/qrencode.mjs   encoder QR alfanumerico, ECC L, versioni 1–40
src/app.mjs        interfaccia: canvas, camera, file
src/index.html     struttura e stile
vendor/jsQR.min.js decoder QR (Apache 2.0)
build.mjs          assembla dist/ots.html
test/              test in Node
```

```bash
node build.mjs           # ricostruisce dist/ots.html
cd test && node core.test.mjs && node e2e.test.mjs
```

Leggi `SPEC.md` prima di modificare il protocollo, e `BIBBIA-trasferimento-offline.md`
per capire perché è fatto così.

## Prestazioni attese

| Configurazione | Velocità utile |
|---|---|
| Webcam 720p, QR v20 | 6–9 kB/s |
| Webcam 1080p, QR v25 @12 fps | 12–25 kB/s |
| Telefono 4K, QR v25 @12 fps | 40–60 kB/s |

Un file da 10 MB richiede fra 3 e 25 minuti secondo l'hardware. Sopra i 200 MB serve prima
il lavoro descritto in `SPEC.md` §3 P2.

## Licenza

Codice di esempio, usalo come vuoi. `vendor/jsQR.min.js` è Apache 2.0 di Cosmo Wolfe.
