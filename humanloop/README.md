# HumanLoop resident and staff views

The animated senior conversation screen from `humanloop-ui`, connected to the CareAlong voice pipeline in `../humanloop-backend`. After resident sign-in, the app opens directly to the voice companion. Staff sign-in opens the assigned caregiver portal or the administrator permissions view. Both use real backend data.

The browser uses the backend's tested audio capture/resampling, playback and local sound detector. The authenticated `/ws` connection carries real Nova 2 Sonic speech and transcripts. Consent, run heartbeats, explicit stop, interruption and reconnect follow the existing backend protocol. Care requests require the resident's explicit review and confirmation; statuses come from persisted records.

## Run locally

Node 24, Python 3.13 (or a modern Python with OpenSSL/scrypt support), and AWS CLI are required. Use the authorized workshop credentials in the backend terminal. AWS credentials never go in the frontend environment.

From the repository root:

```sh
python3.13 -m venv .venv-agentprint
.venv-agentprint/bin/python -m pip install -r requirements-agentprint.txt
npm --prefix humanloop-backend ci
npm --prefix humanloop ci
```

Follow `../humanloop-backend/README.md` to provision a new environment. Existing installations reuse the ignored `.carealong-cloud.json` and `.carealong-secrets.json` in the backend directory; these files and AWS credentials are not published in Git.

To serve the compiled UI and backend together on **http://127.0.0.1:8080**:

```sh
cd humanloop
npm run build
npm start
```

To develop the UI, keep the backend running on port 8080, then run `npm run dev` in this directory. Vite on **http://127.0.0.1:5173** proxies `/api` and authenticated `/ws` to the backend.

Sign in with a resident identity such as Margaret. In the backend directory, `npm run password -- margaret` copies that local demonstration password. Staff accounts do not open the senior view. Tap the companion to start the check-in with local sound analysis, and allow microphone access. Tap it again to stop. The senior view has no bottom control panel.

## Scope and behavior

- Only explicit start activates the microphone; End check-in releases capture and closes the server run. Unmounting the screen also stops capture.
- Captions update by content ID, automatically follow new speech, and allow scrolling back. Reconnect preserves the current run and transcript.
- The companion itself is the accessible start/stop control. The bottom toolbar, typed composer and jump-to-latest button are removed; captions remain scrollable.
- The local sound detector produces tentative observations, not confirmed patient symptoms.
- Ordinary care requests require resident review and confirmation. Maggie and Bob have explicit fictional care plans that automatically create simulated inbox alerts for reported changes. Receipts are labeled simulated and never imply a real call or a nurse on the way.
- The former UI branch's standalone voice server, browser speech fallback, photo features, home/routine pages and nurse mock are retained as source history but are not wired into this senior experience. Run the scripts above; do not start `server/index.js` for this integration.
- Maggie and Bob use the supplied heart-failure scenarios. The other synthetic residents retain their existing paths.

## Verification

`npm run build` prepares the pinned sound model and shared worker assets, checks TypeScript, and builds the UI. Backend regression tests run with `npm --prefix ../humanloop-backend test`.

From the backend directory, `node scripts/senior-ui-check.mjs` exercises the compiled senior UI with real Cognito, DynamoDB and Bedrock using prerecorded generated speech through Chromium's microphone API. It uses Daniel, creates a synthetic run, and stops it afterward. Chrome and the macOS `say`/`afconvert` utilities are required. Reports, audio fixtures and screenshots stay in ignored `data/`; generated speech is not a real-human microphone validation.

## Daily conversation and the two profiles

Tapping the companion to start voice triggers a model-generated greeting after microphone capture begins. The agent opens casually instead of waiting for a spoken hello. The greeting is an application event, not a fabricated resident statement, and is not replayed after reconnect.

A resident's optional `daily_checkin` plan is read through the same authenticated, resident-scoped context tool. It carries a version and an ordered list of required/optional questions, each tied to the supplied condition. The model is instructed to spend the opening exchanges in casual conversation, then work unanswered questions into the discussion one at a time, recognizing natural answers from the conversation. An explicit urgent concern takes priority over the planned conversation. This is conversational pacing, not a deterministic certification that every clinical criterion has been assessed.

Maggie (`margaret`) and Bob (`robert`) now have supplied profiles and disease-specific questions in `../humanloop-backend/config/maggie-demo.json` and `bob-demo.json`. See [demo scenarios](../humanloop-backend/config/DEMO-SCENARIOS.md) for profile loading, independent weight branches, simulated alerts and verification. Already captured cough onset and other recognized answers are removed from the remaining question list. Severe symptoms override casual pacing. The daily check-in starts when the resident taps the companion; background scheduling and unattended microphone activation are not implemented.

The model-first opening uses [Nova 2 Sonic cross-modal input](https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-cross-modal.html). The browser continues using the shared microphone and audio playback pipeline.

## Companion identity and the staff loop

- `http://127.0.0.1:8080/#/staff`: choose Sam for the assigned caregiver overview or Alex for **Permissions & activity**. Passwords remain in the ignored backend secrets file; use `npm run password -- sam` or `-- admin` from the backend directory.
- `http://127.0.0.1:8080/#/companion`: everyday companion conversation with shared activities, consent-filtered attendance, approved reminders and explicit caregiver requests. No clinical tool grants or local sound analysis in this workflow.
- `http://127.0.0.1:8080/`: existing disease-specific clinical check-in, with Maggie/Bob’s supplied fictional care plans.

For the live demo, use separate browser tabs (each has its own sessionStorage login). As Maggie, ask “Is Rose going to bingo tomorrow?”, then “Please ask a caregiver to help me get to bingo tomorrow.” In Sam’s staff inbox, write a reply. The active companion fetches and speaks the actual saved reply. In Alex’s portal, turn off **Check shared attendance** and ask the companion to check again. The next gateway call is denied, including when it reuses the same signed grant. Asking for another resident’s medical record or staff privileges produces a separate denied access decision. Pause stops active sessions and prevents new ones. Re-enable permissions after the demonstration.

The interface uses HumanLoop’s existing colors, typography and companion illustration. Identity is presented as who the companion serves, its role, permissions and recent decisions; model/prompt/tool hashes and the key fingerprint are expandable details. The activity feed contains authorization receipts, not full conversations or proof of business-action completion. Caregivers receive only their assigned residents’ explicit requests. A connection issue is labeled separately from a clinical alert. Administrative toggles cannot create resident consent.

Run `node scripts/portal-browser-check.mjs` and `node scripts/companion-voice-check.mjs` from `humanloop-backend` for real-login UI checks and the generated-speech demonstration respectively. These checks create fictional stored requests and policy audit entries; voice checks restore the initial attendance setting. No real notifications or emergency calls are sent.
