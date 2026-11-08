"""Real-time revocation. Checked on every gateway request and every token exchange.

Revocation targets, narrowest to broadest:
  token   - one access token (jti)
  session - one sponsored run of an agent (sid)
  agent   - every session of an agent, and blocks new exchanges
  print   - quarantines a specific build fingerprint (e.g. a compromised prompt)
  sponsor - every agent session a given human has sponsored
"""
from __future__ import annotations

import threading
from dataclasses import asdict, dataclass

from .audit import AuditLog
from .crypto import now

KINDS = ("token", "session", "agent", "print", "sponsor")


@dataclass
class Revocation:
    kind: str
    value: str
    reason: str
    by: str
    at: int


class RevocationRegistry:
    def __init__(self, audit: AuditLog):
        self.audit = audit
        self._entries: dict[tuple[str, str], Revocation] = {}
        self._lock = threading.Lock()

    def revoke(self, kind: str, value: str, reason: str, by: str) -> Revocation:
        if kind not in KINDS:
            raise ValueError(f"kind must be one of {KINDS}")
        rec = Revocation(kind, value, reason, by, now())
        with self._lock:
            self._entries[(kind, value)] = rec
        self.audit.append("revocation.issued", "revoke", target=f"{kind}:{value}",
                          reason=reason, actor=by)
        return rec

    def reinstate(self, kind: str, value: str, by: str) -> bool:
        with self._lock:
            removed = self._entries.pop((kind, value), None)
        if removed:
            self.audit.append("revocation.lifted", "info", target=f"{kind}:{value}", actor=by)
        return removed is not None

    def check(self, *, jti=None, sid=None, agent=None, print_id=None, sponsor=None) -> Revocation | None:
        probes = [("token", jti), ("session", sid), ("agent", agent),
                  ("print", print_id), ("sponsor", sponsor)]
        with self._lock:
            for key in probes:
                if key[1] and key in self._entries:
                    return self._entries[key]
        return None

    def check_claims(self, claims: dict) -> Revocation | None:
        return self.check(
            jti=claims.get("jti"), sid=claims.get("sid"),
            agent=(claims.get("act") or {}).get("sub"),
            print_id=claims.get("print"), sponsor=claims.get("sub"),
        )

    def list(self) -> list[dict]:
        with self._lock:
            return [asdict(r) for r in self._entries.values()]
