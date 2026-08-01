#!/usr/bin/env python3
"""
demo.py — Dimostrazione end-to-end del protocollo OTS.

    python3 demo.py encode file.pdf out_frames/     # file  -> PNG con QR
    python3 demo.py decode out_frames/ ricostruito  # PNG   -> file
    python3 demo.py selftest                        # test completo con degrado

Dipendenze:  pip install segno pyzbar zstandard opencv-python numpy
             (pyzbar richiede la libreria di sistema libzbar0)
"""
import io, os, random, sys, time
import numpy as np, cv2, segno
from pyzbar.pyzbar import decode as zbar_decode, ZBarSymbol

from b45 import b45encode, b45decode
from otstream import Transmitter, Receiver

QR_VERSION = None      # None = automatica; fissala (es. 25) in produzione
QR_ECC = 'l'           # ECC basso: il codice fontana fa il lavoro pesante
SCALE = 4              # pixel per modulo (vedi §4.3 della bibbia)
BORDER = 4             # quiet zone obbligatoria


def render(frame: bytes):
    qr = segno.make(b45encode(frame), version=QR_VERSION,
                    error=QR_ECC, boost_error=False)
    buf = io.BytesIO()
    qr.save(buf, kind='png', scale=SCALE, border=BORDER)
    return buf.getvalue(), qr.version


def read_symbols(img):
    for s in zbar_decode(img, symbols=[ZBarSymbol.QRCODE]):
        try:
            yield b45decode(s.data.decode())
        except (ValueError, UnicodeDecodeError):
            continue


def cmd_encode(path, outdir, overhead=1.5):
    data = open(path, 'rb').read()
    tx = Transmitter(data, os.path.basename(path), block_size=600)
    n = int(tx.enc.K * overhead) + tx.enc.K // 16 + 4
    os.makedirs(outdir, exist_ok=True)
    ver = None
    for i, frame in enumerate(tx.frames()):
        if i >= n:
            break
        png, ver = render(frame)
        open(os.path.join(outdir, f"f{i:05d}.png"), 'wb').write(png)
    print(f"{len(data)} B -> K={tx.enc.K} blocchi -> {n} frame QR v{ver} in {outdir}/")
    print(f"a 12 fps la riproduzione dura {n/12:.1f} s")


def cmd_decode(indir, outpath):
    rx = Receiver()
    files = sorted(f for f in os.listdir(indir) if f.endswith('.png'))
    for i, f in enumerate(files):
        img = cv2.imread(os.path.join(indir, f), cv2.IMREAD_GRAYSCALE)
        for raw in read_symbols(img):
            if rx.feed(raw):
                out = rx.result()
                open(outpath, 'wb').write(out)
                print(f"completato dopo {i+1}/{len(files)} frame -> {outpath} "
                      f"({len(out)} B, SHA-256 verificato)")
                return
        if i % 25 == 0:
            print(f"  {i}/{len(files)} frame, {rx.progress:6.1%}", end='\r')
    print(f"\nINCOMPLETO: {rx.progress:.1%} — servono piu' frame")


def degrade(img, blur=3, noise=8, q=60):
    im = cv2.GaussianBlur(img, (blur, blur), 0).astype(np.int16)
    im += np.random.normal(0, noise, im.shape).astype(np.int16)
    im = np.clip(im, 0, 255).astype(np.uint8)
    _, e = cv2.imencode('.jpg', im, [cv2.IMWRITE_JPEG_QUALITY, q])
    return cv2.imdecode(e, cv2.IMREAD_GRAYSCALE)


def cmd_selftest():
    for label, loss, dg in [("canale pulito", 0.0, None),
                            ("30% fotogrammi persi", 0.30, None),
                            ("degrado forte", 0.0, (5, 20, 30))]:
        data = os.urandom(64 * 1024)          # incomprimibile: caso peggiore
        tx, rx = Transmitter(data, "t.bin", block_size=600), Receiver()
        t0, n, lost = time.time(), 0, 0
        for frame in tx.frames():
            n += 1
            if n > 1500:
                raise RuntimeError("nessuna convergenza")
            if random.random() < loss:
                lost += 1
                continue
            png, _ = render(frame)
            img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_GRAYSCALE)
            if dg:
                img = degrade(img, *dg)
            if any(rx.feed(raw) for raw in read_symbols(img)):
                break
        assert rx.result() == data, "MISMATCH"
        print(f"  {label:<22} K={tx.enc.K:<4} frame={n:<5} persi={lost:<4} "
              f"illeggibili={rx.frames_bad:<3} overhead={n/tx.enc.K:.2f}x "
              f"[{time.time()-t0:.1f}s]  OK")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    c = sys.argv[1]
    if c == 'encode':   cmd_encode(sys.argv[2], sys.argv[3])
    elif c == 'decode': cmd_decode(sys.argv[2], sys.argv[3])
    elif c == 'selftest':
        print("Autotest OTS (dati casuali incomprimibili):"); cmd_selftest()
    else:
        print(__doc__); sys.exit(1)
