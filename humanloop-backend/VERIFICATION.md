# CareAlong verification — November 7, 2026 (Pacific)

This is a completed local **synthetic demonstration build**, not a clinically validated care service. The source fingerprint, environment and frontend artifact hash are in `data/build-manifest.json`. AWS account: `389415889552`; region: `us-east-1`. No AgentCore/remote deployment is claimed.

Local evidence note: the referenced `data/` files, recordings, screenshots and build manifest are intentionally excluded from Git. These results describe the original local workspace and do not claim that a fresh checkout has already passed live AWS checks.

## Executed

| Check | Evidence and result |
| --- | --- |
| Static and production checks | `npm run verify`: syntax, TypeScript, **43/43 offline tests**, Vite production build passed; earlier baseline output in `data/offline-check.txt`, current checks in `data/repetition-offline-check.txt`. |
| AWS identity | STS verified the workshop `WSParticipantRole/Participant`, not the unrelated default account. |
| Real identity and persistence | Eight separate Cognito human identities; confidential OAuth machine identity with custom tool scopes; actual DynamoDB conditional transactions and strongly consistent queries. |
| Primary workflow | Five consecutive fresh-run journeys: observation fixture, source/newness/breathing answers, authorized context, resident confirmation, one assigned task, nurse acknowledgment and next step, persistence after stop. Controller observations here are injected test data; see browser/audio checks separately. |
| Other live boundaries | TV-source denial, wrong resident, wrong human owner, revoked MCP access, admin privacy, emergency-before-chart, urgent head-injury context, declined sharing, separate pharmacy/caregiver+nurse tasks, heartbeat expiry and logout denial. `data/live-check.json`. |
| Real Bedrock speech | Prerecorded macOS synthetic voice sent as PCM through the actual WebSocket and Nova 2 Sonic; returned final captions, spoken audio and successful required context-tool calls. `data/voice-check.json`. |
| Live interruption | Second prerecorded utterance interrupted the real Bedrock response: **1 interruption**, **2 successful context calls**, continued output, no reported error. `data/voice-interruption-check.json`. Offline tests also verify clearing queued playback and suppressing late interrupted audio. |
| Production browser journey | Chrome, compiled UI on port 8080, separate resident/nurse/admin sessions. A prerecorded known-positive cough passes through the browser microphone API, AudioWorklet and actual YAMNet worker; the authenticated observation triggers the source question. Confirmed the exact newly-created task ID, authenticated staff acknowledgment/next-step propagation, revocation and stop. `data/browser-check.json`. |
| Browser layout and accessibility smoke | Keyboard dismissal/focus behavior for help, visible controls, 390px layout and 200% layout zoom without horizontal overflow; no page errors in the recorded run. This is not a full assistive-technology audit. |
| Stop race | Browser check stopping the detector while its asset fetch is pending: no worker starts afterward. |
| Secret exclusion | Scanned eight text assets in the production bundle against all local demo passwords and the confidential machine secret: **0 matches**. Secret file mode verified as 0600. |

The synthetic staff actions were executed by automated tests using separate Cognito staff identities; no real nurse or patient participated in testing.

Initial live verification found a DynamoDB empty-sort-prefix query bug; it was fixed and regression-tested. Other fixes cover consumed-draft visibility, fresh heartbeat versus expiry races, logout-bound agent permission, ambiguity in short answers, evidence ordering/question provenance, stop during startup, and exact task matching in browser assertions. Failed attempts were not counted as successful rehearsals.

## Voice stall correction

The reported multi-turn stall was reproduced. Nova reused one completion ID across successive spoken turns. The old interruption handler blacklisted that completion ID, suppressing subsequent replies. It now retires only interrupted audio content IDs; delayed chunks are suppressed while later turns using the same completion ID remain playable. Regression tests cover repeated interruptions and delayed first chunks. The transcript panel now follows new captions, respects manual scrolling, and offers Jump to latest captions. Reconnect voice renews the authenticated stream within the same run, preserving history and care requests.

After the fix, `data/conversation-check.json` records **7/7 generated spoken exchanges against real Bedrock**, including six before a manual reconnect and one afterward, with audio and final captions for every exchange and no reported errors. Three model interruptions occurred before reconnect; the reconnect adds one playback-clear event. This is a synthetic replay, not a real-person microphone check. The prior failing replay remains in `data/conversation-before-fix.json`; metadata-only before/after traces are `data/voice-trace.log` and `data/voice-trace-fixed.log`.

