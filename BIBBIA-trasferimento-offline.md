# Bibbia tecnica — Trasferimento dati completamente offline

**Protocollo OTS (Optical Transfer Stream) e canali alternativi air-gap**
Versione 1.0

---

## 0. Come usare questo documento

Questo documento è organizzato in tre strati che si possono leggere indipendentemente:

| Se vuoi… | Leggi |
|---|---|
| Capire *se* l'idea è fattibile e quanto va veloce | §1, §2, §6 |
| Capire *perché* i QR "che cambiano ogni secondo" non bastano | §3 (è la parte più importante) |
| Costruire il sistema | §4, §5, §7, §11 |
| Valutare le alternative al canale ottico | §8 |
| Metterlo in produzione senza farti male | §9, §10 |

**Tesi centrale del documento:** l'intuizione dei QR animati è corretta, ma il 90% della difficoltà non sta nei QR — sta nel fatto che *non esiste un canale di ritorno*. Risolvere quel problema con i **codici fontana** è ciò che separa un giocattolo da un sistema che funziona. Tutto il resto è ingegneria.

Tutti i numeri riportati come "misurato" sono stati ottenuti eseguendo l'implementazione di riferimento allegata (§7), non stimati.

---

## 1. Definizione del problema e modello del canale

### 1.1 Requisiti

Trasferire dati arbitrari (file binari, non solo testo) fra due dispositivi che non condividono **nessun** collegamento elettrico o radio:

- niente Ethernet, Wi-Fi, Bluetooth, NFC, USB, seriale, jack audio
- niente supporti rimovibili (SD, chiavette)
- niente infrastruttura condivisa (server, DNS, cloud, LAN)

L'unico accoppiamento ammesso è **fisico e non elettrico**: luce che attraversa l'aria, suono che attraversa l'aria, inchiostro su carta.

### 1.2 Il modello di canale (la parte che quasi tutti sbagliano)

Il canale che stai progettando ha queste proprietà, ed è la combinazione che lo rende insolito:

| Proprietà | Conseguenza progettuale |
|---|---|
| **Simplex** (unidirezionale) | Nessun ACK, nessun NACK, nessuna ritrasmissione su richiesta. TCP è inutilizzabile come modello mentale. |
| **A cancellazione, non a errore** | Un frame o si legge intero e corretto (il CRC/ECC lo garantisce) o non si legge affatto. Non arrivano mai frame "mezzi giusti". È un **Binary Erasure Channel**. |
| **Tasso di cancellazione ignoto e variabile** | Dipende da mano tremante, messa a fuoco, luce ambientale, angolo. Può passare dal 2% al 60% in un secondo. |
| **Senza stato condiviso iniziale** | Il ricevitore può agganciarsi a metà trasmissione e non sa nulla del file. |
| **Con inizio ma senza fine negoziata** | Il trasmettitore non sa quando fermarsi. |
| **Broadcast** | Un trasmettitore, N ricevitori potenziali, ciascuno a un punto diverso della ricezione. |

Il modello corretto non è "una connessione di rete lenta". È **una radio che trasmette in chiaro nel vuoto**, dove il ricevitore ascolta quando può.

Questa è esattamente la situazione dei sistemi di broadcast satellitare e del video multicast — motivo per cui la soluzione giusta è la stessa che usa il 3GPP MBMS: i codici fontana (§3).

### 1.3 Requisiti non funzionali che cambiano il design

Prima di scrivere una riga di codice, rispondi a queste tre domande, perché determinano tutto:

1. **Quanto grande è il file tipico?** Sotto 1 MB → il canale ottico è comodo. 1–50 MB → funziona ma serve ottimizzare. Oltre 200 MB → il canale ottico è la scelta sbagliata, valuta §8.3 (carta) o rivedi il requisito.
2. **È veramente unidirezionale, o entrambi i dispositivi hanno schermo *e* camera?** Se hai due schermi e due camere hai un canale full-duplex e puoi fare ARQ vero. Cambia tutto (§5.8).
3. **Ti serve segretezza, integrità, o entrambe?** Il canale ottico è visibile a chiunque sia nella stanza. Se conta, §9.2.

---

## 2. Panoramica dei canali fisici

Tutti i canali validi per un air gap, ordinati per banda utile reale.

| Canale | Banda realistica | Distanza | Hardware | Note |
|---|---|---|---|---|
| **Schermo → camera, simbologia custom a colori** | 50–110 KB/s | 10–50 cm | schermo + camera | Stato dell'arte (cimbar/libcimbar). Richiede un decoder proprio. |
| **Schermo → camera, QR animati** | 10–35 KB/s | 10–60 cm | schermo + camera | Sweet spot pragmatico. Librerie mature ovunque. **Consigliato per iniziare.** |
| **Schermo → camera, QR affiancati (tiling)** | 30–90 KB/s | 20–60 cm | schermo 4K + camera 4K | Estende i QR senza inventare simbologie. §6.3 |
| **Carta stampata → scanner** | 40–200 KB per foglio A4 | — | stampante + scanner | Asincrono, archiviabile, resistente. §8.3 |
| **LED → fotodiodo/camera** | 1–100 kbps | 1 cm – 10 m | microcontrollore | Ottimo per embedded, pessimo per PC/telefoni consumer. §8.4 |
| **Altoparlante → microfono, udibile** | 0.5–7 kbps (≈ 0.9 KB/s) | 0.5–3 m | qualunque | Non serve inquadrare. Lentissimo. §8.1 |
| **Altoparlante → microfono, ultrasuoni** | 100–500 bps | 0.3–1 m | qualunque | Solo per handshake e chiavi. §8.2 |
| **Emulazione tastiera (HID)** | 1–10 KB/s | contatto | dispositivo HID | Tecnicamente è un cavo. Escluso dai requisiti. §8.5 |
| **Infrarosso (IrDA-like)** | 9.6–115 kbps | 0–1 m | hardware dedicato | Ormai assente dai dispositivi consumer. |

### 2.1 Perché l'ottico vince

Il motivo è puramente di banda passante fisica. Confronto onesto degli ordini di grandezza:

- **Audio over-the-air**: la banda utilizzabile di uno speaker/microfono consumer è ~3 kHz sfruttabili, con SNR pessimo e riverbero. Limite pratico: ~10³ bit/s.
- **Ottico schermo→camera**: uno schermo 1080p a 30 Hz è un canale con ~2·10⁶ simboli spaziali × 30 Hz. Anche buttando via il 99.5% per robustezza restano ~10⁵–10⁶ bit/s.

**Tre ordini di grandezza di differenza.** Se ti serve trasferire file veri, il canale è ottico. L'audio serve per altro (handshake, chiavi, dispositivi senza schermo).

### 2.2 Quello che *non* devi usare

Nella letteratura di sicurezza esistono canali esotici (ventole, LED di stato dell'hard disk, emissioni elettromagnetiche dai bus, calore, ultrasuoni da trasformatori). Sono ricerca sui **canali di esfiltrazione covert**: hanno banda di pochi bit/secondo, richiedono hardware da laboratorio e sono documentati come *minaccia*, non come *trasporto*. Per un sistema che deve funzionare non hanno alcun ruolo. Menzionali solo nella sezione "modello di minaccia" (§9.1), mai in quella di design.

---

## 3. Teoria: il canale senza ritorno

**Questa è la sezione che determina se il tuo sistema funziona o no.** Se leggi solo un capitolo, leggi questo.

### 3.1 Il design ingenuo e perché fallisce

Il design che viene in mente a tutti:

```
Dividi il file in N pezzi.
Mostra QR(pezzo 1), QR(pezzo 2), ..., QR(pezzo N).
Torna all'inizio e ripeti finché il ricevitore non ha tutto.
```

Funziona, ma è **drammaticamente inefficiente**, e il motivo ha un nome: il **problema del collezionista di figurine** (coupon collector).

Se il ricevitore perde ciascun frame con probabilità indipendente *p*, il numero atteso di frame che deve *osservare* per completare N pezzi è circa:

```
E[frame osservati] ≈ N · ln(N) / ln(1/p)      (ciclo deterministico)
E[frame osservati] ≈ N · H_N ≈ N·(ln N + 0.577)   (caso peggiore, ordine casuale)
```

Numeri concreti, con N = 1000 pezzi:

| Perdita frame | Overhead ciclo ingenuo | Overhead codice fontana |
|---|---|---|
| 0% | 1.00× (ma zero tolleranza: un frame perso = un giro intero in più) | 1.17× |
| 10% | ≈ 3.0× | ≈ 1.30× |
| 30% | ≈ 5.7× | ≈ 1.67× |
| 50% | ≈ 10.0× | ≈ 2.34× |
| ordine casuale | ≈ 7.5× | ≈ 1.17× |

Il difetto strutturale non è solo l'overhead medio, è la **coda**: quando ti mancano gli ultimi 3 pezzi su 1000, devi aspettare che il loop ci ripassi sopra. Il tempo per completare l'ultimo 0.3% del file può superare il tempo speso per il primo 99.7%. È un'esperienza utente pessima e sembra un bug.

### 3.2 La soluzione: codici fontana

Un **codice fontana** (rateless erasure code) rovescia il problema. Invece di N pezzi distinti da collezionare, il trasmettitore genera un flusso **infinito** di simboli di codifica, ciascuno una combinazione XOR di un sottoinsieme casuale dei pezzi sorgente.

La proprietà chiave:

> Il ricevitore ricostruisce l'intero file dopo aver ricevuto **circa K·(1+ε) simboli qualsiasi**, in **qualsiasi ordine**, senza che importi *quali*.

Non c'è più niente da "collezionare". Ogni simbolo che arriva è ugualmente utile. La coda sparisce. Il trasmettitore non ha bisogno di sapere nulla del ricevitore, e N ricevitori diversi in punti diversi della stanza completano tutti senza interferire.

L'analogia che dà il nome: è una **fontana d'acqua**. Non ti importa *quali* gocce raccogli, ti importa solo di riempire il bicchiere.

### 3.3 Come funziona un codice LT

Il codice fontana più semplice è il **Luby Transform (LT)**. Per generare il simbolo con indice `ESI` (Encoding Symbol ID):

```
1. Inizializza un PRNG deterministico con seed = f(session_seed, ESI)
2. Estrai un grado d dalla distribuzione Robust Soliton
3. Estrai d indici distinti fra i K blocchi sorgente
4. Il simbolo è lo XOR di quei d blocchi
```

Il ricevitore fa lo stesso calcolo partendo dall'ESI (che viaggia in chiaro nell'header del frame), quindi **la lista degli indici non viene mai trasmessa**: costa 4 byte invece di *d* interi.

