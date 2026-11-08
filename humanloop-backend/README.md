# CareAlong voice backend

The CareAlong voice backend and its reference web interface: a local senior-care coordination demonstration built from `CareAlong_PRD.docx`: React/TypeScript, Amazon Nova 2 Sonic, local MediaPipe YAMNet, a Node backend, a private MCP gateway, real Cognito identities, and DynamoDB.

**Run on the demonstration Mac with synthetic residents only.** This implementation does not diagnose, change medication, send family messages, call emergency services, or contact a pharmacy. Clinical pathways are versioned, unreviewed demonstration rules. See [VERIFICATION.md](VERIFICATION.md) for executed checks and the remaining human/clinical release gates.

## Start

This backend uses the original AgenticPrint core in `../hospiceprint` and the resident/staff UI in `../humanloop`. Keep the repository layout intact. See `../humanloop/README.md` for the integrated interface.

Node 24, Python 3.13 (or modern Python with OpenSSL/scrypt support), and AWS CLI are required. In the **same terminal** that will start the backend, export fresh Workshop Studio temporary credentials for account **389415889552**, region **us-east-1**. Keep the session token as well as the access and secret keys. Do not use the unrelated default AWS account. Startup verifies the account and stops on a mismatch.

```sh
git clone --branch humanloop-backend https://github.com/suhas-boop/AWSxA10.git
cd AWSxA10/humanloop-backend
npm ci
python3.13 -m venv ../.venv-agentprint
../.venv-agentprint/bin/python -m pip install -r ../requirements-agentprint.txt
npm --prefix ../humanloop ci
# Only on a new checkout, if .env does not already exist:
cp -n .env.example .env
npm run preflight
# Existing cloud configuration is reused; this creates resources only when missing:
npm run provision
npm --prefix ../humanloop run build
npm start
```

Open **http://127.0.0.1:8080**. Development mode is `npm run dev`, with the browser on **http://127.0.0.1:5173**. `npm start` serves both the compiled UI and the API; a second frontend server is unnecessary.

The existing ignored `.carealong-cloud.json` records the provisioned Cognito pool, clients, domain, and DynamoDB table. `.carealong-secrets.json` contains the separate demo passwords and confidential machine-client secret, with filesystem mode 0600. AWS credentials remain in the backend process environment; they are not stored in these files or delivered to the browser. Nova's bidirectional connection uses AWS credentials, not a separate Bedrock API key.

### Sign in

Choose the desired identity on the sign-in page. To copy **only that identity's password** to the Mac clipboard:

```sh
npm run password -- margaret
```

Paste into the password field. Use `sam` and `admin` in separate browser tabs for the nurse and administrator. Each tab holds its own Cognito access token in sessionStorage.

| Identity | Role and fixture |
| --- | --- |
| margaret | Primary resident; synthetic heart-failure context; assigned nurse Sam |
| daniel | Separate resident; isolation/authorization checks; assigned nurse Lee |
| robert | Head-injury fixture; synthetic apixaban record; assigned nurse Sam |
| grace | Pharmacy-access fixture; caregiver Carla and nurse Sam |
| sam / lee | Separate nurses with current assigned-resident membership |
| carla | Authorized pickup caregiver for the configured residents |
| admin | Grants, run controls and sanitized receipts; no clinical-record access |

## Demonstrate

1. Sign in as Margaret, review consent, and start a voice check-in. Allow the microphone. Headphones reduce acoustic feedback. Audio input is captured once, resampled to signed 16-bit mono PCM at 16 kHz, and fanned out to Nova and the local detector; Nova playback is 24 kHz.
2. Discuss the day. A detected cough is shown separately as a **possible sound**, never as fabricated speech. Confirm whether it was yours, whether it is new/worse, and whether severe breathing difficulty is present. You can type or use the answer buttons; those update the workflow directly. Typed-only mode uses the same controller without a microphone or a separate text LLM.
3. The named `get_checkin_context` tool supplies the authorized record, evidence and next question to Sonic before a response. Observations update server state; they are not unsolicited tool results. Typed workflow questions appear on screen; they are not synthesized speech.
4. Prepare a care-team request, review the exact content and recipient, then confirm or decline. The confirmation button is authoritative; the model cannot consent for you. "Ask about my care" makes a real authorized context request.
5. As Sam, acknowledge the **new matching task**, then save a callback/next step (or request clarification). Margaret sees that person's stored action through authenticated live updates. Acknowledgment is not resolution. Only assigned staff can act; nurse review can resolve the concern.
6. As admin, select the current Margaret run, revoke `get_checkin_context`, and select **Test next context request**. The actual MCP call returns `GRANT_REVOKED`; no clinical payload is shown to admin. Existing care tasks remain.
7. Stop the check-in. Local capture, detector and playback stop immediately; the UI stays in STOPPING until server confirmation. A missing heartbeat expires authorization in eight seconds. A new check-in creates a new explicitly consented run and new grants.

