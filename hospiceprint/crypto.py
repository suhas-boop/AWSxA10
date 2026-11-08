"""Small crypto + encoding helpers shared across AgenticPrint components."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
import uuid

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519


def now() -> int:
    return int(time.time())


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def b64u_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def canonical(obj) -> bytes:
    """Deterministic JSON encoding used for hashing."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()


def sha256_hex(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode()
    return hashlib.sha256(data).hexdigest()


def sha256_b64u(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode()
    return b64u(hashlib.sha256(data).digest())


# --- Ed25519 workload keys --------------------------------------------------

def new_ed25519() -> ed25519.Ed25519PrivateKey:
    return ed25519.Ed25519PrivateKey.generate()


def ed25519_public_jwk(pub: ed25519.Ed25519PublicKey) -> dict:
    raw = pub.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return {"kty": "OKP", "crv": "Ed25519", "x": b64u(raw)}


def ed25519_from_jwk(jwk: dict) -> ed25519.Ed25519PublicKey:
    if jwk.get("kty") != "OKP" or jwk.get("crv") != "Ed25519":
        raise ValueError("unsupported key type")
    return ed25519.Ed25519PublicKey.from_public_bytes(b64u_decode(jwk["x"]))


def jwk_thumbprint(jwk: dict) -> str:
    """RFC 7638 thumbprint (OKP members: crv, kty, x)."""
    members = {k: jwk[k] for k in ("crv", "kty", "x")}
    return sha256_b64u(canonical(members))


def ed25519_to_pem(key: ed25519.Ed25519PrivateKey) -> bytes:
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )


def ed25519_from_pem(pem: bytes) -> ed25519.Ed25519PrivateKey:
    key = serialization.load_pem_private_key(pem, password=None)
    if not isinstance(key, ed25519.Ed25519PrivateKey):
        raise ValueError("not an Ed25519 key")
    return key


# --- Passwords and TOTP (RFC 6238) ------------------------------------------

def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
    return f"scrypt${b64u(salt)}${b64u(digest)}"


def verify_password(password: str, stored: str) -> bool:
    _, salt, digest = stored.split("$")
    candidate = hash_password(password, b64u_decode(salt)).split("$")[2]
    return hmac.compare_digest(candidate, digest)


def new_totp_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode()


def totp(secret_b32: str, at: float | None = None, step: int = 30, digits: int = 6) -> str:
    key = base64.b32decode(secret_b32)
    counter = int((at if at is not None else time.time()) // step)
    mac = hmac.new(key, counter.to_bytes(8, "big"), hashlib.sha1).digest()
    offset = mac[-1] & 0x0F
    code = (int.from_bytes(mac[offset:offset + 4], "big") & 0x7FFFFFFF) % (10 ** digits)
    return str(code).zfill(digits)


def verify_totp(secret_b32: str, code: str, window: int = 1) -> bool:
    t = time.time()
    return any(hmac.compare_digest(totp(secret_b32, t + i * 30), code) for i in range(-window, window + 1))