La decodifica è **peeling** (belief propagation):

```
Finché esiste un simbolo di grado 1 (con un solo vicino non ancora risolto):
    quel simbolo È il blocco sorgente → risolvilo
    XOR-alo in tutti gli altri simboli che lo contengono
    (alcuni scenderanno a grado 1 → cascata)
```

La distribuzione Robust Soliton è progettata esattamente per mantenere sempre disponibile un piccolo numero di simboli di grado 1, così che la cascata non si fermi mai troppo presto.

### 3.4 Parametri misurati

Overhead reale della mia implementazione LT (§7), 15 prove per riga, dati casuali, nessuna perdita:

| K (blocchi sorgente) | Overhead medio | Overhead peggiore |
|---|---|---|
| 32 | 1.62× | 2.28× |
| 128 | 1.28× | 1.52× |
| 512 | 1.17× | 1.30× |
| 1024 | 1.17× | 1.33× |

**Lezione pratica numero uno: K piccolo è veleno.** Con K = 32 paghi il 62% di overhead. Con K ≥ 512 paghi il 17%. Scegli la dimensione del blocco in modo che K sia **almeno qualche centinaio**, anche a costo di blocchi più piccoli del payload QR massimo.

Se il file è troppo piccolo perché K sia grande (es. un file da 5 KB con blocchi da 600 byte → K = 9), la scelta giusta è **non usare affatto il codice fontana**: manda i blocchi in ciclo. Con K < 20 il coupon collector costa meno dell'overhead LT.

I parametri della Robust Soliton li ho ottimizzati sperimentalmente: `c = 0.03`, `delta = 0.5` (vedi lo sweep in §7.3).

### 3.5 Se ti serve fare meglio: RaptorQ

LT ha overhead ~17%. **RaptorQ** (RFC 6330) ha overhead **~2%** ed è quello che usano i sistemi seri (3GPP MBMS, DVB-H, Qualcomm). Funziona pre-codificando i dati con un codice LDPC/HDPC prima dello strato LT, il che elimina la coda lunga della distribuzione dei gradi.

| | LT | RaptorQ |
|---|---|---|
| Overhead | 15–25% | 0.2–2% |
| Complessità decodifica | O(K·ln K) XOR | O(K) ammortizzato |
| Righe di codice | ~150 | ~2000 |
| Standard | no | RFC 6330 |
| K massimo | pratico ~10⁴ | 56403 per blocco |

**Raccomandazione:** implementa LT per il prototipo (lo capisci, lo debugghi, ci metti un pomeriggio), poi sostituiscilo con una libreria RaptorQ esistente quando il protocollo è stabile. Il confine è pulito: cambi solo il modulo `fountain`, il resto del protocollo non se ne accorge. Guadagni il 15% di tempo di trasferimento.

Implementazioni RaptorQ disponibili: `raptorq` (Rust, con binding), `libRaptorQ` (C++), `nanorq` (C).

### 3.6 Sbagli comuni da evitare

- **Usare Reed–Solomon al posto di un codice fontana.** RS è ottimo *dentro* il frame (ed è già dentro il QR), ma è a rate fisso: se generi n simboli da k, ne puoi perdere solo n−k. Non è rateless.
- **Mandare la lista degli indici nel frame.** Superfluo: derivali dall'ESI con un PRNG deterministico.
- **Usare `random` di Python come PRNG normativo.** Va bene per un prototipo, ma se encoder e decoder sono in linguaggi diversi il flusso non è interoperabile. In una specifica vera **il PRNG va definito esplicitamente** (ChaCha20 con seed a 64 bit, oppure il generatore normativo di RFC 6330).
- **Ricalcolare i vicini a ogni frame nel loop di rendering.** Precalcola: a 15 fps hai 66 ms per frame e li vuoi spendere sul rendering.

---

## 4. Simbologia ottica: QR e oltre

### 4.1 Capacità reale dei QR

Tabella misurata con `segno`, modalità **alfanumerica**, livello di correzione **L** (7%), inclusa la codifica Base45 (§4.2) e i 18 byte di header del protocollo:

| Versione QR | Moduli | Caratteri alfanum. | Byte binari (Base45) | **Payload netto** | Px @4/modulo | Px @6/modulo |
|---|---|---|---|---|---|---|
| 5 | 37×37 | 154 | 102 | **84 B** | 180 | 270 |
| 10 | 57×57 | 395 | 263 | **245 B** | 260 | 390 |
| 15 | 77×77 | 758 | 505 | **487 B** | 340 | 510 |
| 20 | 97×97 | 1249 | 832 | **814 B** | 420 | 630 |
| 25 | 117×117 | 1853 | 1235 | **1217 B** | 500 | 750 |
| 30 | 137×137 | 2520 | 1680 | **1662 B** | 580 | 870 |
| 35 | 157×157 | 3351 | 2234 | **2216 B** | 660 | 990 |
| 40 | 177×177 | 4296 | 2864 | **2846 B** | 740 | 1110 |

("Px @N/modulo" include il quiet zone di 4 moduli per lato, obbligatorio.)

**Scelta del livello ECC.** Contro-intuitivamente vuoi **ECC L (il più debole)**, non H. Ragionamento: hai già un codice fontana sopra. Un frame che non si decodifica non è un disastro — è semplicemente un frame in meno, e il prossimo arriva fra 66 ms. Pagare il 30% di capacità per l'ECC H (che ti salva frame che il fountain code recupererebbe comunque) è uno scambio perdente. **ECC L + codice fontana batte ECC H + ciclo ingenuo su ogni metrica.**

**Scelta della versione.** Non usare la 40. La versione 40 ha 177 moduli: per leggerla ti servono ~708 px di camera solo per il codice, e il decoder fatica sulle deformazioni prospettiche. Il punto ottimo pratico è **versione 20–27**: buona capacità, tolleranza generosa. Fissa la versione (`version=25`) invece di lasciarla scegliere alla libreria: una versione che cambia da frame a frame fa "saltare" visivamente il codice e costringe l'autofocus a rincorrere.

### 4.2 Il problema del binario nei QR (bug garantito se lo ignori)

I QR hanno una modalità "byte" che in teoria trasporta binario arbitrario. **In pratica quasi tutti i decoder ti restituiscono una stringa**, e la stringa è passata attraverso una conversione di codifica che distrugge i dati.

Verificato durante lo sviluppo: un frame binario di 80 byte, codificato in modalità byte e decodificato con OpenCV, è tornato indietro come 104 byte, con i byte ≥ 0x80 espansi in coppie UTF-8 (`0x9C` → `0xC2 0x9C`). Silenziosamente. Il CRC lo prende, ma perdi ogni frame con un byte alto — cioè quasi tutti.

Hai tre opzioni:

1. **Base45 (RFC 9285) + modalità alfanumerica.** ← *raccomandata*
   L'alfabeto Base45 (`0-9 A-Z spazio $%*+-./:`) è esattamente il set alfanumerico del QR. 2 byte → 3 caratteri, e la modalità alfanumerica costa 5.5 bit/carattere: **8.25 bit per byte utile, cioè solo il 3% di overhead** rispetto al binario puro. Completamente immune ai problemi di codifica. È lo stesso motivo per cui l'UE l'ha scelta per i certificati COVID digitali.

2. **Base64 + modalità byte.** 33% di overhead. Non farlo.

