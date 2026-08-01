"""
otstream.py — "Optical Transfer Stream": trasferimento file via QR animati.
Implementazione di riferimento del protocollo descritto nella bibbia tecnica.

TX:  file -> zstd -> [cifratura] -> K blocchi -> codice fontana LT -> frame -> QR
RX:  QR -> frame -> decoder LT -> [decifratura] -> unzstd -> file

Nessun canale di ritorno. Il ricevitore puo' agganciarsi in qualsiasi momento.
"""
from __future__ import annotations

import hashlib
import io
import struct
import zlib
from dataclasses import dataclass
from typing import Iterator, List, Optional, Tuple

import zstandard as zstd

from fountain import LTDecoder, LTEncoder

MAGIC = b"OT"
VERSION = 1

T_MANIFEST = 0x01
T_DATA = 0x02

HDR = struct.Struct(">2sBBIIH")  # magic, ver, type, session, esi, len  = 14 byte
HDR_LEN = HDR.size
CRC_LEN = 4
FRAME_OVERHEAD = HDR_LEN + CRC_LEN  # 18 byte


# --------------------------------------------------------------------------
# Framing
# --------------------------------------------------------------------------

def build_frame(ftype: int, session: int, esi: int, payload: bytes) -> bytes:
    head = HDR.pack(MAGIC, VERSION, ftype, session, esi, len(payload))
    body = head + payload
    return body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def parse_frame(raw: bytes) -> Optional[Tuple[int, int, int, bytes]]:
    if len(raw) < FRAME_OVERHEAD:
        return None
    magic, ver, ftype, session, esi, ln = HDR.unpack(raw[:HDR_LEN])
    if magic != MAGIC or ver != VERSION:
        return None
    if len(raw) < HDR_LEN + ln + CRC_LEN:
        return None
    # NB: si taglia sempre su LEN. I decoder QR restituiscono spesso byte di
    # padding in coda: la lunghezza dichiarata e' l'unica fonte di verita'.
    body = raw[:HDR_LEN + ln]
    crc = raw[HDR_LEN + ln:HDR_LEN + ln + CRC_LEN]
    if struct.unpack(">I", crc)[0] != (zlib.crc32(body) & 0xFFFFFFFF):
        return None
    return ftype, session, esi, body[HDR_LEN:]


# --------------------------------------------------------------------------
# Manifest
# --------------------------------------------------------------------------

MANIFEST = struct.Struct(">IHQQ32sB")  # K, block_size, raw_len, orig_len, sha256, flags


@dataclass
class Manifest:
    K: int
    block_size: int
    raw_len: int          # lunghezza del flusso compresso (input del fountain)
    orig_len: int         # lunghezza del file originale
    sha256: bytes
    flags: int            # bit0 = zstd
    name: str

    def pack(self) -> bytes:
        n = self.name.encode()
        return MANIFEST.pack(self.K, self.block_size, self.raw_len,
                             self.orig_len, self.sha256, self.flags) + \
            struct.pack(">H", len(n)) + n

    @staticmethod
    def unpack(b: bytes) -> "Manifest":
        f = MANIFEST.size
        K, bs, raw_len, orig_len, sha, flags = MANIFEST.unpack(b[:f])
        (nl,) = struct.unpack(">H", b[f:f + 2])
        name = b[f + 2:f + 2 + nl].decode()
        return Manifest(K, bs, raw_len, orig_len, sha, flags, name)


# --------------------------------------------------------------------------
# Trasmettitore
# --------------------------------------------------------------------------

class Transmitter:
    def __init__(self, data: bytes, name: str, block_size: int = 512,
                 session: int = 0x5EED1234, manifest_every: int = 16,
                 compress: bool = True):
        self.orig_len = len(data)
        self.sha = hashlib.sha256(data).digest()
        self.flags = 0
        payload = data
        if compress:
            comp = zstd.ZstdCompressor(level=10).compress(data)
            if len(comp) < len(data):
                payload, self.flags = comp, 1
        self.enc = LTEncoder(payload, block_size, session)
        self.session = session
        self.manifest_every = manifest_every
        self.manifest = Manifest(self.enc.K, block_size, len(payload),
                                 self.orig_len, self.sha, self.flags, name)

    def frames(self) -> Iterator[bytes]:
        """Flusso infinito di frame pronti da rasterizzare in QR."""
        mf = build_frame(T_MANIFEST, self.session, 0, self.manifest.pack())
        esi = 0
        i = 0
        while True:
            if i % self.manifest_every == 0:
                yield mf
            else:
                yield build_frame(T_DATA, self.session, esi, self.enc.symbol(esi))
                esi += 1
            i += 1


# --------------------------------------------------------------------------
# Ricevitore
# --------------------------------------------------------------------------

class Receiver:
    def __init__(self) -> None:
        self.manifest: Optional[Manifest] = None
        self.dec: Optional[LTDecoder] = None
        self.session: Optional[int] = None
        self.seen: set[int] = set()
        self.frames_ok = 0
        self.frames_bad = 0

    def feed(self, raw: bytes) -> bool:
        p = parse_frame(raw)
        if p is None:
            self.frames_bad += 1
            return self.done
        ftype, session, esi, payload = p
        if self.session is None:
            self.session = session
        elif session != self.session:
            return self.done          # flusso diverso: ignora
        self.frames_ok += 1

        if ftype == T_MANIFEST:
            if self.manifest is None:
                self.manifest = Manifest.unpack(payload)
                self.dec = LTDecoder(self.manifest.K, self.manifest.block_size,
                                     self.manifest.raw_len, session)
        elif ftype == T_DATA and self.dec is not None:
            if esi not in self.seen:
                self.seen.add(esi)
                self.dec.add_symbol(esi, payload)
        return self.done

    @property
    def done(self) -> bool:
        return self.dec is not None and self.dec.complete

    @property
    def progress(self) -> float:
        return self.dec.progress if self.dec else 0.0

    def result(self) -> Optional[bytes]:
        if not self.done or self.manifest is None:
            return None
        raw = self.dec.result()
        out = zstd.ZstdDecompressor().decompress(raw) if self.manifest.flags & 1 else raw
        out = out[: self.manifest.orig_len]
        if hashlib.sha256(out).digest() != self.manifest.sha256:
            raise ValueError("hash mismatch: dati corrotti")
        return out