Counterexample: deny a detected sound with “No, that was the TV.” No patient symptom or care task is created for that incident. Use a fresh run for each independent scenario. Robert: “I fell and hit my head,” then confirm. Grace: “I could not get to the pharmacy,” then answer the pickup and supply questions. These are narrow scripted extraction rules; ambiguous wording prompts clarification, not a medical conclusion. Explicit personal severe-breathing/chest-pain wording takes the emergency demonstration route without waiting for optional context or sharing approval.

## Enforcement and state

- Human Cognito access tokens are verified for signature, issuer, expiry, token_use and client_id. Each request/stream update also checks the active server login and current membership. The agent has a **different** confidential Cognito client-credentials identity with four custom tool scopes.
- Every private MCP connection is bound to a server-held random run capability and one resident. Tools have strict JSON schemas: `get_checkin_context`, `propose_follow_up`, `create_review_task`, `get_review_status`. No public MCP endpoint, arbitrary shell/API tool, or browser-supplied resident override exists.
- The gateway checks machine scope, run state/expiry/heartbeat, human login, membership, consent, grant version and resource scope before access. Run locks serialize local actions and revocation. DynamoDB reads use strong consistency.
- Task creation is one conditional transaction checking current run/grant/login/member/consent/recipient, draft, incident and unexpired single-use confirmation. It consumes confirmation, records the request ID and creates the task atomically. Request lookup reconciles uncertain writes. A retry does not create another task.
- Revocation commits before success is returned. It cannot erase context already returned. This is an application gateway boundary, not process isolation or an AgentCore Harness claim. A stopped server loses its in-memory run capabilities; old tasks persist, but start a new run after restart.
- Observed, reported, recorded and inferred evidence have separate types and provenance. Short answers retain their question. Corrections link to original evidence, invalidate drafts and flag already-created tasks. A clinical concern and its human task have independent state.
- No raw microphone audio is retained by the app. Derived synthetic evidence/tasks are kept in DynamoDB until explicitly reset. Captions/recent conversation context live in browser/process memory for session continuation. Optional engineering fixtures and silent browser videos under `data/` are labeled separately; they are not human recordings.

## Checks and artifacts

```sh
npm run verify         # syntax, TypeScript, offline tests, production bundle
npm run prepare:checks # optional macOS fixtures: 32 ESC-50 clips + synthetic speech
npm run test:live      # real Cognito/DynamoDB; writes synthetic tasks
npm run test:voice     # prerecorded speech through real Nova + required context tool
npm run test:voice -- --interrupt
npm run test:browser   # real roles + Chromium fake microphone; default dev URL
npm run test:acoustic  # local classifier on development/held-out clips; needs Vite
```

Browser checks use installed Google Chrome. Override `CHROME_PATH` if needed. Silent rehearsal-video recording needs `npx playwright install ffmpeg`. For production-browser checks set `CAREALONG_URL=http://127.0.0.1:8080`. Do not run multiple checks against the same resident concurrently: starting a new resident run intentionally stops the prior one. Live tests create synthetic records and use AWS resources.

The indirect-answer regression is `node scripts/conversation-check.mjs --breathing-answer`: generated speech says “I have a cough,” “It’s new,” then “Not severe but a little bit uncomfortable,” and asserts the controller advances to review while retaining the exact reported concern. Its report is `data/breathing-answer-check.json`.

A sustained voice regression is `node scripts/conversation-check.mjs`: six generated spoken exchanges, followed by a reconnect and a seventh exchange against real Bedrock (uses Daniel). `node scripts/captions-check.mjs` separately tests caption scrolling and the reconnect control with mocked voice events in the compiled browser UI (uses Robert).