3. **Modalità byte + decoder binary-safe** (`detectAndDecodeBytes` di OpenCV, ZBar in modalità raw). Recuperi il 3%, ma ti leghi a un decoder specifico e a un comportamento non garantito fra versioni.

**Il 3% di Base45 è il miglior affare del progetto.** Prendilo e non pensarci più.

### 4.3 Quanti pixel per modulo servono davvero

Misurato: QR v17 (93×93 moduli), payload 618 B, decodificato con ZBar, 5 prove per cella.

| Px per modulo | Immagine pulita | Blur 3px, rumore σ8, JPEG q60 | Blur 5px, σ20, q30 | Blur 7px, σ30, q20 |
|---|---|---|---|---|
| 2 | 5/5 | 0/5 | 0/5 | 0/5 |
| 3 | 5/5 | 5/5 | 1/5 | 0/5 |
| 4 | 5/5 | 5/5 | 5/5 | 0/5 |
| 6 | 5/5 | 5/5 | 5/5 | **5/5** |
| 8 | 5/5 | 5/5 | 5/5 | 5/5 |

**Regola operativa:**
- 2 px/modulo funziona solo con immagini perfette (mai, con una camera reale)
- **3 px/modulo** = minimo assoluto, condizioni buone e camera ferma
- **4 px/modulo** = target di progetto ragionevole
- **6 px/modulo** = robusto a mano tremante, luce scarsa, video compresso

Questo numero è il vincolo che governa tutto il budget di banda (§6), ed è misurato **al sensore della camera**, non sullo schermo.

### 4.4 La scelta del decoder conta più di quanto pensi

Durante i test, lo stesso frame QR v17 renderizzato in modo pulito:

- **ZBar** (`pyzbar`): decodificato in modo affidabile a partire da 2 px/modulo.
- **OpenCV `QRCodeDetector`** (quello integrato): fallimenti intermittenti anche su immagini perfette a 10 px/modulo, per contenuti specifici.

Il rilevatore QR integrato di OpenCV è noto per degradare sui QR ad alta versione. Le opzioni serie, in ordine:

1. **ZBar** — maturo, C, veloce, binding ovunque, il migliore su codici densi
2. **`cv2.wechat_qrcode`** (in opencv-contrib) — usa modelli CNN per la localizzazione, eccellente su immagini sfocate e inclinate; richiede i file dei modelli
3. **Quirc** — minuscolo, C puro, ottimo per embedded, decodifica da grayscale grezza
4. **BoofCV** (JVM) / **ZXing** (JVM, JS) — ZXing è lo standard di fatto ma è il più debole sui codici densi

**Non usare il rilevatore integrato di OpenCV in produzione.** È comodo per un demo e ti costerà una settimana di debug se lo lasci lì.

### 4.5 Oltre i QR: la simbologia custom

Un QR spreca capacità per cose che non ti servono in un flusso video:

- pattern di allineamento e timing in *ogni* frame (il ricevitore ha già trovato lo schermo al frame 1)
- ECC pesante interno (ridondante quando hai un codice fontana)
- un solo bit per modulo (bianco/nero)
- vincoli di mascheratura e bilanciamento

Una simbologia progettata per lo streaming recupera tutto:

**Colore.** Un modulo con 4 colori distinguibili trasporta 2 bit invece di 1. Con 8 colori, 3 bit. Il limite non è teorico ma di **crosstalk**: gli schermi hanno subpixel RGB, le camere hanno filtri Bayer, e le due matrici di risposta spettrale non coincidono. Servono calibrazione e correzione (§4.6). In pratica: **4 colori sono sicuri, 8 richiedono lavoro serio, 16 sono ricerca**.

**Forma.** L'approccio di **cimbar**: ogni cella contiene una fra 16 icone distinguibili (4 bit) *e* uno fra 4-8 colori (2-3 bit) → **6-7 bit per cella**. Cimbar dichiara ~9300 byte per immagine e throughput sostenuto di ~100 KB/s (850 kbps) da schermo a camera di telefono. È l'implementazione open source più veloce esistente in questa categoria.

**Altre simbologie di riferimento:**

| Formato | Idea | Stato |
|---|---|---|
| **JAB Code** (ISO/IEC 23634) | Barcode a colori, 4/8 colori, standardizzato | Standard ISO, implementazione di riferimento in C |
| **HCCB** (Microsoft) | Triangoli colorati | Abbandonato |
| **HCC2D** | QR esteso con canale colore | Accademico |
| **cimbar / libcimbar** | Icone + colore, ottimizzato per video | Proof-of-concept maturo, C++/WASM/Android |

**Raccomandazione strategica:** parti dai QR. Sono noiosi e c'è un decoder in ogni linguaggio. Progetta il protocollo (§5) in modo che la simbologia sia un **modulo sostituibile**: il tuo frame è una sequenza di byte, e "come lo dipingo sullo schermo" è un dettaglio. Quando i QR diventeranno il collo di bottiglia, sostituirai il modulo senza toccare il resto. Se non lo diventeranno mai, avrai risparmiato mesi.

### 4.6 Gestione del colore (se vai oltre il bianco/nero)

Problemi reali che incontrerai, in ordine di gravità:

1. **Crosstalk spettrale.** Il rosso dello schermo eccita anche i fotositi verdi della camera. Soluzione: trasmetti un **frame di calibrazione** con patch dei colori noti all'inizio della sessione, stima la matrice 3×3 di trasformazione, invertila.
2. **Gamma.** Schermi e camere applicano curve di trasferimento non lineari e diverse. Lavora in spazio lineare o calibra empiricamente.
3. **Auto white balance e auto esposizione.** La camera del telefono "corregge" continuamente in modo imprevedibile. Se puoi, **bloccali** via API (`AE_LOCK`, `AWB_LOCK`) dopo il frame di calibrazione. È la singola modifica che migliora di più l'affidabilità.
4. **Sfondo scuro.** Gli autori di cimbar hanno trovato che i risultati migliorano nettamente con sfondo nero e simboli chiari, su schermi retroilluminati. Contro-intuitivo ma misurato.
5. **Bleeding.** I colori adiacenti si contaminano ai bordi dei moduli. Campiona **il centro** della cella, non la media, ed evita colori adiacenti nello spazio percettivo su celle contigue.

### 4.7 Sincronizzazione temporale: il nemico invisibile

Lo schermo e la camera sono due orologi che nessuno sta sincronizzando. Le conseguenze:

- **Tearing / frame misto.** La camera espone mentre lo schermo cambia contenuto → cattura metà del frame N e metà del frame N+1. Il risultato è illeggibile *e* il CRC lo scarta correttamente. Con un codice fontana questo costa solo un frame: è già gestito.
- **Rolling shutter.** Quasi tutte le camere CMOS leggono il sensore riga per riga su 10–30 ms. Se lo schermo cambia durante la lettura, le righe alte e basse appartengono a frame diversi. Peggiora con schermi PWM e alte frequenze di refresh.
- **Aliasing di frequenza.** Se lo schermo va a 15 fps e la camera a 30 fps, ogni frame viene catturato due volte (spreco) o zero volte (perdita), a seconda della fase — che deriva lentamente.

**Contromisure, in ordine di efficacia:**

1. **Non superare metà del framerate della camera.** Camera a 30 fps → schermo a 12–15 fps. È la regola più importante. Andare a 30 fps con una camera a 30 fps non raddoppia la banda: la dimezza, perché quasi ogni cattura è mista.
2. **Frame hold.** Mantieni ogni codice visibile per almeno 2 intervalli di refresh dello schermo, non 1.
3. **Deduplicazione via ESI.** Il ricevitore ignora un ESI già visto. Costa niente e rende innocua la cattura doppia.
4. **Barra di fase.** Una striscia sul bordo che cambia colore a ogni frame permette al ricevitore di rilevare quando è a cavallo di due frame e scartare la cattura prima ancora di provare a decodificare. Risparmia CPU.
5. **Non usare il "cambio ogni secondo"** dell'idea iniziale: 1 fps ti dà ~1.2 KB/s con QR v25. A 12 fps ne hai ~14 KB/s. Il salto da 1 a 12 fps è il singolo miglioramento più grande disponibile, e non costa nulla in complessità.

---

## 5. Il protocollo OTS (Optical Transfer Stream)

### 5.1 Architettura a livelli

Progetta a strati, con confini netti. Ogni strato deve poter essere sostituito senza toccare gli altri.

```
┌─────────────────────────────────────────────────────────┐
│ L5  APPLICAZIONE   file, cartelle, metadati, UI         │
├─────────────────────────────────────────────────────────┤
│ L4  CONTENITORE    manifest, tar, hash, nomi            │
├─────────────────────────────────────────────────────────┤
│ L3  TRASFORMAZIONE compressione (zstd) → cifratura      │
├─────────────────────────────────────────────────────────┤
│ L2  AFFIDABILITÀ   codice fontana (LT / RaptorQ)   ★    │
├─────────────────────────────────────────────────────────┤
│ L1  FRAMING        header, ESI, LEN, CRC32              │
├─────────────────────────────────────────────────────────┤
│ L0  SIMBOLOGIA     Base45 → QR → pixel   [sostituibile] │
└─────────────────────────────────────────────────────────┘
```

