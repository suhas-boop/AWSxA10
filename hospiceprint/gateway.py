"""MCP authorization gateway.

Sits in front of upstream MCP servers and speaks MCP's JSON-RPC 2.0 messages
(initialize, tools/list, tools/call). Every single request is re-checked:

  1. access token signature, audience, expiry
  2. revocation (token / session / agent / print / sponsor) - no caching
  3. proof of possession: a fresh proof signed by the agent's workload key,
     bound to this token (ath), this method and this tool, not replayed
  4. policy: tool in grant, purpose of use, patient on the sponsor's care team
     (or audited break-glass), Part 2 consent, family authorization
  5. minimum necessary: fields the sponsor's role does not need are stripped
  6. audit record with patient ID, hash-chained

tools/list is filtered, so an agent never even learns about tools it lacks.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass

import jwt

from .audit import AuditLog
from .crypto import ed25519_from_jwk, jwk_thumbprint, now, sha256_b64u
from .ehr_mcp import HospiceEHR
from .grants import GATEWAY_AUDIENCE, GrantService
from .policy import PolicyEngine
from .revocation import RevocationRegistry

PROTOCOL_VERSION = "2025-06-18"
PROOF_MAX_AGE = 30

# JSON-RPC application error codes
UNAUTHENTICATED, FORBIDDEN, REVOKED = -32001, -32003, -32004


@dataclass
class GatewayResponse:
    status: int
    body: dict


class MCPGateway:
    def __init__(self, grants: GrantService, revocations: RevocationRegistry,
                 policy: PolicyEngine, upstream: HospiceEHR, audit: AuditLog):
        self.grants = grants
        self.revocations = revocations
        self.policy = policy
        self.upstream = upstream
        self.audit = audit
        self._seen_proofs: dict[str, int] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ helpers
    @staticmethod
    def _err(status, rpc_id, code, message, data=None) -> GatewayResponse:
        err = {"code": code, "message": message}
        if data:
            err["data"] = data
        return GatewayResponse(status, {"jsonrpc": "2.0", "id": rpc_id, "error": err})

    @staticmethod
    def _ok(rpc_id, result) -> GatewayResponse:
        return GatewayResponse(200, {"jsonrpc": "2.0", "id": rpc_id, "result": result})

    def _check_proof(self, proof: str, token: str, claims: dict, method: str, tool: str | None):
        try:
            header = jwt.get_unverified_header(proof)
            jwk = header.get("jwk") or {}
            if jwk_thumbprint(jwk) != claims["cnf"]["jkt"]:
                return "proof key does not match the key this token is bound to"
            p = jwt.decode(proof, ed25519_from_jwk(jwk), algorithms=["EdDSA"],
                           options={"require": ["jti", "iat"]})
        except (jwt.PyJWTError, KeyError, ValueError) as exc:
            return f"invalid proof: {exc}"
        if p.get("ath") != sha256_b64u(token):
            return "proof is bound to a different token"
        if p.get("mth") != method or (method == "tools/call" and p.get("tool") != tool):
            return "proof is bound to a different method or tool"
        if abs(now() - int(p["iat"])) > PROOF_MAX_AGE:
            return "proof expired"
        with self._lock:
            t = now()
            self._seen_proofs = {k: v for k, v in self._seen_proofs.items() if v > t}
            if p["jti"] in self._seen_proofs:
                return "proof replayed"
            self._seen_proofs[p["jti"]] = t + PROOF_MAX_AGE * 2
        return None

    # ------------------------------------------------------------------ entry
    def handle(self, headers: dict, body: dict) -> GatewayResponse:
        headers = {k.lower(): v for k, v in headers.items()}
        rpc_id = body.get("id")
        method = body.get("method", "")
        params = body.get("params") or {}
        tool = params.get("name") if method == "tools/call" else None
        args = params.get("arguments") or {}

        # 1. token
        auth = headers.get("authorization", "")
        scheme, _, token = auth.partition(" ")
        if scheme.lower() not in ("agentprint", "bearer") or not token:
            self.audit.append("gateway.request", "deny", method=method, tool=tool,
                              reason="missing access token")
            return self._err(401, rpc_id, UNAUTHENTICATED, "missing access token")
        try:
            claims = jwt.decode(token, self.grants.public_key, algorithms=["ES256"],
                                audience=GATEWAY_AUDIENCE, issuer=self.grants.issuer,
                                options={"require": ["exp", "sid", "jti", "cnf"]})
        except jwt.PyJWTError as exc:
            self.audit.append("gateway.request", "deny", method=method, tool=tool,
                              reason=f"invalid token: {exc}")
            return self._err(401, rpc_id, UNAUTHENTICATED, f"invalid token: {exc}")

        ctx = {"agent": claims["act"]["sub"], "sponsor": claims["sub"], "sid": claims["sid"],
               "method": method, "tool": tool, "patient": args.get("patient_id"),
               "purpose": claims.get("pou")}

        # 2. revocation - checked live on every request
        rev = self.revocations.check_claims(claims)
        if rev:
            self.audit.append("gateway.request", "blocked", reason=f"{rev.kind} revoked: {rev.reason}", **ctx)
            return self._err(401, rpc_id, REVOKED, "access revoked",
                             {"kind": rev.kind, "reason": rev.reason, "by": rev.by})

        # 3. proof of possession
        problem = self._check_proof(headers.get("print-proof", ""), token, claims, method, tool)
        if problem:
            self.audit.append("gateway.request", "deny", reason=problem, **ctx)
            return self._err(401, rpc_id, UNAUTHENTICATED, problem)

        self.grants.bump(claims["sid"])

        # 4. dispatch
        if method == "initialize":
            self.audit.append("gateway.request", "allow", reason="session initialized", **ctx)
            return self._ok(rpc_id, {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": f"hospiceprint-gateway/{self.upstream.name}", "version": "1.0.0"},
            })

        if method == "tools/list":
            visible = [
                {"name": s.name, "description": s.description, "inputSchema": s.input_schema,
                 "annotations": {"risk": s.risk}}
                for s in self.policy.catalog.values() if s.name in claims["tools"]
            ]
            self.audit.append("gateway.request", "allow",
                              reason=f"listed {len(visible)} of {len(self.policy.catalog)} tools", **ctx)
            return self._ok(rpc_id, {"tools": visible})

        if method == "tools/call":
            decision = self.policy.evaluate(claims, tool, args)
            ctx["patient"] = args.get("patient_id") or ctx["patient"]
            if not decision.allow:
                self.audit.append("gateway.request", "deny", reason=decision.reason, rule=decision.rule, **ctx)
                return self._err(403, rpc_id, FORBIDDEN, decision.reason, {"rule": decision.rule})
            raw = self.upstream.call(tool, args)
            result, withheld = self.policy.minimum_necessary(claims.get("role", ""), tool, raw)
            self.audit.append("gateway.request", "break-glass" if decision.break_glass else "allow",
                              reason=decision.reason, rule=decision.rule,
                              withheld_fields=withheld or None, **ctx)
            meta = {"minimumNecessary": {"withheldFields": withheld}} if withheld else {}
            if decision.break_glass:
                meta["breakGlass"] = True
            return self._ok(rpc_id, {"content": [{"type": "text", "text": str(result)}],
                                     "structuredContent": result, "isError": "error" in result,
                                     "_meta": meta})

        self.audit.append("gateway.request", "deny", reason="method not supported", **ctx)
        return self._err(400, rpc_id, -32601, f"method '{method}' not supported")
