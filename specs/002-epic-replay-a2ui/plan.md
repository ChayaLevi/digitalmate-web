# Plan

```
Browser (React, A2uiSurfaceView)
   | GET /api/epic/start, SSE /api/epic/runs/{id}/stream, POST upload/action, media
DigitalMate bridge (server/epic.ts, runs in vite dev/preview and services/bridge)
   | builds A2UI JSONL with src/lib/epicSurface.ts, proxies media with Range
Epic Replay server (FastAPI, EPIC_REPLAY_URL, default http://127.0.0.1:8010)
```

- `src/lib/epicSurface.ts` - pure builders: start, progress, check, result, error surfaces; `confirmBody` maps the form to the play-card answer.
- `server/epic.ts` - bridge handler and Vite plugin. Polls `GET /runs/{id}`, fetches `/play-card` while a step waits for the user, emits a surface only when it changed, ends the stream at done/stopped/failed.
- `src/components/a2ui/epicComponents.tsx` - new catalog components: FilePicker, ChoiceGroup, TextField, Toggle, FrameGallery, StepList, VideoPlayer. They read and write a `form` map supplied by the host (data-bearing actions).
- `src/components/EpicReplayView.tsx` - host: applies envelopes to `A2uiSurfaceStore`, keeps form state, sends actions. Reachable from More > Labs > Epic Replay.
- `scripts/fake-epic-replay.mjs` - contract-following stand-in server for tests and demos. Makes no video.

## Tests
- vitest: surface builders, form-to-answer mapping, bridge (token handling, Range, path and origin checks).
- Playwright: full flow against the fake server (start, check, edit, confirm, video plays, restyle, stop, phone width, axe).
- Contract check against the real Epic Replay FastAPI app in replay mode with seeded run folders (no pipeline, no paid calls).
