# AgenticPrint for Hospice — Agentic Identity for Hospice Care

AgenticPrint for Hospice is an identity and access layer for AI agents that work with patient records in a hospice. It covers the full chain:

1. A staff member is **onboarded** through regulated gates.
2. They **sign in** with MFA.
3. They **sponsor** an AI agent, which proves its own workload identity.
4. The agent receives only the **MCP tools** the person's role is entitled to.
5. Every request is checked against the **patient care relationship**, **purpose of use**, **consent** and **minimum necessary** rules.
6. A Privacy Officer or HR can **revoke access mid-task**, and the very next request is blocked.

> All people, patients and records in this project are **synthetic**. It is a prototype, not a certified compliance product.

## Demo (what it shows)

| # | Scene | What happens |
|---|---|---|
| 1 | Staff onboarding | Grace Okafor, RN, passes 9 gates and is provisioned. Tom Reyes (aide) is stopped by an exclusion-list match. Kelly Nash (RN) is stopped by an expired license. |
| 2 | Enterprise sign-in | Grace signs in with password and TOTP MFA. Tom, never provisioned, cannot sign in. |
| 3 | Agent authenticates | The Care Coordination Agent signs an attestation with its workload key. Its **print** (hash of model, prompt, toolset and key) is checked. It receives a 5-minute token bound to that key. |
| 3 | Selected MCP tools | The agent requested 8 tools and got 6. Ordering controlled substances is outside the agent's approved ceiling: agents never prescribe. Billing is outside the ceiling, not entitled to an RN, and not allowed for the Treatment purpose. |
| 3 | Per-call checks | **Allowed:** P-1001 summary (payer field withheld under minimum necessary), meds, visit scheduling, update to an authorized daughter. **Denied:** a patient outside Grace's care team, a morphine order, Part 2 records without consent, an unauthorized neighbor. **Blocked:** a stolen token replayed from another machine. |
| 4 | Revoke mid-task | The Privacy Officer revokes the agent. The next step, a retry with the same token, and a fresh grant request are all blocked. |
| 5 | Offboarding | HR terminates Grace in one action. Her account is disabled, every agent she sponsors is revoked, and she is removed from all care teams. Her live session, her ID token and a fresh sign-in all fail. |
| 6 | Patient access report | Every access to P-1001: who, via which agent, for what purpose, and allowed or denied. The audit chain verifies. |

## Run it

Requires Python 3.10+ (tested on 3.13).

```bash
pip install -r requirements.txt
```

Terminal demo, no server:
```bash
python demo.py
```

Live console (best for presenting):
```bash
python -m hospiceprint.app        # open the printed URL
```

1. Choose a sponsor and click **Run visit prep**.
2. Around step 8, click **Revoke agent** in Sessions.
3. Try **Onboard** on each candidate, **Offboard** on an active staff member, and **Run compliance sweep**.

Agent as a separate process over HTTP:
```bash
python agent_client.py            # second terminal, while the server runs
```

Tests (52 security, compliance, live-agent and multi-agent behaviours, with Bedrock stubbed):
```bash
python -m unittest -v
```

## Multi-agent: RN orchestrator + patient companion devices

There are two kinds of agent, and each has its own identity:

| | RN orchestrator | Patient companion |
|---|---|---|
| Runs on | Hospice infrastructure | A tablet or display in the patient's home |
| Signs in with | A staff member's ID token (password + MFA) and its workload key | The device's own key and the patient's PIN; no staff credentials |
| Scope | Patients on the sponsoring clinician's care team | **Exactly one patient**, fixed when the device is paired |
| Purpose of use | `TREAT` | `PATRQT` (patient requested) |
| Tools | Clinical tools + `inbox.read_reports` + `companion.dispatch` | `my.schedule`, `my.care_plan`, `my.med_reminders`, `my.messages`, `my.report_symptom` |

**Pairing a device** (`devices.py`):

