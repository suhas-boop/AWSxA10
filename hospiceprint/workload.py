"""Workload identity for agents and the AgenticPrint composite fingerprint.

An agent's identity is not a shared API key. It is a *print*: a hash over what
the agent actually is at runtime —

    tenant + agent id + model + system-prompt hash + toolset hash + workload key

The workload key is provisioned by the platform the agent runs on (in AWS terms,
the role/key material delivered to the pod, task or function) and never leaves
it. At every token exchange the agent signs a fresh attestation with that key,
and the grant service recomputes the print. If someone swaps the prompt, the
model, or the toolset, the print drifts and the agent is refused.
"""
from __future__ import annotations

import base64
import threading
from dataclasses import dataclass, field

import jwt

from .crypto import (
    canonical, ed25519_from_pem, ed25519_public_jwk, ed25519_to_pem,
    jwk_thumbprint, new_ed25519, new_id, now, sha256_b64u, sha256_hex,
)

STS_AUDIENCE = "hospiceprint-grant-service"
PRINT_VERSION = "ap1"


def compute_print(*, tenant: str, agent_id: str, model: str, prompt_sha256: str,
                  toolset_sha256: str, key_thumbprint: str) -> str:
    material = canonical({
        "v": PRINT_VERSION, "tenant": tenant, "agent": agent_id, "model": model,
        "prompt": prompt_sha256, "toolset": toolset_sha256, "key": key_thumbprint,
    })
    digest = sha256_hex(material)
    b32 = base64.b32encode(bytes.fromhex(digest)[:20]).decode().rstrip("=").lower()
    return f"{PRINT_VERSION}:{b32[:8]}-{b32[8:16]}-{b32[16:24]}-{b32[24:32]}"


def toolset_hash(tools: list[str]) -> str:
    return sha256_hex(canonical(sorted(tools)))


@dataclass
class AgentRegistration:
    agent_id: str
    display_name: str
    tenant: str
    model: str
    prompt_sha256: str
    toolset_sha256: str
    workload_jwk: dict
    sponsor_groups: list[str]
    max_tools: list[str]
    print_id: str = ""
    registered_at: int = field(default_factory=now)

    @property
    def key_thumbprint(self) -> str:
        return jwk_thumbprint(self.workload_jwk)


class WorkloadRegistry:
    """System of record for which agents may exist, and what each may become."""

    def __init__(self):
        self._agents: dict[str, AgentRegistration] = {}
        self._lock = threading.Lock()

    def register(self, reg: AgentRegistration) -> AgentRegistration:
        reg.print_id = compute_print(
            tenant=reg.tenant, agent_id=reg.agent_id, model=reg.model,
            prompt_sha256=reg.prompt_sha256, toolset_sha256=reg.toolset_sha256,
            key_thumbprint=reg.key_thumbprint,
        )
        with self._lock:
            self._agents[reg.agent_id] = reg
        return reg

    def get(self, agent_id: str) -> AgentRegistration | None:
        with self._lock:
            return self._agents.get(agent_id)

    def all(self) -> list[AgentRegistration]:
        with self._lock:
            return list(self._agents.values())


class AgentRuntime:
    """What lives inside the agent's workload: its key and its build manifest."""

    def __init__(self, agent_id: str, tenant: str, model: str, system_prompt: str,
                 toolset: list[str], private_key=None):
        self.agent_id = agent_id
        self.tenant = tenant
        self.model = model
        self.system_prompt = system_prompt
        self.toolset = list(toolset)
        self._key = private_key or new_ed25519()
        self.jwk = ed25519_public_jwk(self._key.public_key())

    # -- provisioning helpers -------------------------------------------------
    def private_pem(self) -> bytes:
        return ed25519_to_pem(self._key)

    @classmethod
    def from_pem(cls, pem: bytes, **kwargs) -> "AgentRuntime":
        return cls(private_key=ed25519_from_pem(pem), **kwargs)

    def manifest(self) -> dict:
        return {
            "model": self.model,
            "prompt_sha256": sha256_hex(self.system_prompt),
            "toolset_sha256": toolset_hash(self.toolset),
        }

    def registration(self, display_name, sponsor_groups, max_tools) -> AgentRegistration:
        m = self.manifest()
        return AgentRegistration(
            agent_id=self.agent_id, display_name=display_name, tenant=self.tenant,
            model=m["model"], prompt_sha256=m["prompt_sha256"],
            toolset_sha256=m["toolset_sha256"], workload_jwk=self.jwk,
            sponsor_groups=list(sponsor_groups), max_tools=list(max_tools),
        )

    # -- runtime credentials --------------------------------------------------
    def attest(self, ttl: int = 60) -> str:
        """Short-lived, signed statement: 'I am this agent, built this way, right now.'"""
        t = now()
        claims = {
            "iss": self.agent_id, "sub": self.agent_id, "aud": STS_AUDIENCE,
            "iat": t, "exp": t + ttl, "jti": new_id("att"),
            "tenant": self.tenant, "manifest": self.manifest(),
        }
        return jwt.encode(claims, self._key, algorithm="EdDSA",
                          headers={"typ": "agent-attestation+jwt"})

    def proof(self, access_token: str, method: str, tool: str | None = None) -> str:
        """Per-request proof of possession, bound to this token and this call."""
        claims = {
            "jti": new_id("pp"), "iat": now(), "mth": method,
            "tool": tool, "ath": sha256_b64u(access_token),
        }
        return jwt.encode(claims, self._key, algorithm="EdDSA",
                          headers={"typ": "print-proof+jwt", "jwk": self.jwk})
