"""Grant Exchange: (staff ID token + agent attestation) -> scoped, key-bound agent token.

The token is short-lived, delegated (sub = staff member, act.sub = agent),
least-privilege (tools = requested ∩ agent ceiling ∩ role entitlements, filtered by
purpose of use), bound to the agent's workload key (cnf.jkt), and carries the
AgenticPrint so revocation can target one agent build.
"""
from __future__ import annotations

import threading

import jwt
from cryptography.hazmat.primitives.asymmetric import ec

from .audit import AuditLog
from .crypto import ed25519_from_jwk, new_id, now
from .directory import AuthError, WorkforceDirectory
from .policy import BREAK_GLASS_ROLES, ETREAT, PATRQT, PURPOSES, ROLE_ENTITLEMENTS, ToolSpec
from .revocation import RevocationRegistry
from .workload import STS_AUDIENCE, WorkloadRegistry, compute_print

GATEWAY_AUDIENCE = "hospiceprint-mcp-gateway"


class GrantError(Exception):
    def __init__(self, message: str, code: str = "denied"):
        super().__init__(message)
        self.code = code


class GrantService:
    def __init__(self, issuer: str, directory: WorkforceDirectory, registry: WorkloadRegistry,
                 catalog: dict[str, ToolSpec], revocations: RevocationRegistry, audit: AuditLog,
                 ttl: int = 300, entitlements=ROLE_ENTITLEMENTS):
        self.issuer = issuer
        self.directory = directory
        self.registry = registry
        self.catalog = catalog
        self.revocations = revocations
        self.audit = audit
        self.ttl = ttl
        self.entitlements = entitlements
        self._key = ec.generate_private_key(ec.SECP256R1())
        self.kid = new_id("stskey")
        self._seen_attestations: dict[str, int] = {}
        self.sessions: dict[str, dict] = {}
        self.devices = None  # DeviceRegistry, set by build_system
        self._lock = threading.Lock()

    @property
    def public_key(self):
        return self._key.public_key()

    def _deny(self, msg, code, **fields):
        self.audit.append("grant.exchange", "deny", reason=msg, **fields)
        raise GrantError(msg, code)

    def exchange(self, id_token: str, attestation: str, requested_tools: list[str],
                 purpose: str = "TREAT", task: str = "", break_glass_reason: str = "") -> dict:
        # 1. Staff member: valid token, MFA, still active, license current, role unchanged
        try:
            sponsor = self.directory.verify(id_token)
        except AuthError as exc:
            self._deny(str(exc), "sponsor_unauthenticated")
        who = sponsor["sub"]
        if "otp" not in sponsor.get("amr", []):
            self._deny("staff member must have authenticated with MFA", "mfa_required", sponsor=who)
        if purpose not in PURPOSES:
            self._deny(f"unknown purpose of use '{purpose}'", "bad_purpose", sponsor=who)
        if purpose == ETREAT:
            if sponsor["role"] not in BREAK_GLASS_ROLES:
                self._deny("role may not invoke break-glass access", "break_glass_denied", sponsor=who)
            if len(break_glass_reason.strip()) < 20:
                self._deny("break-glass requires a written justification (20+ characters)",
                           "break_glass_denied", sponsor=who)

        # 2. Agent workload identity
        try:
            agent_id = jwt.decode(attestation, options={"verify_signature": False})["iss"]
        except (jwt.PyJWTError, KeyError):
            self._deny("malformed attestation", "bad_attestation", sponsor=who)
        reg = self.registry.get(agent_id)
        if reg is None:
            self._deny(f"unknown agent '{agent_id}'", "unknown_agent", sponsor=who)
        try:
            att = jwt.decode(attestation, ed25519_from_jwk(reg.workload_jwk), algorithms=["EdDSA"],
                             audience=STS_AUDIENCE, options={"require": ["exp", "iat", "jti"]})
        except jwt.PyJWTError as exc:
            self._deny(f"attestation rejected: {exc}", "bad_attestation", agent=agent_id, sponsor=who)
        with self._lock:
            t = now()
            self._seen_attestations = {k: v for k, v in self._seen_attestations.items() if v > t}
            replay = att["jti"] in self._seen_attestations
            if not replay:
                self._seen_attestations[att["jti"]] = att["exp"]
        if replay:
            self._deny("attestation replayed", "replay", agent=agent_id, sponsor=who)

        # 3. AgenticPrint: is this still the agent build that was approved?
        m = att.get("manifest", {})
        live = compute_print(tenant=att.get("tenant", ""), agent_id=agent_id, model=m.get("model", ""),
                             prompt_sha256=m.get("prompt_sha256", ""),
                             toolset_sha256=m.get("toolset_sha256", ""), key_thumbprint=reg.key_thumbprint)
        if live != reg.print_id:
            drift = [k for k, v in {"model": reg.model, "prompt_sha256": reg.prompt_sha256,
                                    "toolset_sha256": reg.toolset_sha256}.items() if m.get(k) != v]
            self._deny(f"print drift: {', '.join(drift) or 'tenant'} changed since approval",
                       "print_drift", agent=agent_id, sponsor=who, print=live)

        # 4. Revocation
        rev = self.revocations.check(agent=agent_id, print_id=reg.print_id, sponsor=who)
        if rev:
            self._deny(f"{rev.kind} revoked: {rev.reason}", "revoked", agent=agent_id, sponsor=who)

        # 5. May this role run this agent?
        if sponsor["role"] not in reg.sponsor_groups:
            self._deny(f"role {sponsor['role']} may not run this agent", "sponsor_not_permitted",
                       agent=agent_id, sponsor=who)

        # 6. Least privilege
        entitled = self.entitlements.get(sponsor["role"], set())
        granted, withheld = [], {}
        for tool in requested_tools:
            spec = self.catalog.get(tool)
            reasons = []
            if spec is None:
                reasons.append("unknown tool")
            else:
                if tool not in reg.max_tools:
                    reasons.append("outside agent's approved ceiling")
                if tool not in entitled:
                    reasons.append(f"role {sponsor['role']} not entitled")
                if purpose not in spec.purposes:
                    reasons.append(f"not permitted for purpose {purpose}")
            if reasons:
                withheld[tool] = "; ".join(reasons)
            else:
                granted.append(tool)
        if not granted:
            self._deny("no requested tool survived least-privilege checks", "no_grants",
                       agent=agent_id, sponsor=who)

        # 7. Mint
        t = now()
        sid = new_id("ses")
        claims = {
            "iss": self.issuer, "aud": GATEWAY_AUDIENCE, "sub": who, "act": {"sub": agent_id},
            "role": sponsor["role"], "tenant": reg.tenant, "tools": granted, "pou": purpose,
            "break_glass": purpose == ETREAT, "print": reg.print_id, "sid": sid,
            "cnf": {"jkt": reg.key_thumbprint}, "task": task,
            "iat": t, "exp": t + self.ttl, "jti": new_id("tok"),
        }
        token = jwt.encode(claims, self._key, algorithm="ES256",
                           headers={"kid": self.kid, "typ": "agent-access+jwt"})
        with self._lock:
            self.sessions[sid] = {
                "sid": sid, "agent": agent_id, "agent_name": reg.display_name, "sponsor": who,
                "sponsor_name": sponsor.get("name"), "role": sponsor["role"], "print": reg.print_id,
                "tools": granted, "withheld": withheld, "purpose": purpose, "task": task,
                "break_glass": purpose == ETREAT, "break_glass_reason": break_glass_reason or None,
                "issued": t, "exp": t + self.ttl, "calls": 0,
            }
        self.audit.append("grant.exchange", "break-glass" if purpose == ETREAT else "allow",
                          agent=agent_id, sponsor=who, sid=sid, purpose=purpose, granted=granted,
                          withheld=withheld, reason=break_glass_reason or None)
        return {"access_token": token, "token_type": "AgentPrint", "expires_in": self.ttl, "sid": sid,
                "print": reg.print_id, "purpose": purpose, "granted_tools": granted, "withheld_tools": withheld}

    # ------------------------------------------------------------------ companion devices
    def _verify_workload(self, attestation: str, who: str | None = None):
        try:
            agent_id = jwt.decode(attestation, options={"verify_signature": False})["iss"]
        except (jwt.PyJWTError, KeyError):
            self._deny("malformed attestation", "bad_attestation", sponsor=who)
        reg = self.registry.get(agent_id)
        if reg is None:
            self._deny(f"unknown agent '{agent_id}'", "unknown_agent", sponsor=who)
        try:
            att = jwt.decode(attestation, ed25519_from_jwk(reg.workload_jwk), algorithms=["EdDSA"],
                             audience=STS_AUDIENCE, options={"require": ["exp", "iat", "jti"]})
        except jwt.PyJWTError as exc:
            self._deny(f"attestation rejected: {exc}", "bad_attestation", agent=agent_id, sponsor=who)
        with self._lock:
            t = now()
            self._seen_attestations = {k: v for k, v in self._seen_attestations.items() if v > t}
            replay = att["jti"] in self._seen_attestations
            if not replay:
                self._seen_attestations[att["jti"]] = att["exp"]
        if replay:
            self._deny("attestation replayed", "replay", agent=agent_id, sponsor=who)
        m = att.get("manifest", {})
        live = compute_print(tenant=att.get("tenant", ""), agent_id=agent_id, model=m.get("model", ""),
                             prompt_sha256=m.get("prompt_sha256", ""),
                             toolset_sha256=m.get("toolset_sha256", ""), key_thumbprint=reg.key_thumbprint)
        if live != reg.print_id:
            self._deny("print drift: companion build changed since pairing", "print_drift",
                       agent=agent_id, sponsor=who, print=live)
        return reg

    def exchange_companion(self, attestation: str, pin: str, requested_tools: list[str]) -> dict:
        """Device attestation (something the device has) + PIN (something the patient knows)
        -> a token bound to the ONE patient this device was paired to."""
        if self.devices is None:
            self._deny("companion devices not enabled", "not_enabled")
        reg = self._verify_workload(attestation)
        dev = self.devices.by_agent(reg.agent_id)
        if dev is None:
            self._deny("workload is not a paired companion device", "not_a_device", agent=reg.agent_id)
        subject = f"patient:{dev.patient_id}"
        rev = self.revocations.check(agent=reg.agent_id, print_id=reg.print_id, sponsor=subject)
        if rev:
            self._deny(f"{rev.kind} revoked: {rev.reason}", "revoked", agent=reg.agent_id, sponsor=subject,
                       patient=dev.patient_id)
        if dev.status != "active":
            self._deny(f"device is {dev.status}", "device_inactive", agent=reg.agent_id, patient=dev.patient_id)
        if not self.devices.check_pin(dev, pin):
            self._deny("PIN incorrect" if dev.status == "active" else f"device {dev.status}",
                       "bad_pin", agent=reg.agent_id, patient=dev.patient_id)
        granted, withheld = [], {}
        for tool in requested_tools:
            spec = self.catalog.get(tool)
            if spec is None:
                withheld[tool] = "unknown tool"
            elif tool not in reg.max_tools:
                withheld[tool] = "outside companion ceiling"
            elif PATRQT not in spec.purposes:
                withheld[tool] = "not a patient-facing tool"
            else:
                granted.append(tool)
        if not granted:
            self._deny("no requested tool is available to a companion device", "no_grants", agent=reg.agent_id)
        t = now()
        sid = new_id("ses")
        claims = {
            "iss": self.issuer, "aud": GATEWAY_AUDIENCE, "sub": subject, "act": {"sub": reg.agent_id},
            "role": "patient_companion", "patient_binding": dev.patient_id, "tenant": reg.tenant,
            "tools": granted, "pou": PATRQT, "break_glass": False, "print": reg.print_id, "sid": sid,
            "cnf": {"jkt": reg.key_thumbprint}, "task": "companion session",
            "iat": t, "exp": t + self.ttl, "jti": new_id("tok"),
        }
        token = jwt.encode(claims, self._key, algorithm="ES256",
                           headers={"kid": self.kid, "typ": "agent-access+jwt"})
        with self._lock:
            self.sessions[sid] = {
                "sid": sid, "agent": reg.agent_id, "agent_name": reg.display_name, "sponsor": subject,
                "sponsor_name": f"Patient {dev.patient_id} (device PIN)", "role": "patient_companion",
                "print": reg.print_id, "tools": granted, "withheld": withheld, "purpose": PATRQT,
                "task": f"bound to {dev.patient_id}", "break_glass": False, "break_glass_reason": None,
                "issued": t, "exp": t + self.ttl, "calls": 0, "patient_binding": dev.patient_id,
            }
        self.audit.append("grant.companion", "allow", agent=reg.agent_id, sponsor=subject, sid=sid,
                          patient=dev.patient_id, purpose=PATRQT, granted=granted)
        return {"access_token": token, "token_type": "AgentPrint", "expires_in": self.ttl, "sid": sid,
                "print": reg.print_id, "purpose": PATRQT, "patient_binding": dev.patient_id,
                "granted_tools": granted, "withheld_tools": withheld}

    def bump(self, sid: str):
        with self._lock:
            if sid in self.sessions:
                self.sessions[sid]["calls"] += 1