Reports are in `data/conversation-check.json`, `data/captions-check.json`, `data/live-check.json`, `data/voice-check.json`, `data/voice-interruption-check.json`, `data/browser-check.json`, and `data/acoustic-check.json`. Screenshots are in `data/screenshots/`; silent browser backups are in `data/rehearsal/`. Test audio source/clip hashes/license are recorded under `data/acoustic/`. The browser fixture deliberately uses known positive `2-123896-A-24.wav` from the original evaluation; it is not an unseen human microphone demonstration.

The detector threshold is frozen in `config/acoustic.json`; `npm run prepare:audio` copies it into the bundled model manifest. The small evaluation is **not** clinical calibration. Some development coughs are missed. Detection silence, a score below threshold, or an unavailable detector must never be interpreted as wellness. A real-person microphone rehearsal, independent people and room/TV/playback/throat-clearing tests, clinical review and a staffed response workflow remain prerequisites for use beyond this synthetic demonstration.

## Reset and troubleshooting

`npm run reset` is a **dry run** listing the count of synthetic rows that would be removed. To deliberately delete demo sessions, logins, evidence, grants, receipts and tasks, stop the backend first, then run:

```sh
npm run reset -- --confirm-synthetic-reset
npm start
```

Resident fixtures, assignments, Cognito users/passwords and cloud resources remain. Everyone must sign in again. The reset refuses the wrong AWS account/table or a running local backend. It does not delete the provisioned Cognito pool/table/domain.

- Wrong AWS account: export fresh workshop credentials in the **backend terminal**. Exports in another terminal do not carry over. Restart the backend after refreshing credentials.
- Expired AWS credentials: Cognito sign-in may still work, but protected AWS operations fail. Refresh/restart; never bypass the account guard.
- npm EACCES: `npm ci --cache ./.npm-cache`. The project `.npmrc` uses a local cache; no sudo is needed.
- Voice becomes quiet during a session: use **Reconnect voice**, wait for Listening, then repeat the last sentence. This renews the Bedrock stream within the existing check-in and preserves care requests. Captions follow new messages automatically; scrolling upward pauses following, and **Jump to latest captions** resumes it. After a backend update, refresh the page and start a new check-in.
- Voice/microphone/detector failure: stop, then start a typed check-in or choose human help. The interface must not claim active acoustic analysis when unavailable.
- Server restart/lost heartbeat: start a new check-in. A previously created nurse task survives.
- UNKNOWN task result: check the original request status before retrying. The original request ID remains the reconciliation key.
- Remote access requires HTTPS/WSS and deliberate origin configuration. This deliverable runs on localhost. No AgentCore deployment has been performed. The Dockerfile is a packaging option, not a verified cloud deployment; mount both ignored configuration files read-only and inject AWS credentials at runtime.

## Implementation map and sources

`web/care.tsx` contains the role views; `web/audio.mjs` and the worklet handle capture/playback; `web/detector*` run local YAMNet. `server/care/index.mjs` is the current server entry point. `identity.mjs`, `service.mjs`, `workflow.mjs`, `mcp.mjs`, `rules.mjs`, and `store.mjs` separate authentication, authorization, workflow, tools, demo rules, and persistence. `server/session.mjs` and `protocol.mjs` implement the shared Nova transport and renewal. The original starter files remain for reference/tests but are not the CareAlong entry point.

