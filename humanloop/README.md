# HumanLoop

Voice-first health companion for older adults. React + Vite frontend, plus a small Node server that bridges the browser's microphone to Amazon Nova Sonic on Bedrock.

```
Browser (mic 16 kHz PCM) ──WebSocket /voice──▶ server/index.js ──HTTP/2 stream──▶ Bedrock Nova Sonic
Browser (speaker 24 kHz) ◀── audio + transcripts + alerts ◀──────────────────────────────┘
```

AWS credentials stay on the server. The browser never sees them.

## Run it

```bash
npm install
npm run dev:mock     # no AWS needed: scripted fake voice conversation
```

Open http://localhost:5173. Nurse dashboard: http://localhost:5173/#/nurse.

### With real Nova Sonic

1. Enable Nova Sonic (and Nova Lite for photos) in the Bedrock console, in a supported region (e.g. `us-east-1`).
2. Sign in to AWS the normal way (`aws sso login`, `AWS_PROFILE`, or env keys).
3. `cp .env.example .env` and adjust region / model IDs.
4. `npm run dev`

## What's where

| Path | What |
| --- | --- |
| `src/pages/Chat.tsx` | Check-in chat: typing, quick replies, voice (mic button), photo upload |
| `src/lib/useVoice.ts`, `src/lib/audio.ts`, `public/pcm-capture.js` | Mic capture, playback, WebSocket client |
| `server/index.js` | Nova Sonic session, tools (`record_check_in`, `notify_nurse`), photo description, nurse alerts API |
| `src/pages/Nurse.tsx` | Nurse alert dashboard (polls `/api/alerts`) |

## Notes

- Alerts are held in server memory. Restarting the server clears them.
- Nova 2 Sonic connections last about 8 minutes; the server ends the session at 7.5 minutes.
- The tool-calling and photo parts of the server follow the Nova Sonic event format but were not run against live AWS yet.