1. An RN, physician or social worker **on that patient's care team** starts pairing and gets a one-time 6-digit code, valid for 10 minutes.
2. The device makes its own key and redeems the code. The patient chooses a 4–6 digit PIN.
3. The device is registered as its own agent, with its own print, and bound to the patient.

Five wrong PINs lock the device and revoke it; it then has to be re-paired at the next visit.

**Patient binding** (`policy.py`): every companion call is forced onto the bound patient.

- If the call names no patient, the gateway fills in the bound one.
- If it names a different patient, the call is denied (rule `patient-binding`) and the attempt is recorded in the audit, whether a model chose to try it or someone sent the request directly.

**How the two agents talk:** they never share credentials. They only exchange data through tools the gateway checks:

- Companion → RN: `my.report_symptom` puts a report in the care team's inbox. The orchestrator reads it with `inbox.read_reports`. Patient-typed text arrives labelled `untrusted_patient_text`, and the orchestrator's system prompt says to treat it as data, never as instructions. This is a defence against prompt injection from patient devices.
- RN → companion: `companion.dispatch` delivers a reminder or check-in to the patient's device. It needs the patient on the RN's care team **and** an active paired device.

**Revocation stays separate:**

- Revoking the orchestrator does not touch any companion.
- **Report lost** revokes one device.
- **Discharge** revokes every device for that patient (a `sponsor` revocation on `patient:<id>`), for discharge, revocation of the hospice benefit, or death.

**Run it:**
```bash
python multi_agent_demo.py --mode replay   # or omit --mode for Claude on Bedrock
python -m hospiceprint.app                 # console: "Patient companion device" panel
```

In the console, use **Ask** on Eleanor's tablet, then **Try to read P-1003**, which bypasses the model entirely, then **Report lost**. Run the RN orchestrator in the top panel to see it read Eleanor's report and send her tablet a reminder.

## Live mode: Claude on Amazon Bedrock drives the agent

In live mode the scripted steps are replaced by a real model. A judge types a request, and Claude on Bedrock decides which MCP tools to call. AgenticPrint enforces every call. The model never sees tools outside its grant: an RN-sponsored agent is shown 6 tools, an aide's agent 3. Denials go back to the model as tool errors, so it adapts. A revocation stops it at its next call.

**Quick start (short-term Bedrock API key):**
```bash
source .venv/bin/activate && pip install -r requirements.txt
export AWS_BEARER_TOKEN_BEDROCK='<Bedrock console > API keys > Short-term > Generate>'
python check_bedrock.py            # confirms the model answers AND calls a tool
python multi_agent_demo.py         # or: python -m hospiceprint.app (Brain = Live)
```

**One-time AWS setup (about 15 minutes):**

1. **Model access.** In the Bedrock console, in your region, request access to Anthropic Claude Sonnet 5.5. Approval is per account and per region, so do this before the hackathon.
2. **IAM permission.** The credentials you run with need `bedrock:InvokeModel` on the inference profile and on the underlying model.
3. **Install boto3 and configure credentials:**
   ```bash
   pip install -r requirements.txt   # includes boto3
   aws configure                     # or export AWS_PROFILE=...
   ```
4. **Preflight check:**
   ```bash
   aws bedrock-runtime converse --region us-west-2 --model-id us.anthropic.claude-sonnet-5-5 \
     --messages '[{"role":"user","content":[{"text":"ping"}]}]'
   ```

Settings (optional environment variables):

| Variable | Default | Notes |
|---|---|---|
| `BEDROCK_MODEL_ID` | `us.anthropic.claude-sonnet-5` | Must be an inference profile ID (`us.` / `global.` prefix). Also tested in code: `us.anthropic.claude-sonnet-5-5`, `us.xai.grok-4.7` |
| `AWS_REGION` | `us-east-2` | Any region that serves the profile; a short-term API key only works in the region where it was generated |
| `BEDROCK_EFFORT` | `low` | Lower effort means faster turns on stage. Set it to empty to send no effort setting. If the model rejects the field, the code retries once without it. |

