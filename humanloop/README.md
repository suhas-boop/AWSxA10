# HumanLoop senior voice view

The animated senior conversation screen from `humanloop-ui`, connected to the CareAlong voice pipeline in `../humanloop-backend`. After resident sign-in, the app opens directly to the voice companion. The nurse/care-team view is deferred.

The browser uses the backend's tested audio capture/resampling, playback and local sound detector. The authenticated `/ws` connection carries real Nova 2 Sonic speech and transcripts. Consent, run heartbeats, explicit stop, interruption and reconnect follow the existing backend protocol. Care requests require the resident's explicit review and confirmation; statuses come from persisted records.

## Run locally

Node 24 and AWS CLI are required. Use the authorized workshop credentials in the backend terminal. AWS credentials never go in the frontend environment.

From the repository root:

```sh
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

Sign in with a resident identity such as Margaret. In the backend directory, `npm run password -- margaret` copies that local demonstration password. Staff accounts do not open the senior view. Enable the check-in consent checkbox, then press **Start voice** and allow microphone access.

## Scope and behavior

- Only explicit start activates the microphone; End check-in releases capture and closes the server run. Unmounting the screen also stops capture.
- Captions update by content ID, automatically follow new speech, and allow scrolling back. Reconnect preserves the current run and transcript.
- Typing records a structured check-in response; it is not a separate LLM text chat. It does not silently inject text into a Nova audio stream.
- The local sound detector produces tentative observations, not confirmed patient symptoms.
- Preparing a care request does not send it. The resident reviews the quoted statements and recipient, then confirms sharing. A displayed receipt means a stored request exists, not that a nurse is on the way.
- The former UI branch's standalone voice server, browser speech fallback, photo features, home/routine pages and nurse mock are retained as source history but are not wired into this senior experience. Run the scripts above; do not start `server/index.js` for this integration.
- Existing synthetic demo scenarios are unchanged. New scenario behavior must be specified separately.

## Verification

`npm run build` prepares the pinned sound model and shared worker assets, checks TypeScript, and builds the UI. Backend regression tests run with `npm --prefix ../humanloop-backend test`.

From the backend directory, `node scripts/senior-ui-check.mjs` exercises the compiled senior UI with real Cognito, DynamoDB and Bedrock using prerecorded generated speech through Chromium's microphone API. It uses Daniel, creates a synthetic run, and stops it afterward. Chrome and the macOS `say`/`afconvert` utilities are required. Reports, audio fixtures and screenshots stay in ignored `data/`; generated speech is not a real-human microphone validation.

## Daily conversation and the two profiles

Pressing Start voice triggers a model-generated greeting after microphone capture begins. The agent opens casually instead of waiting for a spoken hello. The greeting is an application event, not a fabricated resident statement, and is not replayed after reconnect.

A resident's optional `daily_checkin` plan is read through the same authenticated, resident-scoped context tool. It carries a version and an ordered list of required/optional questions, each tied to the supplied condition. The model is instructed to spend the opening exchanges in casual conversation, then work unanswered questions into the discussion one at a time, recognizing natural answers from the conversation. An explicit urgent concern takes priority over the planned conversation. This is conversational pacing, not a deterministic certification that every clinical criterion has been assessed.

Two empty profile slots are provided in `../humanloop-backend/config/patient-profiles.example.json`. No disease-specific question set has been loaded into the live records yet. Populate the profiles and supplied question sets later; the app will not invent required clinical questions from a disease name alone. Question examples and import instructions are in the backend README. The daily check-in starts when the resident opens a session; background scheduling, notifications and unattended microphone activation are not implemented.

The model-first opening uses [Nova 2 Sonic cross-modal input](https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-cross-modal.html). Ordinary typed answers still update the structured check-in only; they are not sent as live text conversation to Sonic.
