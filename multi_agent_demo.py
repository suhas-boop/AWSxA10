"""Multi-agent demo: RN orchestrator + patient-bound companion agents.

    python multi_agent_demo.py                  # Claude on Bedrock; falls back to replay if unavailable
    python multi_agent_demo.py --mode replay    # offline, deterministic

1. Pairing: an RN on the care team pairs Eleanor's tablet (one-time code + device key + PIN)
2. Eleanor's companion: answers her, reports a symptom, is refused when asked about another patient
3. RN orchestrator: reads the report (as untrusted data), schedules, reminds the tablet; revoked mid-task
4. Blast radius: the orchestrator is revoked, but Eleanor's companion keeps working
5. Lost tablet: the companion is cut off, and the orchestrator can no longer message that device
"""
import argparse
import sys

from hospiceprint.agent import AccessRevoked, AgentClient, ToolDenied
from hospiceprint.crypto import totp
from hospiceprint.devices import DeviceError
from hospiceprint.llm_agent import (DEFAULT_COMPANION_INSTRUCTION, DEFAULT_INSTRUCTION, ReplayLLM,
                                    companion_replay, make_llm, run_companion_agent, run_llm_agent)
from hospiceprint.system import DEMO_PASSWORD, SEED_DEVICE, build_system

C = {"allow": "\033[32m", "deny": "\033[33m", "blocked": "\033[31m", "info": "\033[36m",
     "agent": "\033[35m", "dim": "\033[2m", "bold": "\033[1m", "end": "\033[0m"}
if not sys.stdout.isatty():
    C = {k: "" for k in C}


def banner(t):
    print(f"\n{C['bold']}━━ {t} {'━' * max(0, 70 - len(t))}{C['end']}")


def show(e):
    if e["kind"] == "agent":
        print(f"  {C['agent']}{e['who'].upper():<13}{C['end']}“{e['detail']}”")
        return
    print(f"  {C[e['kind']]}{e['kind'].upper():<13}{C['end']}{e['label']}")
    if e.get("detail") and e["label"] != "Request":
        print(f"  {'':<13}{C['dim']}{e['detail']}{C['end']}")
    for t in e.get("granted", []):
        print(f"  {'':<13}{C['allow']}✓ {t}{C['end']}")
    for t, why in (e.get("withheld") or {}).items():
        print(f"  {'':<13}{C['deny']}✕ {t}{C['end']} {C['dim']}({why}){C['end']}")


def brain(mode, plan):
    try:
        return make_llm(mode, plan)
    except Exception as exc:
        print(f"  {C['deny']}NOTE{C['end']}         Bedrock unavailable ({type(exc).__name__}); using replay")
        return companion_replay() if plan == "companion" else ReplayLLM()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["bedrock", "replay"], default="bedrock")
    ap.add_argument("--revoke-after", type=int, default=6, help="orchestrator tool calls before revocation")
    a = ap.parse_args()
    s = build_system()
    login = lambda u: s.directory.authenticate(u, DEMO_PASSWORD[u], totp(s.totp_secret(u)))  # noqa: E731

    banner("1. Pairing patient devices")
    dev = s.devices.active_for_patient("P-1001")[0]
    print(f"  {C['allow']}PAIRED{C['end']}       {dev.label} → bound to {dev.patient_id} · paired by "
          f"{dev.paired_by} · agent {dev.agent_id}")
    print(f"  {'':<13}{C['dim']}one-time 6-digit code (10 min) + key generated on the device + "
          f"patient PIN (demo PIN {SEED_DEVICE['pin']}){C['end']}")
    for who, pid, why in [("maya.chen", "P-1001", "aide tries to pair"),
                          ("grace.okafor", "P-2001", "RN tries to pair a patient outside her care team")]:
        try:
            s.devices.start_pairing(login(who), pid, "tablet")
        except DeviceError as exc:
            print(f"  {C['blocked']}BLOCKED{C['end']}      {why}: {C['dim']}{exc}{C['end']}")

    banner("2. Eleanor talks to her companion tablet")
    companion = AgentClient(s.device_runtimes[dev.device_id], system=s)
    run_companion_agent(companion, SEED_DEVICE["pin"], DEFAULT_COMPANION_INSTRUCTION,
                        brain(a.mode, "companion"), show)

    banner("3. Grace's agent orchestrates — and is revoked mid-task")
    count = {"n": 0}

    def show_and_revoke(e):
        show(e)
        if e.get("tool"):
            count["n"] += 1
            if count["n"] == a.revoke_after:
                print(f"\n  {C['blocked']}{C['bold']}>>> PRIVACY OFFICER revokes the RN orchestrator agent{C['end']}\n")
                s.revocations.revoke("agent", s.agent_runtime.agent_id,
                                     "unusual access pattern flagged by privacy monitoring", "nina.ross")
    run_llm_agent(AgentClient(s.agent_runtime, system=s), login("grace.okafor"), DEFAULT_INSTRUCTION,
                  brain(a.mode, "rn"), show_and_revoke)

    banner("4. Blast radius: Eleanor's companion still works")
    r = companion.call_tool("my.messages", {})
    print(f"  {C['allow']}ALLOW{C['end']}        my.messages → {r['messages'] or 'no messages yet'}")

    banner("5. Eleanor's tablet is reported lost")
    s.devices.mark_lost(dev.device_id, "grace.okafor")
    try:
        companion.call_tool("my.schedule", {})
    except AccessRevoked as exc:
        print(f"  {C['blocked']}BLOCKED{C['end']}      companion on the lost tablet: {C['dim']}{exc}{C['end']}")
    s.revocations.reinstate("agent", s.agent_runtime.agent_id, "nina.ross")
    rn = AgentClient(s.agent_runtime, system=s)
    rn.obtain_grant(login("grace.okafor"), ["companion.dispatch"])
    try:
        rn.call_tool("companion.dispatch", {"patient_id": "P-1001", "message": "Visit moved to 11 AM"})
    except ToolDenied as exc:
        print(f"  {C['deny']}DENY{C['end']}         orchestrator (cleared after review) messages the lost tablet: "
              f"{C['dim']}{exc}{C['end']}")

    banner("6. Audit")
    ok, _ = s.audit.verify()
    bind = sum(1 for x in s.audit.records() if x.get("rule") == "patient-binding")
    print(f"  {len(s.audit.records())} hash-chained events · chain {'verified ✓' if ok else 'BROKEN'} · "
          f"{bind} cross-patient attempt(s) blocked by device binding\n")


if __name__ == "__main__":
    main()