`data/captions-check.json` separately verifies 18 continuing caption blocks, preserved manual scrolling, Jump to latest, and the reconnect control in the compiled UI using mocked voice events. It does not establish real microphone or Bedrock behavior. All 38 offline tests, syntax checks, TypeScript and the production build passed after the fix. Manual reconnect was tested live; the full-duration automatic renewal release gate below remains open.

## Repeated breathing question correction

The recorded answer “not severe but a little bit uncomfortable” did not match the original yes/no extractor, leaving the breathing question open. Protocol v3 adds bounded, phase-specific natural-language answers: this phrase denies severe difficulty while preserving the full discomfort statement as reported evidence. Incomplete, uncertain, contradictory and third-party phrases remain unconfirmed; explicit emergency reports retain precedence. After an unsuccessful clarification, a second unclear reply switches to answer controls or human help rather than another spoken clinical question. A later clear answer can still advance. The context tool now distinguishes approved clinical questions, answer controls and ordinary conversation so it does not force repeated daily-opening questions.

`data/breathing-answer-check.json` records a real Bedrock replay of three generated utterances: “I have a cough,” “It's new,” and the exact indirect answer. Controller phases advanced new → breathing → ready. The spoken reply offered care-team review and retained the slight breathing discomfort; it did not repeat the breathing question. No task was automatically created by accepting the answer. This is generated speech, not a person speaking into the Mac. All **43 offline tests**, syntax, TypeScript and the production build passed (`data/repetition-offline-check.txt`). Tests also cover uncertainty, incomplete answers, emergency precedence, duplicate turn handling, preserved quotations and recovery through answer controls.

## HumanLoop senior view integration

The `humanloop-ui` screen is now connected to the authenticated backend in `../humanloop`, with resident-only entry directly into the animated voice companion. The nurse/care-team UI is deferred. The compiled production UI passed `scripts/senior-ui-check.mjs`: actual Cognito sign-in, continuous fake-microphone PCM through the shared AudioWorklet, a real Bedrock greeting before resident input, four generated spoken exchanges including the indirect breathing answer, reconnect with resumed speech/captions, zero live microphone tracks after stop, and a 390px layout without horizontal overflow. No page or stream errors were reported. Evidence is local in `data/senior-ui-check.json` and `data/screenshots/humanloop-senior-*.png`; this remains generated speech, not a real-human microphone check.

`scripts/senior-ui-boundaries.mjs` separately passed with mocked API/voice events: cancelling a delayed start closes capture and stops the late-created run; partial/final transcript events replace by ID; interruption clears playback while later audio can play; reconnect clears its notice; disconnect stops capture without scripted fallback. Its report is `data/senior-ui-boundaries.json`.

The model-first greeting exposed a history-renewal failure: history could start with assistant speech. Renewal now prepends a labeled application context entry and groups adjacent same-role blocks for Bedrock, leaving the resident transcript unchanged. The failing run is retained in `data/senior-ui-check-before-history-fix.json`; the final live reconnect passed. An earlier overly-specific wording assertion is retained in `data/senior-ui-check-first-greeting-run.json`; final checks assert the handoff response and preserved evidence without demanding one exact phrase.

All **49 backend tests** passed after these changes (`data/integrated-offline-tests.txt`). TypeScript and production builds passed for both applications; JavaScript syntax checks passed. The optional per-resident daily question-plan schema and importer are implemented and tested for validation, pacing, resident separation and revocation. **No disease-specific plans have been loaded into live profiles**: the two profile slots await supplied data and question sets. Model-led question pacing is not a formal completion/scoring engine; background scheduling and unattended microphone activation are not implemented. New live clinical-plan scenarios must be tested after the profiles are populated.

## Acoustic engineering smoke set

Model: bundled YAMNet float32/1; model SHA-256 is in `public/models/manifest.json`. Runtime 1.2.2; 16 kHz PCM, 975 ms windows, 480 ms hop. The threshold was chosen from `[0.35, 0.50, 0.65, 0.80]` on **16 development clips**, prioritizing fewer non-cough false positives, and frozen at **0.80 before processing 16 held-out clips**. These are source-recording-separated ESC-50 folds, not verified independent people.

