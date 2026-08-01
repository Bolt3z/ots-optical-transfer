"""
fountain.py — Codice fontana LT (Luby Transform) con distribuzione Robust Soliton.
Implementazione di riferimento, deliberatamente compatta e leggibile.

Proprieta' chiave: il trasmettitore puo' generare un numero ILLIMITATO di simboli
di codifica da K blocchi sorgente. Il ricevitore ricostruisce i K blocchi dopo
aver ricevuto circa K*(1+eps) simboli QUALSIASI, in qualsiasi ordine.
Non serve canale di ritorno, non serve sapere quali frame sono andati persi.
"""
from __future__ import annotations
import math
import random
from bisect import bisect_left
from typing import Dict, Iterator, List, Optional, Set, Tuple

# --------------------------------------------------------------------------
# 1. Distribuzione dei gradi
# --------------------------------------------------------------------------

def robust_soliton_cdf(K: int, c: float = 0.03, delta: float = 0.5) -> List[float]:
    """CDF della distribuzione Robust Soliton per K blocchi sorgente."""
    if K == 1:
        return [1.0]
    rho = [0.0] * (K + 1)
    rho[1] = 1.0 / K
    for i in range(2, K + 1):
        rho[i] = 1.0 / (i * (i - 1))

    S = c * math.log(K / delta) * math.sqrt(K)
    kd = max(1, min(K, int(round(K / S)))) if S > 0 else K

    tau = [0.0] * (K + 1)
    for i in range(1, kd):
        tau[i] = S / (K * i)
    tau[kd] = S * math.log(S / delta) / K if S > 1 else 1.0 / K

    Z = sum(rho[1:]) + sum(tau[1:])
    cdf, acc = [], 0.0
    for i in range(1, K + 1):
        acc += (rho[i] + tau[i]) / Z
        cdf.append(acc)
    cdf[-1] = 1.0
    return cdf


M32 = 0xFFFFFFFF


def _imul(a: int, b: int) -> int:
    return (a * b) & M32


def mix_seed(session: int, esi: int) -> int:
    """NORMATIVO: identico a mixSeed() di core.mjs."""
    x = (session + _imul(esi, 0x9E3779B9)) & M32
    x ^= x >> 16; x = _imul(x, 0x21F0AAAD)
    x ^= x >> 15; x = _imul(x, 0x735A2D97)
    x ^= x >> 15
    return x


class SplitMix32:
    """NORMATIVO: identico a splitmix32() di core.mjs.

    Il PRNG della libreria standard NON e' utilizzabile: encoder e decoder
    possono essere scritti in linguaggi diversi e devono generare esattamente
    la stessa sequenza.
    """

    __slots__ = ("a",)

    def __init__(self, seed: int) -> None:
        self.a = seed & M32

    def random(self) -> float:
        self.a = (self.a + 0x9E3779B9) & M32
        t = self.a ^ (self.a >> 16); t = _imul(t, 0x21F0AAAD)
        t ^= t >> 15; t = _imul(t, 0x735A2D97)
        t ^= t >> 15
        return t / 4294967296.0


def _sample_degree(rng: SplitMix32, cdf: List[float]) -> int:
    return bisect_left(cdf, rng.random()) + 1


def symbol_neighbours(esi: int, K: int, session_seed: int,
                      cdf: List[float]) -> List[int]:
    """Vicini del simbolo `esi`. NORMATIVO: campionamento per rigetto.

    Deterministico: encoder e decoder ricavano gli stessi indici dal solo ESI,
    quindi la lista non viaggia mai sul canale.
    """
    rng = SplitMix32(mix_seed(session_seed, esi))
    d = min(_sample_degree(rng, cdf), K)
    seen: List[int] = []
    seen_set: Set[int] = set()
    while len(seen_set) < d:
        v = int(rng.random() * K) % K
        if v not in seen_set:
            seen_set.add(v); seen.append(v)
    return seen


# --------------------------------------------------------------------------
# 2. Encoder
# --------------------------------------------------------------------------

def _xor(a: bytes, b: bytes) -> bytes:
    return bytes(x ^ y for x, y in zip(a, b))


class LTEncoder:
    def __init__(self, data: bytes, block_size: int, session_seed: int = 0xC0FFEE):
        self.block_size = block_size
        self.session_seed = session_seed
        pad = (-len(data)) % block_size
        self.data_len = len(data)
        buf = data + b"\x00" * pad
        self.blocks: List[bytes] = [
            buf[i:i + block_size] for i in range(0, len(buf), block_size)
        ]
        self.K = len(self.blocks)
        self.cdf = robust_soliton_cdf(self.K)

    def symbol(self, esi: int) -> bytes:
        nb = symbol_neighbours(esi, self.K, self.session_seed, self.cdf)
        out = self.blocks[nb[0]]
        for i in nb[1:]:
            out = _xor(out, self.blocks[i])
        return out

    def stream(self, start: int = 0) -> Iterator[Tuple[int, bytes]]:
        """Flusso infinito di (esi, payload)."""
        esi = start
        while True:
            yield esi, self.symbol(esi)
            esi += 1


# --------------------------------------------------------------------------
# 3. Decoder (peeling / belief propagation)
# --------------------------------------------------------------------------

class LTDecoder:
    def __init__(self, K: int, block_size: int, data_len: int,
                 session_seed: int = 0xC0FFEE):
        self.K = K
        self.block_size = block_size
        self.data_len = data_len
        self.session_seed = session_seed
        self.cdf = robust_soliton_cdf(K)
        self.solved: Dict[int, bytes] = {}
        self.pending: Dict[int, Tuple[Set[int], bytes]] = {}  # esi -> (vicini, valore)
        self.received = 0

    @property
    def complete(self) -> bool:
        return len(self.solved) == self.K

    @property
    def progress(self) -> float:
        return len(self.solved) / self.K

    def add_symbol(self, esi: int, payload: bytes) -> bool:
        """Assorbe un simbolo. True se il file e' completo."""
        if self.complete or esi in self.pending:
            return self.complete
        self.received += 1
        nb = set(symbol_neighbours(esi, self.K, self.session_seed, self.cdf))
        val = payload
        # riduci con i blocchi gia' noti
        for i in list(nb):
            if i in self.solved:
                val = _xor(val, self.solved[i])
                nb.discard(i)
        if not nb:
            return self.complete
        self.pending[esi] = (nb, val)
        self._peel()
        return self.complete

    def _peel(self) -> None:
        queue = [e for e, (nb, _) in self.pending.items() if len(nb) == 1]
        while queue:
            esi = queue.pop()
            entry = self.pending.pop(esi, None)
            if entry is None:
                continue
            nb, val = entry
            if len(nb) != 1:
                continue
            idx = next(iter(nb))
            if idx in self.solved:
                continue
            self.solved[idx] = val
            for other, (onb, oval) in list(self.pending.items()):
                if idx in onb:
                    onb.discard(idx)
                    oval = _xor(oval, val)
                    if not onb:
                        del self.pending[other]
                    else:
                        self.pending[other] = (onb, oval)
                        if len(onb) == 1:
                            queue.append(other)

    def result(self) -> Optional[bytes]:
        if not self.complete:
            return None
        return b"".join(self.solved[i] for i in range(self.K))[: self.data_len]
