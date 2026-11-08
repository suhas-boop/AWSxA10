"""Agent-side SDK: how an agent obtains a grant and calls MCP tools through the gateway.

Transport-agnostic: pass an in-process `System` or a base URL for HTTP.
"""
from __future__ import annotations

import itertools

from .workload import AgentRuntime


class AccessRevoked(Exception):
    pass


class ToolDenied(Exception):
    pass


class GatewayAuthError(Exception):
    pass


class GrantDenied(Exception):
    pass


class AgentClient:
    def __init__(self, runtime: AgentRuntime, *, system=None, base_url: str | None = None):
        self.runtime = runtime
        self.system = system
        self.base_url = base_url.rstrip("/") if base_url else None
        self.token: str | None = None
        self.grant: dict | None = None
        self._ids = itertools.count(1)
        if self.base_url:
            import requests
            self._http = requests.Session()

    # ----------------------------------------------------------------- grant
    def obtain_grant(self, id_token: str, tools: list[str], purpose: str = "TREAT", task: str = "",
                     break_glass_reason: str = "") -> dict:
        attestation = self.runtime.attest()
        if self.system:
            from .grants import GrantError
            try:
                self.grant = self.system.grants.exchange(id_token, attestation, tools, purpose, task, break_glass_reason)
            except GrantError as exc:
                raise GrantDenied(f"{exc.code}: {exc}") from exc
        else:
            r = self._http.post(f"{self.base_url}/grants/exchange", json={
                "subject_token": id_token, "attestation": attestation,
                "requested_tools": tools, "purpose": purpose, "task": task,
                "break_glass_reason": break_glass_reason})
            if r.status_code != 200:
                err = r.json()
                raise GrantDenied(f"{err.get('code')}: {err.get('error')}")
            self.grant = r.json()
        self.token = self.grant["access_token"]
        return self.grant

    def obtain_companion_grant(self, pin: str, tools: list[str]) -> dict:
        """Companion devices: device attestation + the patient's PIN. No staff credentials involved."""
        attestation = self.runtime.attest()
        if self.system:
            from .grants import GrantError
            try:
                self.grant = self.system.grants.exchange_companion(attestation, pin, tools)
            except GrantError as exc:
                raise GrantDenied(f"{exc.code}: {exc}") from exc
        else:
            r = self._http.post(f"{self.base_url}/grants/companion", json={
                "attestation": attestation, "pin": pin, "requested_tools": tools})
            if r.status_code != 200:
                err = r.json()
                raise GrantDenied(f"{err.get('code')}: {err.get('error')}")
            self.grant = r.json()
        self.token = self.grant["access_token"]
        return self.grant

    # ----------------------------------------------------------------- MCP
    def _rpc(self, method: str, params: dict | None = None, token: str | None = None,
             proof: str | None = None) -> dict:
        token = token or self.token
        tool = (params or {}).get("name") if method == "tools/call" else None
        headers = {
            "Authorization": f"AgentPrint {token}",
            "Print-Proof": proof if proof is not None else self.runtime.proof(token, method, tool),
        }
        body = {"jsonrpc": "2.0", "id": next(self._ids), "method": method}
        if params is not None:
            body["params"] = params
        if self.system:
            resp = self.system.gateway.handle(headers, body)
            status, payload = resp.status, resp.body
        else:
            r = self._http.post(f"{self.base_url}/mcp", json=body, headers=headers)
            status, payload = r.status_code, r.json()
        if "error" in payload:
            err = payload["error"]
            if err["code"] == -32004:
                raise AccessRevoked(f"{err['data']['kind']} revoked by {err['data']['by']}: "
                                    f"{err['data']['reason']}")
            if err["code"] == -32003:
                raise ToolDenied(err["message"])
            raise GatewayAuthError(f"HTTP {status}: {err['message']}")
        return payload["result"]

    def initialize(self) -> dict:
        return self._rpc("initialize", {"protocolVersion": "2025-06-18",
                                        "clientInfo": {"name": self.runtime.agent_id}})

    def list_tools(self) -> list[dict]:
        return self._rpc("tools/list", {})["tools"]

    def call_tool(self, name: str, arguments: dict) -> dict:
        return self._rpc("tools/call", {"name": name, "arguments": arguments})["structuredContent"]

    def call_tool_full(self, name: str, arguments: dict) -> dict:
        """Returns the whole MCP result, including _meta (withheld fields, break-glass flag)."""
        return self._rpc("tools/call", {"name": name, "arguments": arguments})
