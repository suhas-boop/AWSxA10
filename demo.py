"""One-command terminal demo (no server):  python demo.py

1. Staff onboarding with regulatory gates (one candidate passes, two are blocked)
2. Enterprise sign-in for an RN (password + MFA)
3. The care coordination agent authenticates, receives selected MCP tools, and works
4. The Privacy Officer revokes the agent mid-task; later requests and re-grants are blocked
5. HR offboards the RN; one action cuts every path
6. Patient access report + audit chain verification
"""
import sys

from hospiceprint.agent import AgentClient, GatewayAuthError
from hospiceprint.crypto import totp
from hospiceprint.directory import AuthError
from hospiceprint.system import CANDIDATES, DEMO_PASSWORD, build_system
from hospiceprint.task import run_visit_prep
from hospiceprint.workload import AgentRuntime

C = {"allow": "\033[32m", "deny": "\033[33m", "blocked": "\033[31m", "info": "\033[36m",
     "break-glass": "\033[35m", "dim": "\033[2m", "bold": "\033[1m", "end": "\033[0m"}
if not sys.stdout.isatty():
    C = {k: "" for k in C}

STOLEN_TOKEN_STEP = 3
REVOKE_BEFORE_STEP = 9


def banner(text):
    print(f"\n{C['bold']}━━ {text} {'━' * max(0, 70 - len(text))}{C['end']}")


def show(e):
    print(f"  {C[e['kind']]}{e['kind'].upper():<8}{C['end']}{e['label']}")
    if e.get("detail"):
        print(f"          {C['dim']}{e['detail']}{C['end']}")
    for t in e.get("granted", []):
        print(f"          {C['allow']}✓ {t}{C['end']}")
    for t, why in (e.get("withheld") or {}).items():
        print(f"          {C['deny']}✕ {t}{C['end']} {C['dim']}({why}){C['end']}")


def show_onboarding(result):
    s = result["staff"]
    head = (f"{C['allow']}PROVISIONED{C['end']}" if result["provisioned"]
            else f"{C['blocked']}NOT PROVISIONED{C['end']}")
    print(f"\n  {head}  {s['name']} · {s['role_label']}")
    mark = {"pass": f"{C['allow']}✓{C['end']}", "fail": f"{C['blocked']}✕{C['end']}",
            "pending": f"{C['deny']}…{C['end']}", "skipped": f"{C['dim']}–{C['end']}"}
    for g in s["onboarding"]:
        if g["status"] == "skipped":
            continue
        print(f"    {mark[g['status']]} {g['label']:<44} {C['dim']}{g['ref']}{C['end']}")
        if g["status"] != "pass" or g["gate"] in ("license",):
            print(f"        {C['dim']}{g['detail']}{C['end']}")


def main():
    sysm = build_system()

    banner("1. Staff onboarding (regulatory gates)")
    print(f"  {C['dim']}Grace Okafor, RN, was onboarded through the same pipeline at startup:{C['end']}")
    show_onboarding({"provisioned": True, "staff": sysm.directory.get("grace.okafor").public()})
    for cand in ("tom.reyes", "kelly.nash"):
        show_onboarding(sysm.onboarding.onboard(CANDIDATES[cand]))

    banner("2. Enterprise sign-in")
    user = "grace.okafor"
    id_token = sysm.directory.authenticate(user, DEMO_PASSWORD[user], totp(sysm.totp_secret(user)))
    print(f"  {C['allow']}ALLOW{C['end']}   Grace Okafor · RN Case Manager · password + MFA · "
          f"caseload {', '.join(sysm.care_teams.caseload(user))}")
    try:
        sysm.directory.authenticate("tom.reyes", "Hospice#Aide2027", "000000")
    except AuthError as exc:
        print(f"  {C['blocked']}BLOCKED{C['end']} Tom Reyes tries to sign in (never provisioned): "
              f"{C['dim']}{exc}{C['end']}")

    banner("3. Care coordination agent prepares Grace's visit day")
    client = AgentClient(sysm.agent_runtime, system=sysm)

    def before_step(i):
        if i == STOLEN_TOKEN_STEP:
            thief = AgentClient(AgentRuntime(sysm.agent_runtime.agent_id, "x", "x", "x", []), system=sysm)
            thief.token = client.token
            try:
                thief.call_tool("patients.get_summary", {"patient_id": "P-1001"})
                print("  stolen token unexpectedly worked")
            except GatewayAuthError as exc:
                print(f"  {C['blocked']}BLOCKED {C['end']}Attacker replays the agent's token from another machine")
                print(f"          {C['dim']}{exc}{C['end']}")
        if i == REVOKE_BEFORE_STEP:
            print(f"\n  {C['blocked']}{C['bold']}>>> PRIVACY OFFICER revokes the agent mid-task{C['end']}")
            print(f"  {C['dim']}    reason: unusual access pattern flagged by privacy monitoring{C['end']}\n")
            sysm.revocations.revoke("agent", sysm.agent_runtime.agent_id,
                                    "unusual access pattern flagged by privacy monitoring", "nina.ross")

    summary = run_visit_prep(client, id_token, show, before_step=before_step)

    banner("4. HR offboards Grace (termination procedures)")
    sysm.revocations.reinstate("agent", sysm.agent_runtime.agent_id, "nina.ross")
    c2 = AgentClient(sysm.agent_runtime, system=sysm)
    c2.obtain_grant(id_token, ["patients.get_summary"], task="afternoon visits")
    c2.call_tool("patients.get_summary", {"patient_id": "P-1003"})
    print(f"  {C['info']}INFO    {C['end']}Agent cleared after review; Grace's new agent session is live")
    off = sysm.onboarding.offboard("grace.okafor", "employment ended")
    print(f"  {C['blocked']}REVOKE  {C['end']}Grace terminated · removed from care teams "
          f"{', '.join(off['removed_from_care_teams'])}")
    for label, fn in [
        ("Her live agent session", lambda: c2.call_tool("patients.get_summary", {"patient_id": "P-1003"})),
        ("Her ID token at grant exchange", lambda: c2.obtain_grant(id_token, ["patients.get_summary"])),
        ("A fresh sign-in", lambda: sysm.directory.authenticate(
            user, DEMO_PASSWORD[user], totp(sysm.totp_secret(user)))),
    ]:
        try:
            fn()
            print(f"  ALLOW   {label} — unexpected")
        except Exception as exc:
            print(f"  {C['blocked']}BLOCKED {C['end']}{label}: {C['dim']}{exc}{C['end']}")

    banner("5. Patient access report: P-1001 (Eleanor Vance)")
    for r in sysm.audit.records():
        if r.get("patient") == "P-1001" and r["event"] == "gateway.request":
            print(f"  #{r['seq']:<3} {r['decision']:<8} {r.get('tool', ''):<24} "
                  f"{r.get('sponsor')} via agent · {r.get('purpose')}")
            print(f"       {C['dim']}{r.get('reason', '')}{C['end']}")

    banner("6. Audit chain")
    ok, bad = sysm.audit.verify()
    print(f"  {len(sysm.audit.records())} hash-chained events · chain {'verified ✓' if ok else f'BROKEN at #{bad}'}")
    print(f"  task: completed {summary['completed']} · denied {summary['denied']} · blocked {summary['blocked']}"
          f" · revoked before step {summary['revoked_at']}\n")


if __name__ == "__main__":
    main()