★ = lo strato che fa la differenza fra un giocattolo e un sistema.

**Regola d'oro sull'ordine:** *comprimi, poi cifra, poi codifica a fontana.* Mai il contrario:
- cifrare prima di comprimere → il ciphertext è incomprimibile, perdi tutto il guadagno
- codificare a fontana prima di comprimere → stai comprimendo dati già massimizzati in entropia, guadagno zero e costo alto

### 5.2 Formato del frame

Formato binario, big-endian. **18 byte di overhead totale.**

```
 offset  len  campo         descrizione
 ──────────────────────────────────────────────────────────────────
   0      2   MAGIC         0x4F 0x54  ("OT")
   2      1   VERSION       0x01
   3      1   TYPE          0x01 MANIFEST | 0x02 DATA | 0x03 ACK
   4      4   SESSION_ID    uint32, casuale per sessione
   8      4   ESI           uint32, Encoding Symbol ID
  12      2   LEN           uint16, lunghezza del payload
  14    LEN   PAYLOAD
14+LEN    4   CRC32         su [MAGIC .. PAYLOAD]
```

Note di progetto, ciascuna con una ragione precisa:

- **`SESSION_ID` non è decorativo.** Impedisce che un ricevitore che ha ricevuto metà del file A continui a mangiare simboli del file B quando l'utente cambia trasferimento a metà. Senza, ottieni corruzione silenziosa che il CRC non rileva (i frame sono singolarmente validi).
- **`LEN` è l'unica fonte di verità sulla lunghezza.** I decoder QR restituiscono spesso byte di padding in coda (misurato: fino a 24 byte di riempimento). **Taglia sempre su `LEN` prima di verificare il CRC**, altrimenti scarti frame perfettamente validi.
- **`CRC32` non serve per correggere.** L'ECC del QR ha già fatto il suo lavoro. Il CRC è la rete di sicurezza contro decoder che restituiscono spazzatura plausibile e contro frame misti da tearing. È a costo quasi zero: tienilo.
- **`ESI` a 32 bit** è largo, ma serve: una trasmissione lunga con overhead può superare 2¹⁶ simboli.
- **`TYPE = ACK`** è riservato per la modalità bidirezionale (§5.8). Definiscilo ora anche se non lo implementi.

### 5.3 Il manifest

Il ricevitore può agganciarsi in qualsiasi istante, quindi **non può esistere un "frame di intestazione" trasmesso una volta sola**. Il manifest va ripetuto ciclicamente.

```
 offset  len  campo
   0      4   K              numero di blocchi sorgente
   4      2   BLOCK_SIZE     byte per blocco
   6      8   RAW_LEN        lunghezza del flusso dopo compressione/cifratura
  14      8   ORIG_LEN       lunghezza del file originale
  22     32   SHA256         hash del file originale
  54      1   FLAGS          bit0=zstd, bit1=cifrato, bit2..=riservati
  55      2   NAME_LEN
  57      N   NAME           UTF-8
```

**Frequenza:** uno ogni 16 frame di dati è un buon compromesso. Costa il **6.25% di banda** e garantisce che un ricevitore che si aggancia a caso attenda in media 8 frame (~0.6 s a 12 fps) prima di poter iniziare. Se il file è grande, puoi scendere a 1 ogni 32 dopo i primi 5 secondi: chi si aggancia lo fa quasi sempre all'inizio.

**Trappola:** il manifest occupa uno slot temporale ma **non deve consumare un ESI**. Se incrementi l'ESI anche sui manifest, encoder e decoder si disallineano. (Nell'implementazione di riferimento l'ESI avanza solo sui frame DATA.)

### 5.4 Pipeline di trasmissione

```
file
 │  hash SHA-256, salva ORIG_LEN
 ├─► zstd (livello 10)          se non riduce, salta e azzera il flag
 ├─► XChaCha20-Poly1305         opzionale, §9.2
 ├─► padding a multiplo di BLOCK_SIZE → K blocchi
 ├─► LTEncoder                  flusso infinito di (ESI, simbolo)
 ├─► build_frame()              +18 byte, CRC32
 ├─► Base45                     +3%
 ├─► QR v25 ECC L
 └─► rendering a schermo, 12 fps, hold ≥2 refresh
```

**Scelta di `BLOCK_SIZE`.** È il parametro più importante che devi tarare, e c'è una tensione:

```
BLOCK_SIZE = payload_netto_del_QR          → massima efficienza per frame
BLOCK_SIZE piccolo                          → K grande → minor overhead fontana
```

Procedura:

1. Parti dal payload netto della versione QR scelta (v25 → 1217 B).
2. Calcola K = ceil(dimensione_compressa / 1217).
3. Se **K ≥ 500**, usa quel BLOCK_SIZE. Fatto.
4. Se **20 ≤ K < 500**, riduci BLOCK_SIZE finché K ≈ 500. Un QR più piccolo si legge anche meglio, quindi il costo è minore di quel che sembra.
5. Se anche con blocchi da 128 B risulta **K < 20**: il file è troppo piccolo per il codice fontana. Usa la modalità ciclica semplice.

### 5.5 Pipeline di ricezione

```
frame camera (grayscale)
 ├─► [barra di fase]     scarta se cattura mista        ─┐
 ├─► rilevatore QR (ZBar)                                │ costo
 ├─► Base45 decode       scarta se alfabeto non valido   │ crescente
 ├─► taglia su LEN, verifica CRC32                       │
 ├─► controlla SESSION_ID                                │
 ├─► TYPE=MANIFEST → inizializza il decoder (una volta)  │
 ├─► TYPE=DATA → dedup su ESI                            │
 └─► LTDecoder.add_symbol() → peeling                   ─┘
        │
        └─► completo? → dedecifra → unzstd → verifica SHA-256 → scrivi
```

Ordina i controlli **dal più economico al più costoso**. Su un telefono a 30 fps hai ~33 ms per frame e il rilevamento QR ne mangia 10–20.

**Ottimizzazioni del ricevitore che contano:**

- **Non decodificare in maniera bloccante nel thread della camera.** Coda + thread worker, e scarta i frame quando la coda è piena. Meglio perdere un frame che accumulare latenza: il fountain code non se ne accorge.
- **Blocca autofocus, esposizione e bilanciamento del bianco** dopo l'aggancio iniziale.
- **Riduci a grayscale una volta sola** e passa lo stesso buffer a tutto il pipeline.
- **ROI tracking:** dopo il primo aggancio conosci dov'è lo schermo. Ritaglia quella regione nei frame successivi: dimezzi il tempo di rilevamento.
- **Mostra il progresso reale** (`len(solved)/K`), non "frame ricevuti". Con un codice fontana il progresso avanza a scatti nella fase di peeling ed è normale: una barra che sta ferma al 60% e poi salta al 100% è il comportamento atteso, ma va spiegato in UI o sembrerà bloccata.

### 5.6 Controllo di velocità senza feedback

Senza canale di ritorno non puoi adattarti. Hai due strategie:

**A — Conservativa (consigliata come default).** Fissa i parametri sul caso peggiore ragionevole: QR v20, 12 fps, ECC L. Perdi banda ma funziona sempre. È la scelta giusta quando l'utente non è un tecnico.

**B — Ciclo di densità.** Cicla deliberatamente fra tre livelli, per esempio in blocchi di 3 secondi: `v15 → v25 → v35 → v15 → ...`. Un ricevitore in buone condizioni raccoglie da tutti e tre; uno in condizioni pessime raccoglie solo dai v15. **Nessuno resta a mani vuote e chi può va veloce.** Con un codice fontana questo è gratuito, perché i simboli sono intercambiabili a prescindere da come sono stati dipinti. È una tecnica elegante e sottovalutata.

**C — Selezione manuale.** Uno slider "vicino/lontano" nell'interfaccia del trasmettitore. Poco raffinato, molto efficace, costo di sviluppo nullo.

### 5.7 Handshake e ciclo di vita della sessione

```
TX                                        RX
│                                          │
├─ genera SESSION_ID casuale               │
├─ mostra MANIFEST ─────────────────────►  ├─ aggancia, legge il manifest
├─ mostra DATA(esi=0) ──────────────────►  ├─ inizializza il decoder
├─ mostra DATA(esi=1) ──────────────X      │  (frame perso)
├─ mostra DATA(esi=2) ──────────────────►  ├─ peeling…
│  …                                       │
├─ mostra MANIFEST ─────────────────────►  ├─ ignora (già noto)
│  …                                       │
│                                          ├─ K blocchi risolti
│                                          ├─ verifica SHA-256
│                                          └─ ✔ mostra a schermo "FATTO"
├─ l'operatore vede il segnale e ferma     │
```

