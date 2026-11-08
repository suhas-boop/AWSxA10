"""Workforce directory + enterprise sign-in for hospice staff.

In production this is the hospice's IdP (Entra ID, Okta, or Amazon Cognito federated
to the HR system of record). Here it is a self-contained stand-in with real scrypt
password hashing, RFC 6238 TOTP and RS256-signed ID tokens.

A staff member can only sign in -- and therefore only sponsor an AI agent -- while
their account is ACTIVE and their license (where the role needs one) is current.
"""
from __future__ import annotations

import datetime as dt
import threading
from dataclasses import dataclass, field

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

from .audit import AuditLog
from .crypto import hash_password, new_id, now, verify_password, verify_totp

ID_TOKEN_AUDIENCE = "hospiceprint"

# Interdisciplinary group roles (42 CFR 418.56) plus operations roles
ROLES = {
    "medical_director": "Hospice Medical Director (physician)",
    "rn_case_manager": "RN Case Manager",
    "hospice_aide": "Hospice Aide",
    "social_worker": "Medical Social Worker",
    "billing_specialist": "Billing Specialist",
    "privacy_officer": "HIPAA Privacy Officer",
}
LICENSED_ROLES = {"medical_director", "rn_case_manager", "social_worker"}


class AuthError(Exception):
    pass


@dataclass
class StaffMember:
    username: str
    display_name: str
    role: str
    employee_id: str
    password_hash: str = ""
    totp_secret: str = ""
    status: str = "pending"  # pending | active | suspended | terminated
    license: dict | None = None  # {"number","type","state","expires"}
    onboarding: list[dict] = field(default_factory=list)
    status_reason: str = ""
    updated: int = field(default_factory=now)

    def license_current(self, today: dt.date | None = None) -> bool:
        if self.role not in LICENSED_ROLES:
            return True
        if not self.license:
            return False
        today = today or dt.date.today()
        return dt.date.fromisoformat(self.license["expires"]) >= today

    def public(self) -> dict:
        return {
            "username": self.username, "name": self.display_name, "role": self.role,
            "role_label": ROLES.get(self.role, self.role), "employee_id": self.employee_id,
            "status": self.status, "status_reason": self.status_reason,
            "license": self.license, "onboarding": self.onboarding,
        }


class WorkforceDirectory:
    def __init__(self, issuer: str, audit: AuditLog, ttl: int = 900):
        self.issuer = issuer
        self.audit = audit
        self.ttl = ttl  # short sessions: automatic logoff, 45 CFR 164.312(a)(2)(iii)
        self._key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.kid = new_id("idpkey")
        self._staff: dict[str, StaffMember] = {}
        self._lock = threading.Lock()

    @property
    def public_key(self):
        return self._key.public_key()

    # ------------------------------------------------------------- records
    def upsert(self, member: StaffMember):
        with self._lock:
            self._staff[member.username] = member

    def get(self, username: str) -> StaffMember | None:
        with self._lock:
            return self._staff.get(username)

    def all(self) -> list[StaffMember]:
        with self._lock:
            return list(self._staff.values())

    def set_status(self, username: str, status: str, reason: str, actor: str):
        m = self.get(username)
        if not m:
            raise KeyError(username)
        m.status, m.status_reason, m.updated = status, reason, now()
        self.audit.append("directory.status", "revoke" if status in ("suspended", "terminated") else "info",
                          staff=username, status=status, reason=reason, actor=actor)

    # ------------------------------------------------------------- sign-in
    def authenticate(self, username: str, password: str, otp: str) -> str:
        m = self.get(username)
        if not m or not m.password_hash or not verify_password(password, m.password_hash):
            self.audit.append("idp.login", "deny", sponsor=username, reason="bad credentials")
            raise AuthError("invalid username or password")
        if m.status != "active":
            self.audit.append("idp.login", "deny", sponsor=username, reason=f"account {m.status}")
            raise AuthError(f"account {m.status}: {m.status_reason}")
        if not m.license_current():
            self.audit.append("idp.login", "deny", sponsor=username, reason="license expired")
            raise AuthError("professional license is not current")
        if not verify_totp(m.totp_secret, otp):
            self.audit.append("idp.login", "deny", sponsor=username, reason="MFA failed")
            raise AuthError("MFA code rejected")
        t = now()
        claims = {
            "iss": self.issuer, "aud": ID_TOKEN_AUDIENCE, "sub": m.username,
            "name": m.display_name, "role": m.role, "emp": m.employee_id,
            "amr": ["pwd", "otp"], "auth_time": t, "iat": t, "exp": t + self.ttl,
            "jti": new_id("idt"),
        }
        token = jwt.encode(claims, self._key, algorithm="RS256", headers={"kid": self.kid})
        self.audit.append("idp.login", "allow", sponsor=username, reason="pwd+otp", role=m.role)
        return token

    def verify(self, id_token: str) -> dict:
        try:
            claims = jwt.decode(id_token, self.public_key, algorithms=["RS256"],
                                audience=ID_TOKEN_AUDIENCE, issuer=self.issuer,
                                options={"require": ["exp", "iat", "sub", "aud", "iss"]})
        except jwt.PyJWTError as exc:
            raise AuthError(f"invalid ID token: {exc}") from exc
        m = self.get(claims["sub"])
        # Re-check the live record: a token issued before termination is worthless after it.
        if not m or m.status != "active":
            raise AuthError("staff member is no longer active")
        if not m.license_current():
            raise AuthError("staff member's license is not current")
        if m.role != claims.get("role"):
            raise AuthError("role changed since sign-in; sign in again")
        return claims
