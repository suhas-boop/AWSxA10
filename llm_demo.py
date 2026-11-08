"""Terminal version of the live demo: Claude on Bedrock drives the agent; revoke mid-task.

    python llm_demo.py                          # live (Bedrock); falls back to replay if unavailable
    python llm_demo.py --mode replay            # offline, deterministic
    python llm_demo.py --revoke-after 5         # privacy officer revokes after the 5th tool call
    python llm_demo.py --instruction "..."      # your own request

Environment: AWS credentials as usual, plus optional BEDROCK_MODEL_ID, AWS_REGION, BEDROCK_EFFORT.
"""
import argparse
import sys

from hospiceprint.agent import AgentClient
from hospiceprint.crypto import totp
from hospiceprint.llm_agent import DEFAULT_INSTRUCTION, ReplayLLM, make_llm, run_llm_agent
from hospiceprint.system import DEMO_PASSWORD, build_system

C = {"allow": "\033[32m", "deny": "\033[33m", "blocked": "\033[31m", "info": "\033[36m",
     "agent": "\033[35m", "dim": "\033[2m", "bold": "\033[1m", "end": "\033[0m"}
if not sys.stdout.isatty():
    C = {k: "" for k in C}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["bedrock", "replay"], default="bedrock")
    ap.add_argument("--sponsor", default="grace.okafor")
    ap.add_argument("--revoke-after", type=int, default=6, help="tool calls before revocation (0 = never)")
    ap.add_argument("--instruction", default=DEFAULT_INSTRUCTION)
    ap.add_argument("--step-delay", type=float, default=0.0)
    a = ap.parse_args()

    s = build_system()
    tok = s.directory.authenticate(a.sponsor, DEMO_PASSWORD[a.sponsor], totp(s.totp_secret(a.sponsor)))
    print(f"{C['info']}INFO    {C['end']}{a.sponsor} signed in with password + MFA")

    try:
        llm = make_llm(a.mode)
    except Exception as exc:
        print(f"{C['deny']}NOTE    {C['end']}Bedrock unavailable ({type(exc).__name__}: {exc}); using replay")
        llm = ReplayLLM()

    allowed_calls = {"n": 0}

    def show(e):
        tag = "AGENT" if e["kind"] == "agent" else e["kind"].upper()
        print(f"{C[e['kind']]}{tag:<8}{C['end']}{e['label'] if e['kind'] != 'agent' else ''}"
              f"{'' if e['kind'] != 'agent' else e['detail']}")
        if e["kind"] != "agent" and e.get("detail"):
            print(f"        {C['dim']}{e['detail']}{C['end']}")
        for t in e.get("granted", []):
            print(f"        {C['allow']}✓ {t}{C['end']}")
        for t, why in (e.get("withheld") or {}).items():
            print(f"        {C['deny']}✕ {t}{C['end']} {C['dim']}({why}){C['end']}")
        if e.get("tool"):
            allowed_calls["n"] += 1
            if a.revoke_after and allowed_calls["n"] == a.revoke_after:
                print(f"\n{C['blocked']}{C['bold']}>>> PRIVACY OFFICER revokes the agent mid-task{C['end']}\n")
                s.revocations.revoke("agent", s.agent_runtime.agent_id,
                                     "unusual access pattern flagged by privacy monitoring", "nina.ross")

    stats = run_llm_agent(AgentClient(s.agent_runtime, system=s), tok, a.instruction, llm, show,
                          step_delay=a.step_delay)
    if stats.get("model_error") and stats["tool_calls"] == 0 and a.mode == "bedrock":
        print(f"\n{C['deny']}NOTE    {C['end']}Bedrock call failed; re-running with replay\n")
        s.revocations.reinstate("agent", s.agent_runtime.agent_id, "demo")
        allowed_calls["n"] = 0
        run_llm_agent(AgentClient(s.agent_runtime, system=s), tok, a.instruction, ReplayLLM(), show,
                      step_delay=a.step_delay)
    ok, _ = s.audit.verify()
    print(f"\n{len(s.audit.records())} audit events · chain {'verified' if ok else 'BROKEN'}")


if __name__ == "__main__":
    main()
