# Maggie and Bob: fictional heart-failure check-ins

These are user-supplied fictional profiles and engineering demonstration paths, not validated clinical protocols. The resident login keys remain `margaret` and `robert`; the companion addresses them as Maggie and Bob. Bob's imported profile replaces the old Robert clinical context in this local demo (including the old medication list). Daniel is not repurposed.

The senior UI stays voice-only: tap the companion to start or stop. The bottom toolbar stays removed. The agent opens casually using the authorized profile, then weaves in the supplied check-in questions. Explicit symptoms override casual pacing.

## Load profiles

Run from `humanloop-backend` with the hackathon account's temporary AWS credentials in the process environment:

```bash
node scripts/apply-patient-profiles.mjs config/maggie-demo.json
node scripts/apply-patient-profiles.mjs config/bob-demo.json
node scripts/demo-weight.mjs margaret baseline
node scripts/demo-weight.mjs robert baseline
```

All import scripts verify account `389415889552`. They preserve authentication credentials. Bob's medication-start date is recorded as 12 days before the profile import; it is not silently advanced each day. The weight command explicitly creates a fictional staff-recorded pair of readings, with timestamps and source references. This is not a real scale integration. Baseline weights are 150 lb and 172 lb.

## Maggie

Start with: “I've had this dry cough since yesterday. It woke me up a couple of times, but I'm sure it's nothing.”

Expected: recognize the reported new cough, create a simulated nurse inbox alert immediately, ask any unanswered onset/lying-down/other-change questions briefly, and avoid repeating an already supplied onset. Do not infer absence of breathlessness or chest pain unless Maggie says so.

Independent alternate turns:

- “It's happening more often, especially at night.” — update the cough report.
- “I used three pillows last night. One wasn't enough.” — prompt assessment now.
- “I had to stop on the way to breakfast to catch my breath.” — prompt assessment now.
- “Both my ankles look puffy today.” — prompt assessment now.
- “Tell Rose I'm skipping bingo. I'm too tired.” — supporting functional change, not a diagnosis or an automatic heart-failure escalation by itself.
- “I can't catch my breath even sitting still.” — immediate emergency guidance and simulated facility emergency activation. No routine questionnaire or waiting for acknowledgment.

To select the independent recorded-weight branch:

```bash
node scripts/demo-weight.mjs margaret weight-gain
```

The next spoken check-in turn can trigger assessment from the authorized 150 → 153.5 lb/24-hour recorded trend without waiting for additional symptoms. Restore `baseline` afterward. Saying “I weigh 153.5” is stored as resident-reported and never becomes a measured record. The 3 lb threshold is bounded to this fictional demo plan, not a universal or personalized clinical prescription.

## Bob

Start with: “This new pill is making me cough. I think I'll stop taking it tonight.”

Then: “The dry tickling cough started four days ago. No breathing difficulty or ankle swelling.”

Expected: acknowledge frustration, state that lisinopril can cause cough without confirming causation, advise against independent medication changes for this non-emergency concern, and send a simulated medication/symptom review request. The alert separates his quoted report from the dated medication record and stable recorded weight. It does not fabricate absent symptoms before Bob reports them.

Alternative worsening turns:

- “I'm getting breathless walking to breakfast.”
- “I need extra pillows to breathe comfortably.”
- “My ankles look swollen.”
- “My tongue is suddenly swelling.” / “My lips are suddenly swelling.” — emergency priority, even without breathing symptoms. Stop routine questions and medication counseling. Do not instruct continued dosing; defer medication decisions to emergency professionals.

Use `node scripts/demo-weight.mjs robert weight-gain` for the independent 172 → 175.5 lb recorded branch, then restore `baseline`.

## Delivery and care-team state

The existing permission-checked `propose_follow_up` MCP tool has a narrow exception for these explicit synthetic plans: it persists a simulated inbox alert without the ordinary confirmation dialog. Other residents' ordinary handoffs still require a separate human confirmation. The tool checks the active run, consent, resident binding, grant revocation, assigned nurse and record version. It makes no external notification or phone call.

Each incident has one task, updated with new evidence and escalation. The task contains separate `summary.reported`, `summary.recorded`, `summary.baseline`, and `summary.interpretation` fields. `SIMULATED_DELIVERED` means the demo inbox write completed. Nurse acknowledgment requires an assigned staff action; assessment remains pending after acknowledgment. New clinical evidence requires review again. The senior view labels delivery as simulated. The existing staff `/api/state` supplies the alert data; the HumanLoop nurse UI remains deferred.

A failed or revoked tool does not confirm delivery. Emergency guidance is available independently of successful alert delivery. Corrections retain their original evidence and flag already delivered tasks for review.

## Verification and limits

`node --test test/heart-failure.test.mjs` covers profile separation, initial cough, independent worsening signs, measurements versus speech, medication concerns, emergency branches, idempotent alerts, assigned-staff acknowledgment, revocation and correction provenance.

`node scripts/heart-failure-voice-check.mjs` uses generated speech over real Cognito/DynamoDB/Nova Sonic and saves results under ignored `data/`. It creates synthetic inbox tasks and stops its sessions afterward. This is not a human-microphone test or clinical validation.

The symptom recognizer is deliberately bounded to these demonstration phrases and common variants, with conservative negation/uncertainty handling. Nova handles the conversation and recognizes answers in its history; this is not a validated general triage classifier. Check-in question completion is conversational, not a scored clinical questionnaire.

Reference checks: [American Heart Association: changes to report](https://www.heart.org/en/health-topics/heart-failure/living-with-heart-failure-and-managing-advanced-hf/physical-changes-to-report-for-heart-failure), [AHA self-check plan](https://www.heart.org/-/media/files/health-topics/heart-failure/hf-symptom-tracker.pdf), and [MedlinePlus: lisinopril](https://www.medlineplus.gov/druginfo/meds/a692051.html). No diagnosis, medication adjustment, extra-fluid recommendation, or real emergency dispatch is implemented.
