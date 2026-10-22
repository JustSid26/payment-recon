"""Demo auth: JWT with two seeded accounts. Production design: docs/08."""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import time

import jwt
from fastapi import Depends, HTTPException, Request

# A hardcoded fallback secret would let anyone forge an admin token. If the env
# var is unset, mint a random per-process secret instead (tokens simply won't
# survive a restart) — there is no known secret to sign with.
SECRET = os.environ.get("TW_JWT_SECRET")
if not SECRET:
    SECRET = secrets.token_urlsafe(48)
    print("WARNING: TW_JWT_SECRET is unset — using a random per-process secret; "
          "set TW_JWT_SECRET to keep sessions valid across restarts.")
TTL = 12 * 3600  # demo-long

def _seed_users() -> dict:
    """Static login accounts. On a production box set TW_ADMIN_EMAIL + TW_ADMIN_PASSWORD
    (and optionally TW_ADMIN_NAME): the box then has ONLY the configured admin(s) and no
    demo backdoor merchant. TW_ADMIN_EMAIL may be a comma-separated list to seed several
    admins that share TW_ADMIN_PASSWORD. With those env vars unset (the demo box), the
    seeded demo admin + Canamoney merchant are used, so nothing changes."""
    emails = [e.strip().lower() for e in os.environ.get("TW_ADMIN_EMAIL", "").split(",") if e.strip()]
    pw = os.environ.get("TW_ADMIN_PASSWORD", "")
    if emails and pw:
        name = os.environ.get("TW_ADMIN_NAME", "Admin")
        return {e: {"password": pw, "name": name, "role": "admin", "merchant_match": None}
                for e in emails}
    return {
        "admin@coreservices.io": {
            "password": "demo123", "name": "CoreServices Admin", "role": "admin",
            "merchant_match": None,
        },
        "merchant@canamoney.com": {
            "password": "demo123", "name": "Canamoney Finance", "role": "merchant",
            "merchant_match": "CANAMONEY EXCHANGE LTD.",
        },
    }


DEMO_USERS = _seed_users()


def mint(sub: str, name: str, role: str,
         merchant_uuid: str | None, merchant_id: int | None) -> str:
    """Sign a session token for any principal (demo user or self-service merchant)."""
    return jwt.encode(
        {"sub": sub, "name": name, "role": role,
         "merchant_uuid": merchant_uuid, "merchant_id": merchant_id,
         "exp": int(time.time()) + TTL},
        SECRET, algorithm="HS256",
    )


def issue(email: str, merchant_uuid: str | None, merchant_id: int | None) -> str:
    u = DEMO_USERS[email]
    return mint(email, u["name"], u["role"], merchant_uuid, merchant_id)


# --- Merchant self-service passwords ------------------------------------------
# Dependency-free password hashing: PBKDF2-HMAC-SHA256 (stdlib). Stored as
# "pbkdf2_sha256$<iterations>$<salt_hex>$<hash_hex>" so the parameters travel with
# the hash and can be tuned later without breaking existing rows.
_PBKDF2_ITERATIONS = 240_000


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${_PBKDF2_ITERATIONS}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iters, salt_hex, hash_hex = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(),
                                 bytes.fromhex(salt_hex), int(iters))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(dk.hex(), hash_hex)


def current_user(request: Request) -> dict:
    hdr = request.headers.get("authorization", "")
    if not hdr.lower().startswith("bearer "):
        raise HTTPException(401, detail={"error": {"code": "unauthorized",
                                                   "message": "missing bearer token"}})
    try:
        return jwt.decode(hdr[7:], SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(401, detail={"error": {"code": "unauthorized",
                                                   "message": "invalid or expired token"}})


def require_admin(user: dict = Depends(current_user)) -> dict:
    if user["role"] != "admin":
        raise HTTPException(403, detail={"error": {"code": "forbidden",
                                                   "message": "admin only"}})
    return user
