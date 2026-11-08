"""HTTP service: staff sign-in, grant exchange, MCP gateway, and the admin console.

    python -m hospiceprint.app          # prints http://127.0.0.1:8080/#key=...
"""
from __future__ import annotations

import argparse
import json
import secrets
import threading
from pathlib import Path

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse
from starlette.routing import Route

from .agent import AgentClient
from .crypto import now, totp
from .directory import AuthError
from .grants import GrantError
from .devices import DeviceError
from .system import (AGENT_ID, AGENT_MODEL, AGENT_PROMPT, AGENT_TOOLSET, CANDIDATES, DEMO_PASSWORD, SEED_DEVICE,
                     TENANT, build_system, pair_device)
from .task import run_visit_prep
from .agent import AccessRevoked, GatewayAuthError, GrantDenied, ToolDenied
from .llm_agent import (COMPANION_TOOLS_REQUESTED, DEFAULT_COMPANION_INSTRUCTION, DEFAULT_INSTRUCTION, DEFAULT_MODEL,
                        DEFAULT_REGION, ReplayLLM, companion_replay, make_llm, run_companion_agent, run_llm_agent)

STATE_DIR = Path(".hospiceprint")


def _has_boto3() -> bool:
    try:
        import boto3  # noqa: F401
        return True
    except ImportError:
        return False
DASHBOARD = Path(__file__).with_name("dashboard.html")