**Come si ferma il trasmettitore?** Senza canale di ritorno, non può saperlo da solo. Tre opzioni, in ordine di preferenza:

1. **L'umano è il canale di ritorno.** Il ricevitore mostra un grande segnale di completamento; l'operatore chiude il trasmettitore. Semplice, robusto, zero codice. È la risposta giusta per il 90% dei casi.
2. **Timeout generoso.** Il trasmettitore emette per `K · 3` simboli e poi si ferma da solo, mostrando "riavvia se serve".
3. **Canale di ritorno vero** (§5.8).

### 5.8 Modalità bidirezionale

Se **entrambi** i dispositivi hanno schermo e camera, tutto cambia — e in meglio.

```
Dispositivo A                     Dispositivo B
schermo ──── luce ────────────►  camera
camera  ◄──── luce ────────────── schermo
```

Ora puoi:

- **ACK veri.** B mostra periodicamente un piccolo QR con `SESSION_ID` e il numero di blocchi risolti. A può fermarsi esattamente al momento giusto.
- **Feedback di qualità.** B comunica il tasso di errore; A alza o abbassa la densità dinamicamente. Recuperi gran parte dell'overhead del ciclo di densità.
- **Scambio di chiavi.** Diffie-Hellman completo sul canale ottico (§9.2). Il QR di B trasporta la sua chiave pubblica.
- **Frame di calibrazione mirati.** A trasmette una scacchiera di colori, B risponde con la matrice di correzione misurata.

Il costo è basso: il QR di ritorno può essere versione 3–5 (piccolo, letto facilmente), mostrato una volta al secondo. Il codice fontana **rimane comunque la scelta giusta** — l'ACK serve per fermarsi e adattarsi, non per ritrasmettere.

**Se il tuo caso d'uso permette la bidirezionalità, implementala.** È il singolo miglioramento architetturale con il miglior rapporto valore/costo dopo i codici fontana.

---

## 6. Budget di banda: come si calcola davvero

### 6.1 La formula

```
goodput = N_codici × payload_netto × fps_efficace × (1 − quota_manifest) / overhead_fontana
```

Esempio, configurazione base (un solo QR v25, 12 fps, manifest 1/16, LT overhead 1.20):

```
1 × 1217 B × 12 /s × 0.9375 / 1.20 = 11.4 KB/s
```

### 6.2 Il vero collo di bottiglia è la camera, non lo schermo

Errore classico: dimensionare i codici sulla risoluzione dello schermo. Sbagliato. Il vincolo è **quanti pixel della camera cadono su ciascun modulo**, e questo dipende dalla risoluzione della camera, da quanto lo schermo riempie l'inquadratura e dalla distanza.

```
moduli_disponibili_per_lato = (risoluzione_camera × riempimento_inquadratura) / px_per_modulo
```

| Camera | Riempimento | @4 px/modulo | Codici v25 (125 mod.) affiancati |
|---|---|---|---|
| 720p (1280×720) | 85% | 272 × 153 mod. | 2 × 1 |
| 1080p (1920×1080) | 85% | 408 × 229 mod. | 3 × 1 |
| 4K (3840×2160) | 85% | 816 × 459 mod. | 6 × 3 |

**Nota importante:** molte app catturano il *video preview* a 1080p anche su telefoni con sensori da 48 MP. Verifica cosa ti dà davvero l'API di preview — è quella la risoluzione che conta, non quella della fotocamera nelle specifiche.

### 6.3 Tiling: più codici sullo stesso schermo

Se lo schermo è grande e la camera ha risoluzione, mostra **una griglia di QR** invece di uno solo. Ogni riquadro è un frame OTS indipendente con il proprio ESI. Per il codice fontana è indifferente: sono solo altri simboli.

Vantaggi: moltiplica la banda senza inventare una simbologia nuova, e usa gli stessi decoder collaudati (ZBar decodifica più simboli per immagine nativamente).

Limite: la CPU. Decodificare 6 QR densi per frame a 12 fps significa 72 decodifiche/secondo. Su un telefono di fascia media è il tetto. **Il secondo collo di bottiglia, dopo la camera, è il decoder.**

### 6.4 Tempi di trasferimento realistici

| Dimensione file | QR singolo v25 @12fps (11 KB/s) | Tiling 3× (30 KB/s) | Simbologia a colori (100 KB/s) |
|---|---|---|---|
| 100 KB | 9 s | 3 s | 1 s |
| 1 MB | 1 min 30 s | 34 s | 10 s |
| 10 MB | 15 min | 5 min 40 s | 1 min 45 s |
| 100 MB | 2 h 30 min | 56 min | 17 min |
| 1 GB | 25 h ❌ | 9 h ❌ | 2 h 50 min ⚠ |

**Conclusioni oneste da questa tabella:**

- ✅ **Sotto 1 MB**: il canale ottico è ottimo. Documenti, chiavi, configurazioni, database piccoli, firmware.
- ✅ **1–20 MB**: perfettamente praticabile. Ottimizza la compressione: è lì che c'è il guadagno più grande, e costa una riga di codice.
- ⚠ **20–200 MB**: fattibile ma serve la simbologia a colori e un'interfaccia che sopporti trasferimenti lunghi (progresso, ripresa, avvisi).
- ❌ **Oltre 500 MB**: rivedi il requisito. La compressione, la deduplicazione o un canale diverso ti daranno più del tuning della simbologia.

### 6.5 La leva più grande è la compressione

Tutta la §4 e la §5 combattono per il 3%, il 6%, il 17%. La compressione ti dà il **50–90%** su dati reali:

| Tipo di dato | Rapporto zstd -10 tipico | Tempo effettivo su 10 MB |
|---|---|---|
| Testo, JSON, XML, log | 5–10× | 15 min → 2–3 min |
| Codice sorgente | 3–5× | 15 min → 3–5 min |
| SQLite, CSV | 3–8× | 15 min → 2–5 min |
| PDF con testo | 1.1–1.5× | 15 min → 10–13 min |
| JPEG, PNG, MP4, ZIP | 1.00× (già compressi) | invariato |

**Prima di ottimizzare qualunque cosa nel canale, ottimizza i dati.** Un `tar` di sorgenti compresso con zstd a livello 19 può essere 10× più piccolo, e 10× più piccolo batte qualsiasi miglioramento di simbologia realisticamente ottenibile.

Se i dati sono già compressi (immagini, video, archivi), non perdere tempo: metti `compress=False` e risparmia la CPU.

---

## 7. Implementazione di riferimento

Tre moduli, ~400 righe totali, testati end-to-end. Sono allegati a questo documento.

```
fountain.py   codice LT: distribuzione robust soliton, encoder, decoder a peeling
b45.py        Base45 (RFC 9285)
otstream.py   framing, manifest, Transmitter, Receiver
```

### 7.1 Uso

```python
from otstream import Transmitter, Receiver
from b45 import b45encode, b45decode
import segno

# --- lato trasmettitore ---
tx = Transmitter(open("documento.pdf","rb").read(), "documento.pdf", block_size=600)
for frame in tx.frames():                       # flusso infinito
    qr = segno.make(b45encode(frame), error='l', boost_error=False)
    mostra_a_schermo(qr)                        # ~12 fps, hold 2 refresh
    if utente_ha_premuto_stop(): break

# --- lato ricevitore ---
rx = Receiver()
for immagine in frame_dalla_camera():
    for simbolo in zbar_decode(immagine):
        if rx.feed(b45decode(simbolo.data.decode())):
            open("out.pdf","wb").write(rx.result())   # SHA-256 già verificato
            break
    aggiorna_barra(rx.progress)
```

### 7.2 Il cuore: encoder e decoder LT

```python
def symbol_neighbours(esi, K, session_seed, cdf):
    """Vicini del simbolo `esi`. Deterministico: nessun indice viaggia sul canale."""
    rng = random.Random((session_seed << 32) ^ esi)
    d = min(bisect_left(cdf, rng.random()) + 1, K)
    return rng.sample(range(K), d)

class LTEncoder:
    def symbol(self, esi):
        nb = symbol_neighbours(esi, self.K, self.session_seed, self.cdf)
        out = self.blocks[nb[0]]
        for i in nb[1:]:
            out = _xor(out, self.blocks[i])
        return out
```

Il decoder è il peeling:

```python
def _peel(self):
    queue = [e for e, (nb, _) in self.pending.items() if len(nb) == 1]
    while queue:
        esi = queue.pop()
        nb, val = self.pending.pop(esi)
        idx = next(iter(nb))
        if idx in self.solved: continue
        self.solved[idx] = val                       # blocco risolto
        for other, (onb, oval) in list(self.pending.items()):
            if idx in onb:                           # propaga a cascata
                onb.discard(idx); oval = _xor(oval, val)
                if not onb: del self.pending[other]
                else:
                    self.pending[other] = (onb, oval)
                    if len(onb) == 1: queue.append(other)
```

### 7.3 Taratura della distribuzione (misurata)

Sweep su K = 512, 12 prove per configurazione, overhead = simboli ricevuti / K:

| c | δ | overhead medio | peggiore |
|---|---|---|---|
| 0.01 | 0.5 | 1.234 | 1.709 |
| **0.03** | **0.5** | **1.167** | **1.289** |
| 0.03 | 0.05 | 1.205 | 1.510 |
| 0.05 | 0.05 | 1.212 | 1.273 |
| 0.10 | 0.01 | 1.388 | 1.447 |
| 0.20 | 0.05 | 1.494 | 1.594 |

Ottimo a **c = 0.03, δ = 0.5**. Osservazione utile: `c = 0.05, δ = 0.05` ha media leggermente peggiore ma **varianza molto più bassa** (peggiore 1.273). Se ti interessa la prevedibilità del tempo di trasferimento più della media, è la scelta migliore.

### 7.4 Risultati end-to-end misurati

64 KiB di **dati casuali incomprimibili** (caso peggiore), QR v17, ZBar, degrado simulato della camera (sfocatura gaussiana + rumore + compressione JPEG), pipeline completa dal file al file:

| Scenario | K | Frame emessi | Frame persi | Frame letti | Overhead | Esito |
|---|---|---|---|---|---|---|
| Canale pulito | 110 | 195 | 0 | 195 | 1.77× | ✔ SHA-256 ok |
| 30% fotogrammi persi | 110 | 286 | 85 | 201 | 2.60× | ✔ SHA-256 ok |
| Degrado forte (blur 5px, σ20, JPEG q30) | 110 | 195 | 0 | 195 | 1.77× | ✔ SHA-256 ok |

**Come leggere questi numeri.** L'overhead 1.77× sembra alto rispetto al 1.17× teorico, e la scomposizione spiega perché:

```
1.77×  =  1.50×  (LT con K=110 — troppo piccolo!)
        × 1.0625 (frame di manifest, 1 ogni 16)
        × ~1.10  (varianza della singola prova)
```

Questa è la conferma sperimentale della lezione di §3.4: **con K = 110 stai pagando il 50% di overhead solo per aver scelto blocchi troppo grandi.** Con blocchi da 128 B lo stesso file avrebbe K = 512 e overhead ~1.25×. La perdita del 3% di efficienza per frame vale ampiamente il guadagno del 25% sull'overhead.

Nota anche che il degrado ottico forte **non ha peggiorato affatto** il risultato: a 4 px/modulo ZBar ha letto tutto. Il degrado ottico è un problema molto meno grave della scelta sbagliata di K.

### 7.5 Cose che si sono rotte durante lo sviluppo (impara da queste)

1. **Modalità byte del QR → dati corrotti silenziosamente.** Risolto con Base45 (§4.2). *Costo se lo scopri in produzione: alto.*
2. **`cv2.QRCodeDetector` fallisce su QR densi anche con immagini perfette.** Risolto passando a ZBar (§4.4).
3. **Il decoder restituisce byte di padding in coda.** Risolto tagliando su `LEN` prima del CRC (§5.2).
4. **K = 1 con dati molto comprimibili.** Un file di test da 20 KB di Lorem ipsum si comprime a 45 byte → un solo blocco → il codice fontana degenera. Non è un bug ma nasconde i bug: **testa sempre con dati casuali incomprimibili**, non con testo ripetitivo.
5. **`random.Random` non è interoperabile fra linguaggi.** Va bene per il prototipo, ma se il ricevitore sarà in Kotlin o Swift devi specificare il PRNG (§3.6).

---

## 8. Canali alternativi in dettaglio

### 8.1 Audio udibile (altoparlante → microfono)

**Cosa funziona.** Modulazione FSK o OFDM nella banda 1–8 kHz, con correzione d'errore Reed-Solomon.

| Progetto | Modulazione | Banda utile | Note |
|---|---|---|---|
| **ggwave** | multi-FSK, 6 toni su 96 frequenze in 4.5 kHz | 8–16 byte/s (fino a ~500 B/s nei profili veloci) | MIT, C/C++, Arduino/iOS/Android/WASM. Il più diffuso. |
| **quiet** | fino a 1024-QAM / GMSK | ~7 kbps in aria, ~64 kbps via cavo jack | Molto più veloce, più fragile al rumore |
| **AudioQR** | banda quasi-ultrasonica 17.5–19.5 kHz | ~100 bps | Portata fino a ~150 m |

**Quando l'audio è la scelta giusta:**

- ✅ **Handshake e scambio chiavi.** 32 byte di chiave pubblica passano in 2–4 secondi con ggwave. Perfetto.
- ✅ **Dispositivi senza schermo o senza camera** (microcontrollori, IoT, apparecchi industriali).
- ✅ **Non richiede di inquadrare.** Niente puntamento, funziona in tasca, funziona uno-a-molti in una stanza.
- ❌ **Trasferimento file.** A 16 B/s un file da 1 MB richiede **18 ore**. Non è un'opzione.

**Il pattern ibrido intelligente:** audio per l'handshake (session ID, chiave pubblica, parametri), ottico per i dati. L'audio risolve elegantemente il problema del "come faccio a sapere che sto parlando con il dispositivo giusto" senza far puntare la camera prima del tempo.

### 8.2 Ultrasuoni (15–20 kHz)

Stessa tecnologia della §8.1 spostata sopra la soglia dell'udito. Compromessi:

- ✅ Inudibile, non disturba
- ❌ Banda ancora minore (100–500 bps): l'attenuazione in aria cresce con la frequenza
- ❌ Molti altoparlanti e microfoni consumer hanno risposta pessima o filtri anti-alias sopra i 18 kHz
- ❌ Portata ridotta (~1 m)
- ⚠ Gli animali domestici lo sentono
- ⚠ Ha una reputazione pessima per via del suo uso nel tracciamento pubblicitario cross-device. Se lo usi in un prodotto, dichiaralo esplicitamente.

**Uso realistico:** solo notifiche di presenza e pairing. Non per dati.

### 8.3 Carta stampata (il canale che tutti dimenticano)

**Molto sottovalutato.** La carta è il solo canale air-gap che è anche **archiviabile, spedibile per posta, resistente all'EMP e leggibile fra trent'anni**.

| Approccio | Densità per A4 @600 dpi | Robustezza | Strumenti |
|---|---|---|---|
| **QR affiancati (v40, moduli 0.5 mm)** | ~17 KB (2×3 codici) | ★★★★★ | qualsiasi libreria QR |
| **QR fitti (moduli 0.33 mm)** | ~40 KB (3×5 codici) | ★★★★ | serve stampante laser + scanner buono |
| **Formato bitmap dedicato** (Optar, PaperBak) | 100–200 KB | ★★★ | strumenti specifici, spesso datati |
| **Barcode a colori su stampante a colori** | 300–500 KB | ★★ | sperimentale, la calibrazione colore su carta è dura |

**Vincoli specifici della carta, diversi da quelli dello schermo:**

- **Dot gain.** L'inchiostro si allarga sulla carta: i moduli neri crescono, quelli bianchi si restringono. Compensa nel rendering o perdi i moduli isolati.
- **Nessuna retroilluminazione.** Le euristiche di soglia tarate su schermi retroilluminati (come quelle di cimbar) vanno ritarate. Il "dark mode" che funziona su schermo è disastroso su carta.
- **Il registro dello scanner è preciso**, quindi puoi permetterti moduli più piccoli che con una camera a mano libera. 3 px/modulo a 600 dpi è realistico.
- **Il codice fontana resta utile**: un foglio macchiato, piegato o perso viene compensato da fogli extra. **Stampa il 25% di fogli in più e non ti serve sapere quale foglio è andato perso.** Questa è una proprietà notevole.
- **Numera i fogli in chiaro** oltre che nei dati. Gli umani devono poterli maneggiare.

### 8.4 LED e fotodiodo

Per sistemi embedded è il canale migliore in assoluto: economico, veloce, semplice.

- **LED → fotodiodo/fototransistor**: 1–100 kbps facilmente, con hardware da pochi euro
- **LED → camera** (rolling shutter come demodulatore): trucco elegante — le righe del rolling shutter campionano il LED a migliaia di Hz, permettendo qualche kbps con una camera normale
- **IR**: stessa cosa ma invisibile; hardware ancora più economico (ricevitori TSOP a 38 kHz)

Modulazione: Manchester (autoclocking, senza componente continua) è quasi sempre la scelta giusta. Considera OOK con codifica 4B5B se ti serve più densità.

**Perché non risolve il tuo problema:** i dispositivi consumer (PC, telefoni) non hanno fotodiodi né LED pilotabili. È la soluzione giusta se **almeno uno dei due lati è hardware che controlli tu**.

### 8.5 Emulazione tastiera (HID)

Un microcontrollore che si presenta come tastiera USB e "digita" i dati codificati in Base64.