**Run it:**
```bash
python -m hospiceprint.app            # console: Brain = "Live · Claude on Amazon Bedrock"
python llm_demo.py                    # terminal: revokes after the 6th tool call
python llm_demo.py --mode replay      # offline, deterministic
python llm_demo.py --instruction "Prep Rosa Delgado's aide visit and update her daughter"
```

**Stage safety net.** If boto3 is missing, credentials fail, or the first model call errors, the run switches to **Replay** automatically and says so in the event feed. Replay is a scripted model that uses the same Converse message format and the same gateway, so the console looks the same. You can also pick Replay yourself in the Brain menu.

**Suggested script for judges:**
1. Run with the default request. Point out the denials as they happen: Part 2 consent, a patient outside the care team, the unauthorized neighbor.
2. Click **Revoke agent** while the agent is still working.
3. Switch the sponsor to Maya Chen (aide) and run again. The model is now shown only 3 tools, and patient summaries come back without diagnoses.

## Regulatory mapping

| Requirement | Where it is enforced |
|---|---|
| 42 CFR 418.114(a): staff licensed and practicing within scope, qualifications current | Onboarding license gate (primary-source check, holder name, license type for role, expiry). Sign-in and every grant re-check that the license is current. The nightly sweep suspends staff whose license lapses. |
| 42 CFR 418.114(d): criminal background check for staff with patient contact or record access | Onboarding background gate. A *pending* or adverse result blocks provisioning. |
| OIG LEIE / SAM exclusion screening | Onboarding exclusion gate, plus the nightly sweep, which suspends staff who match after hire. |
| 42 CFR 418.76: hospice aide competency | Role competency gate. |
| 42 CFR 418.56: interdisciplinary group | Care-team registry. Access requires a care relationship, checked live on every call. |
| 45 CFR 164.308(a)(3): workforce security, including termination | Offboarding disables the account, revokes sponsored agents and removes care-team access in one action. |
| 45 CFR 164.308(a)(4) and 164.502(b) / 164.514(d): access management, minimum necessary | Role entitlements and three-way intersection at grant time. Per-role field filtering on patient summaries. |
| 45 CFR 164.308(a)(5) and 164.530(b): security and privacy training | Training gate (HIPAA privacy, HIPAA security, hospice orientation). |
| 45 CFR 164.312(a)(1): unique user ID, emergency access, automatic logoff | Per-person accounts. Break-glass (`ETREAT`) for RNs and physicians, with written justification, flagged in the audit. 15-minute ID tokens and 5-minute agent tokens. |
| 45 CFR 164.312(b) and (c): audit controls, integrity | Hash-chained audit with patient ID, purpose, decision and withheld fields. Tampering is detected. |
| 45 CFR 164.312(d): person or entity authentication | Staff: password and TOTP. Agents: workload-key attestation and a per-request proof of possession. |
| 42 CFR Part 2: substance use disorder records | `records.read_part2` requires consent on file. Responses carry a redisclosure notice. |
| 45 CFR 164.510(b): sharing with family involved in care | `family.send_update` only goes to contacts marked authorized on the patient record. |
| Controlled substances (DEA EPCS) | Outside every agent's ceiling, so agents can never order them. Only the medical director role is entitled, for direct use. |

**On MFA:** HHS proposed in January 2025 to make MFA mandatory under the HIPAA Security Rule. That rule is **not final**: HHS has moved final action to at least July 2027. AgenticPrint requires MFA anyway, as a security choice, not because current law demands it.

## Architecture

```
HR system ──▶ Onboarding gates ──▶ Workforce directory (status, role, license)
                                          │ ID token (pwd + MFA)
Agent runtime (workload key) ──attestation──▶ Grant Exchange ──▶ scoped, key-bound token
                                          │
Agent ──tools/call + Print-Proof──▶ MCP Gateway ──▶ Hospice EHR MCP server
                                   │ token · revocation · proof · purpose · care team
                                   │ consent · minimum-necessary filter
                                   └──▶ hash-chained audit (patient-level)
```