- [AWS Nova Sonic input events](https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-input-events.html) and [tool configuration](https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-tool-configuration.html).
- [Google MediaPipe Audio Classifier](https://developers.google.com/edge/mediapipe/solutions/audio/audio_classifier?tab=Web).
- [ESC-50 recordings and license](https://github.com/karolpiczak/ESC-50). Engineering fixtures are downloaded separately and are not bundled into the application.
- [AHA heart-failure changes to report](https://www.heart.org/en/health-topics/heart-failure/living-with-heart-failure-and-managing-advanced-hf/physical-changes-to-report-for-heart-failure), [NICE head-injury guidance](https://www.nice.org.uk/guidance/ng232/chapter/recommendations), and [CDC head-injury danger signs](https://www.cdc.gov/traumatic-brain-injury/signs-symptoms/). These references motivate demo wording; they do not validate this software clinically.

## Repository contents

AWS credentials, Cognito configuration and passwords, generated audio/model binaries, dependencies, build output, transcripts, logs, screenshots and local test reports are excluded from Git. `npm run provision` creates the ignored cloud configuration and demo secrets for an authorized account; `npm run prepare:audio` downloads the checksum-verified model and copies the installed audio runtime. `VERIFICATION.md` describes checks performed in the original local workspace; its `data/` references are local artifacts, not files included in this repository.

## Import or update patient profiles

The integrated senior view is in `../humanloop`. Copy `config/patient-profiles.example.json` to the ignored `.carealong-patient-profiles.json`. The template slots bind to Margaret and Robert, whose supplied fictional profiles are Maggie and Bob. `null` name/conditions leave existing values untouched. Keep private patient imports ignored; the explicitly fictional demo profiles in `config/` contain no real patient records or credentials.

Each supplied question has this shape (this illustrates the schema, not a disease-specific care protocol):

```json
{
  "id": "daily-experience",
  "condition": "Condition from the supplied profile",
  "question": "Question from the supplied check-in plan",
  "required": true
}
```

Set the plan's `enabled` to `true` only after adding its questions and a version. Import using the authorized backend AWS credentials:

```sh
node scripts/apply-patient-profiles.mjs .carealong-patient-profiles.json
```

Start a fresh check-in after importing profiles. The importer validates the schema and existing resident IDs, checks the account, and atomically updates the bound profile records. The context tool reads only the current resident's plan and rechecks permission. Importing alone does not create tasks. Ordinary handoffs retain human confirmation; the two explicit synthetic heart-failure care plans authorize automatic simulated alerts during a check-in. Empty/invalid plans are treated as unconfigured; no required disease questions are manufactured. The current daily question pacing uses the model's session history; it is not a formal scored questionnaire or a persisted daily-completion report.

## Supplied Maggie and Bob demo profiles

The senior experience now supports the two user-supplied fictional heart-failure profiles, separate baseline versus reported/recorded evidence, simulated nurse alerts, and emergency-priority routing. Follow [DEMO-SCENARIOS.md](config/DEMO-SCENARIOS.md) for profile imports, spoken examples, recorded-weight scenario controls and test commands. These demo alerts use the existing protected MCP gateway and never send real notifications or place calls. The HumanLoop staff portal now displays assigned nurse alerts alongside a separate everyday-companion request workflow.

## HumanLoop AgentPrint integration

Use the integrated `../humanloop` build/start instructions for the current resident and staff UI. The original `web/care.tsx` screens are legacy; they do not implement the new portal snapshot contract.

`server/care/agentprint.mjs` starts the private `hospiceprint.humanloop_bridge` process. The backend first verifies Cognito authentication, current membership and run binding. The adapter then uses the original workload registry/attestation, ES256 grant service, Ed25519 request proof, MCP gateway, policy engine and hash-chained audit implementation. Each resident has separate everyday and clinical workload identities. The print covers the registered model, instructions, tool names and signing key. This is backend workload identity, **not tablet hardware attestation**. The Cognito adapter does not claim to reproduce the original Python demo’s staff MFA or device-PIN ceremony.

Install `../requirements-agentprint.txt` into `../.venv-agentprint`, or set `AGENTPRINT_PYTHON` to a prepared interpreter. Private workload keys persist in ignored `.carealong-agentprint-keys.json` with mode 0600. Do not publish that file. Grants and the bridge audit chain are process-local; sanitized decision receipts are persisted in DynamoDB. These receipts do not constitute a cross-restart immutable audit service.

`portal.mjs` reads current server-side policy and synthetic consent on every action, and checks the same versions in the DynamoDB transaction before returning data or saving an effect. Disabling a capability invalidates the next action even under an existing grant. Social runs have no clinical grants. Help creation requires a bounded exact excerpt of current resident speech and explicit request wording; ambiguous or negated language requires clarification. Assigned staff reply through authenticated endpoints, and the live voice session fetches saved replies after a content-free application notification. Admins cannot see request excerpts or clinical records through this portal.

The new staff endpoints support preferences, approved activity reminders, request acknowledgment/reply, capability changes and pause. Activity schedule editing, full staff administration, physical-device management and production deployment are not implemented by this demo.

The integrated container build uses the repository root as context: `docker build -f humanloop-backend/Dockerfile -t humanloop .`. It includes the Python bridge and compiled HumanLoop UI. The local Docker daemon was unavailable during this integration, so this updated container recipe has not been built here. Mount cloud configuration and demo secrets at runtime, keep workload keys private and persistent, and configure allowed browser origins. Container packaging is separate from an AgentCore deployment.
