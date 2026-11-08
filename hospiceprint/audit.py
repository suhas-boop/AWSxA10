"""Tamper-evident audit log: every record carries the hash of the previous one."""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path

from .crypto import canonical, sha256_hex

GENESIS = "0" * 64


class AuditLog:
    def __init__(self, path: str | Path | None = None):
        self._records: list[dict] = []
        self._lock = threading.Lock()
        self._path = Path(path) if path else None
        if self._path:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._path.write_text("")

    def append(self, event: str, decision: str = "info", **fields) -> dict:
        with self._lock:
            prev = self._records[-1]["hash"] if self._records else GENESIS
            body = {
                "seq": len(self._records) + 1,
                "ts": round(time.time(), 3),
                "event": event,
                "decision": decision,
                **{k: v for k, v in fields.items() if v is not None},
                "prev": prev,
            }
            body["hash"] = sha256_hex(canonical(body))
            self._records.append(body)
            if self._path:
                with self._path.open("a") as fh:
                    fh.write(json.dumps(body) + "\n")
            return body

    def records(self) -> list[dict]:
        with self._lock:
            return list(self._records)

    def tail(self, n: int = 50) -> list[dict]:
        with self._lock:
            return list(self._records[-n:])

    @staticmethod
    def verify_chain(records: list[dict]) -> tuple[bool, int | None]:
        """Returns (ok, first_bad_seq)."""
        prev = GENESIS
        for rec in records:
            body = {k: v for k, v in rec.items() if k != "hash"}
            if rec.get("prev") != prev or sha256_hex(canonical(body)) != rec.get("hash"):
                return False, rec.get("seq")
            prev = rec["hash"]
        return True, None

    def verify(self) -> tuple[bool, int | None]:
        return self.verify_chain(self.records())