| File | Role |
|---|---|
| `hospiceprint/onboarding.py` | 9 onboarding gates, offboarding, nightly compliance sweep |
| `hospiceprint/directory.py` | Workforce directory and sign-in (scrypt, TOTP, RS256); live status and license checks |
| `hospiceprint/policy.py` | Tool catalog, role entitlements, purpose of use, care teams, Part 2 and family rules, minimum necessary |
| `hospiceprint/grants.py` | Grant exchange: delegation, print check, break-glass, three-way intersection |
| `hospiceprint/devices.py` | Companion device pairing, patient binding, PIN lockout, lost and discharge |
| `multi_agent_demo.py` | Terminal demo of the orchestrator and companion agents |
| `hospiceprint/llm_agent.py` | Bedrock Converse tool loop, tool-name mapping, Replay fallback |
| `hospiceprint/gateway.py` | MCP JSON-RPC gateway with per-request checks and field filtering |
| `hospiceprint/ehr_mcp.py` | Mock hospice EHR tools (synthetic patients) |
| `hospiceprint/workload.py`, `revocation.py`, `audit.py`, `crypto.py` | Agent identity and print, five-scope revocation, audit chain, crypto helpers |
| `hospiceprint/app.py`, `dashboard.html` | HTTP service and admin console |

## AWS deployment path

| Component | AWS service |
|---|---|
| Workforce IdP | IAM Identity Center or Amazon Cognito, federated to the HR system of record |
| Agent workload identity | EKS Pod Identity or ECS task roles; signing keys in AWS KMS |
| Grant exchange and gateway | ECS Fargate behind an ALB, in a private VPC; the EHR MCP server reachable only from the gateway |
| Policy | Amazon Verified Permissions (Cedar) |
| Revocation list and care teams | DynamoDB, with Streams for fan-out |
| Audit | CloudWatch Logs to S3 with Object Lock |
| Clinical data | AWS HealthLake (FHIR) |

Before any real PHI is handled, the hospice needs a Business Associate Addendum with AWS, and must use only HIPAA-eligible services. Check the current list.

## Risks to flag before judging

- **Companion safety and scope.**
  - The companion is not a clinician. It must route anything urgent to the hospice 24-hour line; the prompt says so, but that needs clinical review.
  - Its view is deliberately narrower than the patient's full HIPAA right of access. Full records belong in the patient portal.
  - If caregivers or shared household devices use the companion, you need a policy for who may know the PIN.
- **Prompt injection from patient devices.** Labelling patient text as untrusted is a mitigation, not a guarantee. The real protection is that the orchestrator's tools and care-team limits still apply whatever the model is persuaded to try.
- **Live model variability.** Claude may call tools in a different order, or skip one, from run to run, and Bedrock can be throttled or slow. Rehearse with the exact request you will use, and keep Replay one click away.
- **Live mode was tested against a stub, not real Bedrock.** The stub checks the request shape: tool-name format, schema wrapping, and thinking blocks replayed unchanged. Run the preflight check and one full live rehearsal in your own account before the demo.
- **Demo secrets.** Demo passwords and TOTP secrets are written to `.hospiceprint/` so a second process can run. The admin key is in the console URL. Production uses SSO for the console and never stores secrets on disk.
- **In-memory state.** Revocations, sessions and care teams live in one process. Production needs the DynamoDB-backed versions.
- **Mock verification sources.** License, exclusion, background and training checks are mocks. Real integrations (state boards or Nursys, OIG LEIE and SAM files, a background-check vendor, the LMS) each have their own terms and matching rules. In particular, the nightly exclusion sweep matches on name only; real screening matches on name plus date of birth or NPI.
- **Rules are simplified.** Part 2 consent, family sharing and break-glass are modeled as single checks. Real policies (state law, the 2024 Part 2 final rule, a patient's objections) need review by the hospice's privacy and compliance officers.
- **Self-reported manifest.** The agent's print inputs are signed by its workload key, but they come from the agent itself. A stronger version would take them from the deployment pipeline.