- Development: **3 of 4 cough clips missed** at the selected threshold. This is a significant detection limitation.
- Held-out: **0 of 4 cough clips missed**. The difference illustrates the instability of such a tiny sample; it does not establish sensitivity.
- Held-out negatives: 4 laughter, 4 breathing, 4 sneezing clips; **60 seconds total**, **0 merged cough events (0/min in this small sample)**.
- Misses are **clip-level**, not individual-event misses: cough event boundaries were not annotated. No population accuracy/confidence claim is supported.
- Browser rehearsal uses declared known evaluation positive `2-123896-A-24.wav`, mixed with synthetic speech and silence. It is not an unseen real-human cough. Captured microphone data is not replaced by a hidden UI trigger.

One subsequent browser replay of development clip `1-52266-A-24.wav` produced no observation at threshold 0.80. That failure is retained in `data/browser-check-missed-cough.json`. The final deterministic workflow rehearsal uses known evaluation positive `2-123896-A-24.wav` instead; it does not add a new held-out success or establish general microphone accuracy.

`data/acoustic-check.json` contains every evaluated window and score; `data/acoustic/manifest.json` contains sources/hashes/license; `data/acoustic/threshold-freeze.json` records the development decision. ESC-50 fixtures are optional local evaluation inputs, not bundled app audio.

## Performance samples

These measurements are small local engineering samples, not guarantees. The pre-optimization live API run had context median 899 ms (n=8), candidate observation median 471 ms (n=11), confirmation median 1,385 ms (n=7), and next-step write median 277 ms (n=5). These numbers exclude the browser's subsequent rendering/polling.

The first exact-task production browser measurement was **3,426 ms** from sharing click to the matching nurse task becoming visible, above the proposed two-second target. Next-step save to senior visibility was **1,911 ms**, n=1 each. Independent authorization reads were then parallelized, redundant ownership reads removed, and SSE polling shortened. The final post-change production browser run measured **1,954 ms** from sharing to the exact nurse task, and **1,460 ms** from saving a next step to senior visibility (n=1 each; `data/browser-check.json`). These are single-run measurements, not a latency guarantee.

Real speech smoke: first returned audio was **2,118 ms after prerecorded input finished** in the ordinary test and **2,620 ms** in the interruption test (n=1 each). These measure backend arrival, not sound reaching a person's ear. Full eight-minute renewal was not timed live; renewal/history/cancellation paths are covered by offline protocol tests.

Final optimized live API rehearsal (2026-11-08T01:29:07.765Z): context: median 719 ms, p95 731 ms, n=8; observations: median 357 ms, p95 511 ms, n=11; confirm: median 954 ms, p95 1289 ms, n=7; next-step: median 291 ms, p95 301 ms, n=5. Five primary runs and the separate boundary/fixture checks passed on this build. These API timings exclude rendering.

## Explicit remaining release gates

- A person speaking/coughing into the actual demonstration Mac microphone, verifying intelligibility, echo cancellation, interruption feel, the chosen microphone and local sound conditions. Chromium's fake microphone is not a substitute for this check.
- Held-out recordings from independently verified people, real TV audio, throat clearing, assistant loudspeaker playback/echo, and room noise. The implemented detector is demonstrably fallible; missing detections never imply wellness.
- Full-duration real-service renewal, induced network/write timeout recovery against AWS, concurrency across multiple backend processes, and a full accessibility audit. Unit tests cover several of these code paths but do not establish live operational reliability.
- Clinician-owned routing/wording and a real staffed response/escalation policy before actual care use. No automated timed staff escalation, emergency dispatch, pharmacy transaction, prescription or family message is implemented or claimed.
- Docker packaging has been updated but not built/deployed here. The reset dry run succeeded against the configured account/table (651 synthetic rows at that moment); destructive reset was deliberately not executed against the accumulated verification records.

## Handoff artifacts

- Startup, password-copy helper, role walkthrough and deliberate reset: [README.md](README.md).
- Screenshots: `data/screenshots/login.png`, `senior.png`, `handoff.png`, `nurse.png`, `admin.png`, `mobile.png`, `zoom200.png`.
- Silent browser video backups: `data/rehearsal/*.webm`. These show automated browser interaction with synthetic identities and prerecorded audio input, not a real human clinical session; they contain no captured microphone track.
- Live AWS and synthetic tasks remain available in the configured table. Starting a new check-in stops any prior active run for that resident. Existing tasks intentionally survive.