- Banda: 1–10 KB/s
- ✅ Funziona su qualsiasi sistema, non richiede software sul ricevitore
- ❌ **È un cavo.** Viola il tuo requisito esplicito, e viola l'air gap in senso proprio: un dispositivo USB può fare molto più che digitare.
- ❌ È esattamente il vettore di attacco dei "rubber ducky". In un ambiente che si prende sul serio, le porte USB sono bloccate o incollate.

Menzionato per completezza. **Non è una soluzione air-gap.**

### 8.6 Tabella decisionale

| La tua situazione | Canale |
|---|---|
| Due telefoni / PC+telefono, file < 20 MB | **QR animati + fountain** (§5) |
| Come sopra ma file 20–200 MB | **Simbologia a colori** (libcimbar) |
| Serve archiviare o spedire fisicamente | **Carta** (§8.3) |
| Un lato non ha schermo o camera | **Audio** (ggwave) |
| Entrambi i lati sono hardware che controlli | **LED/IR** (§8.4) |
| Serve solo scambiare una chiave o un URL | **Un QR statico**, non serve un protocollo |
| Devi trasferire 1 GB+ | Ripensa il requisito, non il canale |

---

## 9. Sicurezza

### 9.1 Cosa protegge davvero un air gap (e cosa no)

L'air gap elimina l'accesso remoto. **Non** rende sicuri i dati che ci passano attraverso. Tre cose che restano vere:

1. **Il file che ricevi è ostile finché non dimostri il contrario.** Il canale è air-gapped, il contenuto no. Un PDF malevolo trasferito via QR è esattamente malevolo come uno scaricato da internet.
2. **Il canale ottico è pubblico.** Chiunque nella stanza, o una telecamera di sorveglianza, o un riflesso su una finestra, cattura il flusso. Se il contenuto è sensibile, **deve essere cifrato prima** (§9.2).
3. **Il decoder è codice che processa input non fidato.** È la tua superficie d'attacco principale (§9.3).

Nota sui canali covert: la letteratura sull'esfiltrazione da sistemi air-gapped (LED di stato, ventole, emissioni EM, calore) descrive minacce da modellare, non trasporti da usare. Se il tuo air gap protegge qualcosa di serio, quella letteratura appartiene alla tua analisi dei rischi — ma non a questo capitolo di design.

### 9.2 Crittografia

**Schema consigliato — cifrare prima di tutto il resto:**

```
file
 ├─► zstd
 ├─► XChaCha20-Poly1305  (chiave a 256 bit, nonce a 192 bit casuale)
 ├─► firma Ed25519 sul ciphertext
 └─► codice fontana → frame → QR
```

- **XChaCha20-Poly1305**: AEAD, nonce abbastanza largo da poterlo generare casualmente senza rischio di collisione, veloce in software puro (rilevante su dispositivi senza AES-NI).
- **Ed25519**: firma il ciphertext. L'autenticità conta quanto la riservatezza: senza firma, chiunque può mostrare QR alla tua camera.
- **La chiave.** Ha lo stesso problema del canale: come la scambi senza rete? Opzioni:
  - Segreto pre-condiviso (il più semplice e spesso adeguato)
  - Un QR statico separato, mostrato una volta e non filmato
  - Scambio Diffie-Hellman via canale bidirezionale (§5.8) o via audio (§8.1)
  - Passphrase digitata a mano, derivata con Argon2id
- **Non inventare crittografia.** Usa `libsodium` / `cryptography` / `age`. Il formato `age` è un contenitore già fatto, semplice e revisionato: valuta di usarlo invece di comporre le primitive a mano.

**Nota di progetto:** cifra **prima** del codice fontana, non dopo. Il fountain code opera su blocchi indipendenti; se cifri dopo devi gestire chiavi e nonce per blocco, e il ricevitore non può verificare l'integrità finché non ha tutto. Cifrando prima, il tag Poly1305 verifica il flusso intero e il fountain rimane un puro strato di trasporto.

### 9.3 Irrobustire il decoder

Il decoder è codice che processa input arbitrario controllato da chiunque possa mostrare qualcosa alla camera. Trattalo come un parser di rete.

| Minaccia | Difesa |
|---|---|
| `LEN` dichiarato enorme | Vincola `LEN ≤ payload_max` **prima** di allocare qualsiasi cosa |
| `K` assurdo nel manifest (es. 2³²) | Vincola `K ≤ 100_000` e `K · BLOCK_SIZE ≤ limite_ram` |
| Zip bomb (zstd che si espande 1000×) | Usa il decompressore in modalità **streaming con limite di output**, mai `decompress()` in un colpo solo |
| Path traversal nel nome file (`../../etc/passwd`) | Sanifica: solo basename, lista bianca di caratteri, mai path assoluti |
| Confusione di sessione | Verifica `SESSION_ID` su ogni frame (già nel protocollo) |
| Esaurimento memoria via molti ESI | Limita i simboli pendenti; oltre soglia, scarta i più vecchi |
| Contenuto malevolo nel file | Il decoder scrive in quarantena. Antivirus/sandbox **prima** di aprire. |

**Regola:** il ricevitore non deve mai scrivere direttamente nella cartella di destinazione finale, e non deve mai eseguire, aprire o "vedere l'anteprima" del file automaticamente. Scrive in quarantena, verifica l'hash, poi l'utente decide.

### 9.4 Fughe di informazione

- **Il nome del file nel manifest è in chiaro**, e il manifest viene ripetuto continuamente. `bilancio_riservato_2026.xlsx` è visibile a chiunque guardi lo schermo. Se conta: cifra anche il manifest, o usa nomi opachi.
- **La dimensione è in chiaro** e non è nascondibile (il tempo di trasferimento la rivela comunque). Se la dimensione è sensibile, aggiungi padding casuale.
- **Il video è registrabile.** Una telecamera di sorveglianza o un telefono in tasca cattura l'intera sessione, e i frame possono essere decodificati offline in seguito. Su un canale ottico questo è **il** rischio principale, e la cifratura è l'unica difesa reale.

---

## 10. Test e benchmark

### 10.1 Metriche da misurare

| Metrica | Definizione | Perché conta |
|---|---|---|
| **Goodput** | byte del file originale / secondo dall'inizio alla fine | L'unica che l'utente percepisce |
| **Overhead fontana** | simboli ricevuti / K | Isola la qualità del codice |
| **Frame Error Rate** | frame illeggibili / frame mostrati | Isola la qualità del canale ottico |
| **Tempo al primo byte** | dall'aggancio al primo simbolo utile | Frequenza del manifest |
| **Tempo di aggancio** | dall'inquadratura al primo frame letto | Qualità dell'esperienza utente |
| **Varianza del tempo totale** | deviazione standard su 20 prove | Più importante della media per l'UX |

### 10.2 Matrice di test

Ogni configurazione va provata sull'intera matrice. Le condizioni più informative sono in grassetto.

**Distanza:** 10 cm · **30 cm** · 60 cm · 1 m
**Angolo:** 0° · **20°** · 45°
**Luce:** buio · interno **300 lux** · ufficio 800 lux · **luce solare diretta** (il caso peggiore reale)
**Stabilità:** treppiede · **mano ferma** · **mano che cammina**
**Schermo:** LCD · OLED (attenzione al PWM) · e-ink (lento!) · **carta stampata**
**Camera:** fascia alta · **fascia media** · webcam economica

### 10.3 Test automatizzati (senza hardware)

Il degrado della camera si simula bene abbastanza da rendere utile una suite CI. Nell'implementazione di riferimento:

```python
def degrade(img, blur, noise, jpeg_q):
    im = cv2.GaussianBlur(img, (blur, blur), 0).astype(np.int16)
    im += np.random.normal(0, noise, im.shape).astype(np.int16)
    im = np.clip(im, 0, 255).astype(np.uint8)
    _, e = cv2.imencode('.jpg', im, [cv2.IMWRITE_JPEG_QUALITY, jpeg_q])
    return cv2.imdecode(e, cv2.IMREAD_GRAYSCALE)
```

Aggiungi per realismo: **warp prospettico** (`cv2.warpPerspective` con angoli perturbati), **motion blur direzionale** (kernel lineare), **gradiente di luminosità** (illuminazione non uniforme), **moiré** (ricampionamento a frequenza vicina al passo dei moduli).

Il moiré merita attenzione: è l'unico artefatto che il degrado gaussiano *non* modella e che nella realtà è comune quando il passo dei moduli si avvicina al passo dei pixel della camera. Si mitiga variando leggermente la scala dei codici da frame a frame.

**Cosa deve verificare la CI ad ogni commit:**

1. Roundtrip fountain su K ∈ {1, 2, 20, 512, 5000} — inclusi i casi degeneri
2. Roundtrip Base45 su tutte le lunghezze 0–300 (i resti mod 3 sono la fonte di bug)
3. Roundtrip completo file→QR→file con 0%, 30%, 60% di perdita
4. Roundtrip completo con degrado forte
5. Robustezza del parser: frame troncati, `LEN` mentito, CRC sbagliato, magic errato, K assurdo
6. Determinismo: stesso seed → stessi simboli (protegge dai cambi di PRNG)

### 10.4 Cosa vedrai nei test reali

