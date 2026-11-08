"""Demo workload: the agent prepares an RN's home-visit day, step by step."""
from __future__ import annotations

import time
from typing import Callable

from .agent import AccessRevoked, AgentClient, GatewayAuthError, GrantDenied, ToolDenied

REQUESTED_TOOLS = ["patients.get_summary", "meds.get_list", "visits.schedule", "notes.draft_visit_note",
                   "family.send_update", "records.read_part2", "inbox.read_reports",
                   "companion.dispatch", "meds.order_controlled", "billing.submit_claim"]

STEPS = [
    ("Summarize Eleanor Vance (P-1001)", "patients.get_summary", {"patient_id": "P-1001"}),
    ("Review P-1001 medications", "meds.get_list", {"patient_id": "P-1001"}),
    ("Schedule RN visit for P-1001", "visits.schedule",
     {"patient_id": "P-1001", "when": "tomorrow 10:00 AM", "discipline": "RN"}),
    ("Open a patient outside the care team (P-2001)", "patients.get_summary", {"patient_id": "P-2001"}),
    ("Order morphine for P-1001 (not granted)", "meds.order_controlled",
     {"patient_id": "P-1001", "drug": "Morphine sulfate", "dose": "10 mg"}),
    ("Read P-1001 substance-use records (no consent)", "records.read_part2", {"patient_id": "P-1001"}),
    ("Update an unauthorized contact for P-1003", "family.send_update",
     {"patient_id": "P-1003", "recipient": "Tony Ruiz", "message": "Visit moved to 10 AM"}),
    ("Update Rosa Delgado's daughter (authorized)", "family.send_update",
     {"patient_id": "P-1003", "recipient": "Marisol Delgado", "message": "Nurse visit tomorrow 10 AM"}),
    ("Draft visit note for P-1001", "notes.draft_visit_note",
     {"patient_id": "P-1001", "observations": "Mild dyspnea at rest, weight stable"}),
    ("Schedule aide visit for P-1003", "visits.schedule",
     {"patient_id": "P-1003", "when": "tomorrow 2:00 PM", "discipline": "Aide"}),
]

Emit = Callable[[dict], None]


def _brief(tool: str, result: dict) -> str:
    if tool == "patients.get_summary":
        return f"{result.get('name')} · {result.get('terminal_diagnosis', '—')} · {result.get('code_status', '')}"
    if tool == "meds.get_list":
        return f"{len(result['medications'])} active meds · allergies: {', '.join(result['allergies']) or 'none'}"
    if tool == "visits.schedule":
        return f"{result['visit_id']} {result['discipline']} visit {result['when']}"
    if tool == "notes.draft_visit_note":
        return f"{result['note_id']} {result['status']}"
    if tool == "family.send_update":
        return f"{result['message_id']} sent to {result['recipient']} via {result['channel']}"
    return str(result)


def run_visit_prep(client: AgentClient, id_token: str, emit: Emit, step_delay: float = 0.0,
                   before_step: Callable[[int], None] | None = None) -> dict:
    summary = {"completed": 0, "denied": 0, "blocked": 0, "revoked_at": None}

    def ev(kind, label, detail="", **kw):
        emit({"kind": kind, "label": label, "detail": detail, **kw})

    try:
        g = client.obtain_grant(id_token, REQUESTED_TOOLS, purpose="TREAT", task="Home-visit prep")
    except GrantDenied as exc:
        ev("deny", "Grant exchange refused", str(exc))
        return summary
    ev("allow", "Agent authenticated — grant issued (purpose: TREAT)",
       f"print {g['print']} · session {g['sid']}", granted=g["granted_tools"], withheld=g["withheld_tools"])

    client.initialize()
    ev("allow", "MCP tools/list (filtered by grant)", ", ".join(t["name"] for t in client.list_tools()))

    for i, (label, tool, args) in enumerate(STEPS, start=1):
        if before_step:
            before_step(i)
        if step_delay:
            time.sleep(step_delay)
        try:
            res = client.call_tool_full(tool, args)
            summary["completed"] += 1
            withheld = res.get("_meta", {}).get("minimumNecessary", {}).get("withheldFields", [])
            detail = _brief(tool, res["structuredContent"])
            if withheld:
                detail += f"  ·  minimum necessary withheld: {', '.join(withheld)}"
            ev("allow", f"Step {i}: {label}", detail, tool=tool)
        except ToolDenied as exc:
            summary["denied"] += 1
            ev("deny", f"Step {i}: {label}", str(exc), tool=tool)
        except (AccessRevoked, GatewayAuthError) as exc:
            summary["blocked"] += 1
            summary["revoked_at"] = summary["revoked_at"] or i
            ev("blocked", f"Step {i}: {label}", str(exc), tool=tool)
            break

    if summary["revoked_at"]:
        try:
            client.call_tool("visits.schedule", {"patient_id": "P-1003", "when": "tomorrow 2:00 PM"})
            ev("allow", "Retry with the same token", "unexpectedly succeeded")
        except (AccessRevoked, GatewayAuthError) as exc:
            summary["blocked"] += 1
            ev("blocked", "Retry with the same token", str(exc))
        try:
            g2 = client.obtain_grant(id_token, REQUESTED_TOOLS, purpose="TREAT", task="retry after revocation")
            ev("info", "Request a fresh grant", f"new session {g2['sid']} — revocation was scoped to one session")
        except GrantDenied as exc:
            summary["blocked"] += 1
            ev("blocked", "Request a fresh grant", str(exc))
    else:
        ev("info", "Task finished", f"{summary['completed']} steps completed, {summary['denied']} denied")
    return summary
