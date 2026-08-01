# Implementazione di riferimento Python

Stesso protocollo di `../src/core.mjs`, **interoperabile**: il PRNG e il campionamento dei
vicini sono stati verificati identici su 48 casi, quindi si può codificare in Python e
decodificare nel browser (e viceversa).

Serve soprattutto a due cose: capire il protocollo leggendo codice più corto, e generare
sequenze di frame come immagini PNG senza aprire un browser.

```bash
pip install segno pyzbar zstandard opencv-python numpy
sudo apt install libzbar0

python3 demo.py selftest                       # verifica l'intera catena
python3 demo.py encode documento.pdf frames/   # file -> PNG con QR
python3 demo.py decode frames/ ricostruito.pdf # PNG -> file
```

**Differenze rispetto alla versione web**, da allineare se servisse compatibilità piena:
- comprime con zstd, il web usa gzip (`CompressionStream`)
- hash del file intero, il web usa il digest a blocchi
- nessun source block: un solo codice fontana su tutto il file
