# Spec: Epic Replay driven from DigitalMate (web)

Branch: `epic-replay`. Scope: web only. Android is out of scope for now.

## Goal
DigitalMate Web becomes the frontend for an existing Epic Replay server
(https://github.com/aharonamir/epic-replay). The whole flow is driven by A2UI surfaces:
start form, progress, "is this what happened?" check, finished video, restyle, delete.

## User stories
1. Start: pick a 3-30 s clip, a narrator style, a language, optional player name, tick consent, press Start.
2. Progress: see the eight Epic Replay steps move live.
3. Check: see the key-moment frame and other candidate moments, pick one, edit activity, outcome and name, keep or drop events marked "Check this", confirm, use a general call, or stop.
4. Result: play the finished MP4 in the app, download it, tell it in another narrator style, make another, or delete it.
5. A run survives a page reload (the run id is kept in local storage).

## Requirements
- FR-1 The browser talks only to DigitalMate (`/api/epic/*`). Epic Replay has no auth and no CORS and is never exposed to the browser.
- FR-2 Every screen after the first request is an A2UI v0.9.1 surface (createSurface / updateComponents / updateDataModel) built by the bridge from Epic Replay's documented HTTP API.
- FR-3 Uploads, checkpoint answers, restyle and delete use plain HTTP. A2UI describes screens, it does not carry files or video.
- FR-4 No secrets in the repo. `EPIC_REPLAY_URL` and optional `EPIC_REPLAY_TOKEN` are server-side only.
- FR-5 The bridge allows only whitelisted paths: start, health, run surface and stream, frames, final.mp4, clip.mp4, action, upload. Run ids are validated. Cross-origin POSTs are rejected.
- FR-6 English and Chinese strings for the Epic Replay surfaces.
- FR-7 Works on phone-sized screens without horizontal overflow.

## Out of scope
Android work, deploying to the public internet, authentication for Epic Replay itself, changing the epic-replay repository, paid provider calls from tests.

## Known limits
- The pipeline (FFmpeg, Chromium, DeepSeek, ElevenLabs) stays on the Epic Replay server.
- Progress is read by polling the run state every 1.5 s through the bridge and streamed to the browser as SSE. Upstream SSE is not used.
- Script checkpoint B (`/runs/{id}/script`) and re-run are not exposed.