def create_app(state_dir: Path = STATE_DIR, token_ttl: int = 300):
    state_dir.mkdir(exist_ok=True)
    system = build_system(audit_path=state_dir / "audit.jsonl", token_ttl=token_ttl)
    admin_key = secrets.token_urlsafe(18)

    # Demo-only provisioning so a separate agent process can run (see README risks).
    (state_dir / "agent-key.pem").write_bytes(system.agent_runtime.private_pem())
    (state_dir / "agent-manifest.json").write_text(json.dumps({
        "agent_id": AGENT_ID, "tenant": TENANT, "model": AGENT_MODEL,
        "system_prompt": AGENT_PROMPT, "toolset": AGENT_TOOLSET}, indent=2))

    def write_users():
        (state_dir / "demo-users.json").write_text(json.dumps({
            u: {"password": DEMO_PASSWORD.get(u, ""), "totp_secret": s}
            for u, s in system.onboarding.totp_secrets.items()}, indent=2))
    write_users()
    (state_dir / "admin-key").write_text(admin_key)

    task_state = {"running": False, "events": [], "sponsor": None}
    comp_state = {"running": False, "events": [], "device_id": None}
    lock = threading.Lock()

    def is_admin(req: Request) -> bool:
        return secrets.compare_digest(req.headers.get("x-admin-key", ""), admin_key)

    def guard(fn):
        async def wrapped(req: Request):
            if not is_admin(req):
                return JSONResponse({"error": "admin key required"}, status_code=401)
            return await fn(req)
        return wrapped

    async def body(req: Request) -> dict:
        raw = await req.body()
        return json.loads(raw) if raw else {}

    # ------------------------------------------------------------ public API
    async def dashboard(_):
        return HTMLResponse(DASHBOARD.read_text())

    async def login(req):
        b = await body(req)
        try:
            tok = system.directory.authenticate(b.get("username", ""), b.get("password", ""), b.get("otp", ""))
        except AuthError as exc:
            return JSONResponse({"error": str(exc)}, status_code=401)
        return JSONResponse({"id_token": tok, "token_type": "Bearer"})

    async def exchange(req):
        b = await body(req)
        try:
            out = system.grants.exchange(b.get("subject_token", ""), b.get("attestation", ""),
                                         b.get("requested_tools", []), b.get("purpose", "TREAT"),
                                         b.get("task", ""), b.get("break_glass_reason", ""))
        except GrantError as exc:
            return JSONResponse({"error": str(exc), "code": exc.code}, status_code=403)
        return JSONResponse(out)

    async def companion_exchange(req):
        b = await body(req)
        try:
            out = system.grants.exchange_companion(b.get("attestation", ""), str(b.get("pin", "")),
                                                   b.get("requested_tools", []))
        except GrantError as exc:
            return JSONResponse({"error": str(exc), "code": exc.code}, status_code=403)
        return JSONResponse(out)

    async def mcp(req):
        try:
            b = await req.json()
        except json.JSONDecodeError:
            return JSONResponse({"jsonrpc": "2.0", "id": None,
                                 "error": {"code": -32700, "message": "parse error"}}, status_code=400)
        resp = system.gateway.handle(dict(req.headers), b)
        return JSONResponse(resp.body, status_code=resp.status)

    # ------------------------------------------------------------ admin API
    async def state(req):
        records = system.audit.records()
        ok, bad = system.audit.verify_chain(records)
        sessions = []
        for s in sorted(system.grants.sessions.values(), key=lambda s: -s["issued"]):
            rev = system.revocations.check(sid=s["sid"], agent=s["agent"], print_id=s["print"], sponsor=s["sponsor"])
            sessions.append({**s, "revoked": rev.__dict__ if rev else None, "expired": s["exp"] < now()})
        staff = []
        for m in system.directory.all():
            p = m.public()
            p["caseload"] = system.care_teams.caseload(m.username)
            staff.append(p)
        with lock:
            task = {"running": task_state["running"], "events": list(task_state["events"]),
                    "sponsor": task_state["sponsor"]}
        reg = system.registry.get(AGENT_ID)
        return JSONResponse({
            "tenant": TENANT,
            "agent": {"agent_id": reg.agent_id, "name": reg.display_name, "print": reg.print_id,
                      "model": reg.model, "ceiling": reg.max_tools, "sponsor_roles": reg.sponsor_groups},
            "devices": [{**d.public(), "patient_name": system.ehr.call("my.care_plan", {"patient_id": d.patient_id})["name"]}
                        for d in system.devices.all()],
            "companion": {"running": comp_state["running"], "events": list(comp_state["events"]),
                          "device_id": comp_state["device_id"], "default_instruction": DEFAULT_COMPANION_INSTRUCTION,
                          "demo_pin": SEED_DEVICE["pin"]},
            "staff": staff, "candidates": [c for c in CANDIDATES if not system.directory.get(c)],
            "llm": {"model": DEFAULT_MODEL, "region": DEFAULT_REGION, "boto3": _has_boto3(),
                    "default_instruction": DEFAULT_INSTRUCTION},
            "sessions": sessions[:10], "revocations": system.revocations.list(), "task": task,
            "audit": {"count": len(records), "chain_ok": ok, "first_bad": bad, "tail": records[-80:]},
        })

    async def revoke(req):
        b = await body(req)
        try:
            rec = system.revocations.revoke(b["kind"], b["value"], b.get("reason", "revoked by privacy officer"),
                                            b.get("by", "nina.ross"))
        except (KeyError, ValueError) as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        return JSONResponse(rec.__dict__)

    async def reinstate(req):
        b = await body(req)
        return JSONResponse({"lifted": system.revocations.reinstate(b["kind"], b["value"], b.get("by", "nina.ross"))})

    async def onboard(req):
        b = await body(req)
        app = CANDIDATES.get(b.get("candidate", ""))
        if not app:
            return JSONResponse({"error": "unknown candidate"}, status_code=400)
        res = system.onboarding.onboard(app)
        if res["provisioned"]:
            DEMO_PASSWORD[app.username] = app.initial_password
            system.care_teams.assign("P-1002", app.username)
            write_users()
        return JSONResponse(res)

    async def offboard(req):
        b = await body(req)
        try:
            return JSONResponse(system.onboarding.offboard(b["username"], b.get("reason", "employment ended")))
        except KeyError:
            return JSONResponse({"error": "unknown staff member"}, status_code=400)

    async def sweep(_):
        return JSONResponse({"actions": system.onboarding.compliance_sweep()})

    async def patient_access(req):
        pid = req.path_params["pid"]
        rows = [r for r in system.audit.records() if r.get("patient") == pid]
        return JSONResponse({"patient_id": pid, "events": rows})

    async def run_task(req):
        b = await body(req)
        sponsor = b.get("sponsor", "grace.okafor")
        mode = b.get("mode", "scripted")  # scripted | bedrock | replay
        instruction = (b.get("instruction") or DEFAULT_INSTRUCTION).strip()[:2000]
        delay = float(b.get("step_delay", 2.0))
        with lock:
            if task_state["running"]:
                return JSONResponse({"error": "a task is already running"}, status_code=409)
            task_state.update(running=True, events=[], sponsor=sponsor)

        def emit(e):
            with lock:
                task_state["events"].append(e)

        def worker():
            try:
                m = system.directory.get(sponsor)
                try:
                    tok = system.directory.authenticate(sponsor, DEMO_PASSWORD.get(sponsor, ""),
                                                        totp(system.onboarding.totp_secrets.get(sponsor, "AAAA")))
                except AuthError as exc:
                    emit({"kind": "blocked", "label": f"{m.display_name if m else sponsor} cannot sign in",
                          "detail": str(exc)})
                    return
                emit({"kind": "info", "label": f"{m.display_name} signed in (password + MFA)",
                      "detail": f"{m.public()['role_label']} · caseload {', '.join(system.care_teams.caseload(sponsor)) or 'none'}"})
                client = AgentClient(system.agent_runtime, system=system)
                if mode == "scripted":
                    run_visit_prep(client, tok, emit, step_delay=delay)
                    return
                try:
                    llm = make_llm(mode)
                except Exception as exc:
                    emit({"kind": "deny", "label": "Bedrock unavailable — switching to Replay",
                          "detail": f"{type(exc).__name__}: {exc}"})
                    llm = ReplayLLM()
                stats = run_llm_agent(client, tok, instruction, llm, emit, step_delay=delay)
                if mode == "bedrock" and stats.get("model_error") and stats["tool_calls"] == 0:
                    emit({"kind": "deny", "label": "Bedrock call failed — switching to Replay",
                          "detail": stats["model_error"]})
                    run_llm_agent(AgentClient(system.agent_runtime, system=system), tok, instruction,
                                  ReplayLLM(), emit, step_delay=delay)
            except Exception as exc:
                emit({"kind": "deny", "label": "Task error", "detail": repr(exc)})
            finally:
                with lock:
                    task_state["running"] = False

        threading.Thread(target=worker, daemon=True).start()
        return JSONResponse({"started": True})

    def cemit(e):
        with lock:
            comp_state["events"].append(e)

    async def companion_ask(req):
        b = await body(req)
        dev = system.devices.get(b.get("device_id", ""))
        if not dev:
            return JSONResponse({"error": "unknown device"}, status_code=400)
        pin = str(b.get("pin", ""))
        mode = b.get("mode", "replay")
        prompt = (b.get("prompt") or DEFAULT_COMPANION_INSTRUCTION).strip()[:1000]
        with lock:
            if comp_state["running"]:
                return JSONResponse({"error": "companion is busy"}, status_code=409)
            comp_state.update(running=True, device_id=dev.device_id)
            if b.get("clear"):
                comp_state["events"] = []

        def worker():
            try:
                client = AgentClient(system.device_runtimes[dev.device_id], system=system)
                try:
                    llm = make_llm(mode, "companion")
                except Exception as exc:
                    cemit({"kind": "deny", "who": "companion", "label": "Bedrock unavailable — using Replay",
                           "detail": f"{type(exc).__name__}: {exc}"})
                    llm = companion_replay()
                stats = run_companion_agent(client, pin, prompt, llm, cemit, step_delay=float(b.get("step_delay", 0.6)))
                if mode == "bedrock" and stats.get("model_error") and stats["tool_calls"] == 0:
                    cemit({"kind": "deny", "who": "companion", "label": "Bedrock call failed — using Replay",
                           "detail": stats["model_error"]})
                    run_companion_agent(AgentClient(system.device_runtimes[dev.device_id], system=system), pin,
                                        prompt, companion_replay(), cemit, step_delay=0.6)
            except Exception as exc:
                cemit({"kind": "deny", "who": "companion", "label": "Companion error", "detail": repr(exc)})
            finally:
                with lock:
                    comp_state["running"] = False

        threading.Thread(target=worker, daemon=True).start()
        return JSONResponse({"started": True})

    async def companion_probe(req):
        """Adversarial check without any model: the device directly requests another patient's data."""
        b = await body(req)
        dev = system.devices.get(b.get("device_id", ""))
        if not dev:
            return JSONResponse({"error": "unknown device"}, status_code=400)
        target = b.get("target", "P-1003")
        client = AgentClient(system.device_runtimes[dev.device_id], system=system)
        try:
            client.obtain_companion_grant(str(b.get("pin", "")), COMPANION_TOOLS_REQUESTED)
            client.call_tool("my.care_plan", {"patient_id": target})
            cemit({"kind": "allow", "who": "probe", "label": f"Direct call: my.care_plan({target})", "detail": "unexpectedly allowed"})
        except (ToolDenied, GrantDenied, AccessRevoked, GatewayAuthError) as exc:
            kind = "deny" if isinstance(exc, ToolDenied) else "blocked"
            cemit({"kind": kind, "who": "probe", "label": f"Direct call, no model: my.care_plan(patient_id={target})",
                   "detail": str(exc)})
        return JSONResponse({"ok": True})

    async def devices_pair(req):
        b = await body(req)
        try:
            dev = pair_device(system, b.get("clinician", "grace.okafor"), b.get("patient_id", ""),
                              b.get("label", "Patient tablet"), str(b.get("pin", "1357")))
        except (DeviceError, AuthError, KeyError) as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)
        return JSONResponse(dev.public())

    async def devices_lost(req):
        b = await body(req)
        try:
            return JSONResponse(system.devices.mark_lost(b.get("device_id", ""), b.get("by", "grace.okafor")).public())
        except DeviceError as exc:
            return JSONResponse({"error": str(exc)}, status_code=400)

    async def devices_discharge(req):
        b = await body(req)
        hits = system.devices.discharge_patient(b.get("patient_id", ""), b.get("reason", "patient discharged"),
                                                b.get("by", "grace.okafor"))
        return JSONResponse({"devices": hits})

    app = Starlette(routes=[
        Route("/", dashboard),
        Route("/idp/login", login, methods=["POST"]),
        Route("/grants/exchange", exchange, methods=["POST"]),
        Route("/grants/companion", companion_exchange, methods=["POST"]),
        Route("/mcp", mcp, methods=["POST"]),
        Route("/admin/companion/ask", guard(companion_ask), methods=["POST"]),
        Route("/admin/companion/probe", guard(companion_probe), methods=["POST"]),
        Route("/admin/devices/pair", guard(devices_pair), methods=["POST"]),
        Route("/admin/devices/lost", guard(devices_lost), methods=["POST"]),
        Route("/admin/devices/discharge", guard(devices_discharge), methods=["POST"]),
        Route("/admin/state", guard(state)),
        Route("/admin/revoke", guard(revoke), methods=["POST"]),
        Route("/admin/reinstate", guard(reinstate), methods=["POST"]),
        Route("/admin/onboard", guard(onboard), methods=["POST"]),
        Route("/admin/offboard", guard(offboard), methods=["POST"]),
        Route("/admin/compliance-sweep", guard(sweep), methods=["POST"]),
        Route("/admin/patient-access/{pid}", guard(patient_access)),
        Route("/admin/run-task", guard(run_task), methods=["POST"]),
    ])
    return app, admin_key


def main():
    import uvicorn
    ap = argparse.ArgumentParser(description="AgenticPrint for Hospice")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8080)
    a = ap.parse_args()
    app, key = create_app()
    print(f"\n  AgenticPrint for Hospice console:  http://{a.host}:{a.port}/#key={key}\n")
    uvicorn.run(app, host=a.host, port=a.port, log_level="warning")


if __name__ == "__main__":
    main()