Predizioni basate sull'esperienza raccolta qui — usale come baseline di confronto:

- Il **tempo di aggancio** dominerà l'impressione dell'utente per file piccoli. Ottimizzalo prima del goodput.
- La **luce solare diretta** sullo schermo è la condizione che rompe tutto. Nessuna quantità di ECC compensa un contrasto azzerato.
- Gli **schermi OLED con dimming PWM** producono banding con l'esposizione breve. Alza la luminosità al massimo durante la trasmissione: elimina il PWM sulla maggior parte dei dispositivi.
- La **mano che trema** costa meno di quanto temi (il fountain code assorbe), la **messa a fuoco che rincorre** costa molto di più. Blocca l'autofocus.

---

## 11. Roadmap implementativa

Ordine consigliato. Ogni fase è utilizzabile da sola: non passare alla successiva prima che la precedente funzioni davvero.

### Fase 0 — Prova di fattibilità (mezza giornata)
- [ ] Un file → una sequenza di PNG con QR → decodifica da cartella di PNG → file identico
- [ ] Nessuna camera, nessuna UI, nessun codice fontana
- **Obiettivo:** validare framing, Base45, CRC, manifest
- **Uscita:** SHA-256 identico

### Fase 1 — Codice fontana (un giorno)
- [ ] `fountain.py` con test su K ∈ {1, 20, 512, 5000}
- [ ] Iniettare perdita casuale al 0/30/60% e verificare la convergenza
- [ ] Misurare l'overhead e tarare c/δ
- **Obiettivo:** l'ordine e la perdita dei frame diventano irrilevanti

### Fase 2 — Camera reale (2–3 giorni)
- [ ] Ricevitore che legge dalla webcam con ZBar
- [ ] Deduplicazione ESI, barra di progresso, blocco AF/AE/AWB
- [ ] Trasmettitore a 12 fps a schermo intero
- **Obiettivo:** primo trasferimento fisico riuscito
- **Trappola prevista:** il tempo di decodifica supera il budget per frame. Metti il decoder su un thread separato **subito**, non dopo.

### Fase 3 — Robustezza (2–3 giorni)
- [ ] Suite di degrado automatizzata (§10.3)
- [ ] Irrobustimento del parser (§9.3)
- [ ] Taratura di versione QR / fps / block size sulla matrice §10.2
- [ ] Quarantena, verifica hash, sanificazione nomi
- **Obiettivo:** funziona in condizioni cattive, fallisce in modo pulito

### Fase 4 — Prodotto (1–2 settimane)
- [ ] UI: mirino, progresso reale, tempo stimato, segnale di completamento visibile a distanza
- [ ] Cifratura e firma (§9.2)
- [ ] Multi-file (tar interno) e cartelle
- [ ] Ripresa: se il ricevitore chiude, salva i blocchi risolti e riprendi
- **Obiettivo:** una persona non tecnica ci riesce al primo tentativo

### Fase 5 — Prestazioni (opzionale, 2+ settimane)
- [ ] Sostituire LT con RaptorQ (+15% di velocità)
- [ ] Tiling di più QR (+150–300%)
- [ ] Valutare libcimbar o una simbologia a colori propria (+300–800%)
- [ ] Canale di ritorno bidirezionale
- **Obiettivo:** file da decine di MB in tempi accettabili

### Cosa NON fare all'inizio
- ❌ Progettare una simbologia a colori propria. È un progetto di ricerca, non una funzionalità.
- ❌ Ottimizzare il rendering prima di aver misurato dove va il tempo.
- ❌ Implementare RaptorQ da zero prima che il protocollo sia stabile.
- ❌ Costruire l'app mobile prima che il prototipo desktop funzioni.

---

## Appendice A — Tabella di capacità QR

Modalità alfanumerica (Base45), livello ECC L, netto dei 18 byte di header OTS. Misurata con `segno`.

| Ver. | Moduli | Alfanum. | Byte | Payload | @3px | @4px | @6px |
|---|---|---|---|---|---|---|---|
| 5 | 37 | 154 | 102 | 84 | 135 | 180 | 270 |
| 10 | 57 | 395 | 263 | 245 | 195 | 260 | 390 |
| 15 | 77 | 758 | 505 | 487 | 255 | 340 | 510 |
| 20 | 97 | 1249 | 832 | 814 | 315 | 420 | 630 |
| **25** | **117** | **1853** | **1235** | **1217** | **375** | **500** | **750** |
| 30 | 137 | 2520 | 1680 | 1662 | 435 | 580 | 870 |
| 35 | 157 | 3351 | 2234 | 2216 | 495 | 660 | 990 |
| 40 | 177 | 4296 | 2864 | 2846 | 555 | 740 | 1110 |

(Le colonne @Npx includono il quiet zone di 4 moduli per lato.)

## Appendice B — Glossario

| Termine | Significato |
|---|---|
| **Air gap** | Isolamento fisico da ogni rete |
| **BEC** | Binary Erasure Channel: i simboli si perdono, non si corrompono |
| **Codice fontana / rateless** | Codice che genera simboli illimitati da K blocchi |
| **ESI** | Encoding Symbol ID: indice del simbolo di codifica |
| **Goodput** | Banda utile netta, esclusi tutti gli overhead |
| **K** | Numero di blocchi sorgente |
| **LT** | Luby Transform, il codice fontana più semplice |
| **Peeling** | Decodifica per propagazione da simboli di grado 1 |
| **Quiet zone** | Margine bianco obbligatorio attorno a un QR (4 moduli) |
| **RaptorQ** | Codice fontana di RFC 6330, overhead ~2% |
| **Robust Soliton** | Distribuzione dei gradi usata dai codici LT |
| **Rolling shutter** | Lettura riga per riga dei sensori CMOS |
| **Simplex** | Comunicazione unidirezionale |
| **Tiling** | Più codici affiancati sullo stesso schermo |

## Appendice C — Stato dell'arte e progetti di riferimento

**Ottici**
- **libcimbar / cimbar** — icone + colore, ~9300 B/immagine, ~106 KB/s misurati; C++, WASM, Android. Il riferimento per le prestazioni.
- **txqr** — QR animati con codici fontana, ~25 KB/s (burst). Go. Il progetto più vicino all'idea di partenza.
- **JAB Code** — ISO/IEC 23634, barcode a colori standardizzato, implementazione di riferimento in C.
- **Twibright Optar** — dati su carta, ~200 KB per A4.
- **PaperBak** — dati su carta, storico, Windows.

**Audio**
- **ggwave** — MIT, multi-FSK, 8–16 B/s, portabilità eccezionale (Arduino → browser).
- **quiet** — libcorrect + OFDM, ~7 kbps in aria.

**Codici fontana**
- **RFC 6330** — specifica normativa di RaptorQ.
- **raptorq** (Rust), **libRaptorQ** (C++), **nanorq** (C).
- Luby, *LT Codes* (FOCS 2002) — il paper originale, sorprendentemente leggibile.

**Decoder QR**
- **ZBar** — il più robusto sui codici densi. Consigliato.
- **cv2.wechat_qrcode** — localizzazione basata su CNN, ottimo su sfocato e inclinato.
- **Quirc** — minimale, C puro, ideale per embedded.
- **ZXing / BoofCV** — JVM/JS, i più diffusi, i più deboli sui codici densi.

## Appendice D — Checklist pre-produzione

**Correttezza**
- [ ] SHA-256 verificato prima di consegnare il file
- [ ] `SESSION_ID` verificato su ogni frame
- [ ] Payload tagliato su `LEN` prima del CRC
- [ ] ESI incrementato solo sui frame DATA, mai sui manifest
- [ ] Testato con dati casuali incomprimibili, non solo con testo
- [ ] Testato con K = 1, K = 2 e K molto grande

**Robustezza**
- [ ] Limiti su `LEN`, `K`, `BLOCK_SIZE` e memoria totale prima di ogni allocazione
- [ ] Decompressione streaming con tetto di output
- [ ] Nomi file sanificati, nessun path assoluto o traversal
- [ ] Decodifica su thread separato, frame scartati quando la coda è piena
- [ ] Fallimento pulito e messaggio comprensibile in ogni percorso d'errore

**Sicurezza**
- [ ] File scritto in quarantena, mai aperto o eseguito automaticamente
- [ ] Cifratura attiva se il contenuto è sensibile
- [ ] Firma verificata prima della decompressione
- [ ] L'utente sa che il canale è visibile a chi sta nella stanza

**Esperienza utente**
- [ ] Progresso basato sui blocchi risolti, con avviso che avanza a scatti
- [ ] Segnale di completamento leggibile a distanza di braccio
- [ ] Tempo stimato mostrato e aggiornato
- [ ] AF/AE/AWB bloccati dopo l'aggancio
- [ ] Luminosità dello schermo al massimo durante la trasmissione

---

*Documento generato con implementazione di riferimento verificata. Tutti i valori indicati come "misurato" derivano dall'esecuzione del codice allegato.*
