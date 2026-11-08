"""Run the agent as a separate process against the HTTP service.

    python -m hospiceprint.app          # terminal 1
    python agent_client.py              # terminal 2 — then revoke from the console

Reads the workload key and demo credentials the server provisioned in .hospiceprint/.
"""
import argparse
import json
from pathlib import Path

import requests

from hospiceprint.agent import AgentClient
from hospiceprint.crypto import totp
from hospiceprint.task import run_visit_prep
from hospiceprint.workload import AgentRuntime

COLORS = {"allow": "\033[32m", "deny": "\033[33m", "blocked": "\033[31m", "info": "\033[36m"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8080")
    ap.add_argument("--sponsor", default="grace.okafor")
    ap.add_argument("--step-delay", type=float, default=3.0)
    ap.add_argument("--state-dir", default=".hospiceprint")
    a = ap.parse_args()

    state = Path(a.state_dir)
    manifest = json.loads((state / "agent-manifest.json").read_text())
    users = json.loads((state / "demo-users.json").read_text())
    runtime = AgentRuntime.from_pem((state / "agent-key.pem").read_bytes(), **manifest)

    u = users[a.sponsor]
    r = requests.post(f"{a.url}/idp/login", json={
        "username": a.sponsor, "password": u["password"], "otp": totp(u["totp_secret"])})
    r.raise_for_status()
    print(f"\033[36mINFO\033[0m    {a.sponsor} signed in with password + MFA")

    def show(e):
        print(f"{COLORS[e['kind']]}{e['kind'].upper():<8}\033[0m{e['label']}")
        if e.get("detail"):
            print(f"        \033[2m{e['detail']}\033[0m")

    client = AgentClient(runtime, base_url=a.url)
    run_visit_prep(client, r.json()["id_token"], show, step_delay=a.step_delay)


if __name__ == "__main__":
    main()
