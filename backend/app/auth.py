"""Demo auth: JWT with two seeded accounts. Production design: docs/08."""
from __future__ import annotations

import os
import time

import jwt
from fastapi import Depends, HTTPException, Request

SECRET = os.environ.get("TW_JWT_SECRET", "demo-secret-rotate-me")
TTL = 12 * 3600  # demo-long

DEMO_USERS = {
    "admin@transactworld.com": {
        "password": "demo123", "name": "TW Admin", "role": "admin",
        "merchant_match": None,
    },
    "merchant@canamoney.com": {
        "password": "demo123", "name": "Canamoney Finance", "role": "merchant",
        "merchant_match": "CANAMONEY EXCHANGE LTD.",
    },
}


def issue(email: str, merchant_uuid: str | None, merchant_id: int | None) -> str:
    u = DEMO_USERS[email]
    return jwt.encode(
        {"sub": email, "name": u["name"], "role": u["role"],
         "merchant_uuid": merchant_uuid, "merchant_id": merchant_id,
         "exp": int(time.time()) + TTL},
        SECRET, algorithm="HS256",
    )


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
