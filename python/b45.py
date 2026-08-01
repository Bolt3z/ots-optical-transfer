"""Base45 (RFC 9285): 2 byte -> 3 caratteri dell'alfabeto alfanumerico QR."""
A = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:"
R = {c: i for i, c in enumerate(A)}

def b45encode(data: bytes) -> str:
    out = []
    for i in range(0, len(data) - 1, 2):
        n = (data[i] << 8) | data[i + 1]
        n, c = divmod(n, 45); e, d = divmod(n, 45)
        out += [A[c], A[d], A[e]]
    if len(data) % 2:
        d, c = divmod(data[-1], 45)
        out += [A[c], A[d]]
    return "".join(out)

def b45decode(s: str) -> bytes:
    out = bytearray()
    for i in range(0, len(s) - 2, 3):
        n = R[s[i]] + R[s[i+1]]*45 + R[s[i+2]]*45*45
        if n > 0xFFFF: raise ValueError("base45 non valido")
        out += bytes((n >> 8, n & 0xFF))
    if len(s) % 3 == 2:
        n = R[s[-2]] + R[s[-1]]*45
        if n > 0xFF: raise ValueError("base45 non valido")
        out.append(n)
    elif len(s) % 3 != 0:
        raise ValueError("lunghezza base45 non valida")
    return bytes(out)
