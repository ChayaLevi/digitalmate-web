# DigitalMate Web

An independent, **bilingual (English / 简体中文)** web and Android companion for the
DigitalMate HarmonyOS agent app. It runs fully locally without an account and can
optionally stream through a Jiuwen/Orbit bridge.

> **This repository contains only the new web implementation.** The original DigitalMate
> native app, its ArkTS modules, build system and test suites are not included.

**Live app (no account needed):** <https://michaelatamuk.github.io/digitalmate-web/>

![DigitalMate Web home](docs/assets/home.png)

| Chat | Chinese settings |
| --- | --- |
| ![Chat](docs/assets/chat.png) | ![Settings in Chinese](docs/assets/settings-zh.png) |

## Status

- Local mode by default: data stays on-device, no account login required
- Full English and Simplified Chinese UI, switchable in **Settings → Language**
- BeeBou mascot on the home screen, assistant avatar, execution trace and about card
- Discovery covers with bundled stock photos, real RSS article images and offline fallbacks
- Card detail sheets, local calendar event creation and a guided demo mode
- A2UI JSONL parser and surface store with a protocol-driven demo surface
- Transport layer with mock and Orbit implementations
- Optional Orbit bridge: server-side Bearer token, WSS upstream, SSE to the browser, origin allowlist
- Android Capacitor shell with widget, native share, notifications and safe-area handling
- 105 unit tests plus 33 Playwright UI, mobile and accessibility checks
- Companions, voice input, deep search toggle, labs demos and local-only diagnostics
- Local backup/restore and PWA offline support

The remaining product milestone is a physical-device regression pass and production
authentication in front of a real Jiuwen/Orbit gateway. See
[docs/roadmap.md](docs/roadmap.md), [docs/operations.md](docs/operations.md) and
[docs/architecture.md](docs/architecture.md).

## Features

| Area | Current behaviour |
| --- | --- |
| Home | Live clock, greeting, persona suggestions, BeeBou welcome mascot, continue-last-chat |
| Companions | Seven local personas with notes, tone and suggested tasks |
| Chat | Transport streaming, task rows, execution trace, copy/share/retry/clear, voice input and optional TTS |
| Task shell | Local session/task rows with status, detail and retry |
| Approvals | Approval cards, quota states and explicit failure surfaces |
| Artifacts | Save replies with A2UI surfaces, slides view, browse, preview and download |
| Attachments | Multi-file queue with reorder, camera capture, text/image preview and PDF text extraction |
| Transport | Mock chat + local discovery transports; optional Orbit bridge |
| Orbit bridge | Delegated token, WSS/SSE stream, A2UI surfaces, retry and snapshots |
| Memory | Editable local profile with evidence notes; forget everything |
| Card details | Travel, train and food cards open a detail sheet with source and copy actions |
| A2UI | Declarative renderer for 36 components, 17 scenarios and a JSONL protocol demo |
| Discovery | Search, mixed media cards, natural-language topic edits, source toggles, reactions, saved cards, read state, share and RSS import |
| Skills | Detail view, install/toggle, local JSON import/export |
| Labs | Local BIM, multi-task, deep search, train, map, ride, checkout, social and payment demos |
| Calendar | Local event creation with a confirmation sheet and updated schedule card |
| Hotel / ride / payment | Mock comparison cards with refundable tags, fare estimates and payment review |
| Media | Scene tabs and a media slider for podcasts and short video |
| Offline / PWA | Installable build, offline shell and update check with app version |
| Your data | Export/import a local JSON backup of chats, calendar, saved cards and settings |
| Diagnostics | Optional local-only error log with sanitized messages, export and clear |
| Guided demo | One-click scripted walkthrough of travel, calendar, food, discovery and memory |
| Settings | Language, backend preference, notifications, trace, reduced motion, TTS, GitHub update check and reset |
| History | Archived conversations when starting a new chat |

Scenarios currently include travel, hotel, ride, payment review, media, daily brief, weekly insights, shopping, food/coffee, social,
mail, calendar, document summary, weather and generic tool results.

## Quick start

```bash
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>.

Production build:

```bash
npm run build
npm run preview
```

Tests:

```bash
npm test        # unit tests
npm run test:e2e   # Playwright UI, mobile and axe checks
```

## Epic Replay (branch `epic-replay`)

DigitalMate can be the frontend for the [epic-replay](https://github.com/aharonamir/epic-replay)
server: upload a short clip, pick a narrator, confirm what happened, and watch the narrated
slow-motion replay. Every step after the first request is an A2UI surface built by the bridge
(`server/epic.ts`, `src/lib/epicSurface.ts`) from Epic Replay's HTTP API. Uploads, video and
frames are plain HTTP through the bridge, because A2UI describes screens and does not carry files.
The video pipeline (FFmpeg, Chromium, DeepSeek, ElevenLabs) stays on the Epic Replay server.
Web only; there is no Android work in this branch. Specs: `specs/002-epic-replay-a2ui/`.

The start page has the same options as Epic Replay's own page that matter here: narrator, language, optional name, "Remove the clip's own sound" and "Past replays". Past replays reads Epic Replay's server-rendered `/past` page (it has no JSON form), so a changed page would show an empty list.

### Run it with the real Epic Replay server

1. Set up and start Epic Replay as its README describes. Keep it on localhost, it has no login:
   ```bash
   EPIC_PROVIDER_MODE=record uvicorn epic_replay.web.app:app --port 8010
   ```
   `record` reuses saved replies and pays only for new ones (about 0.05 USD for a new clip).
   `replay` never pays but stops at "Writing the call" for clips with no recording. The provider keys
   (`DEEPSEEK_API_KEY`, `ELEVENLABS_API_KEY`) go in Epic Replay's own `.env`, never in this repo.
2. Start DigitalMate pointing at it:
   ```bash
   npm ci
   EPIC_REPLAY_URL=http://127.0.0.1:8010 npm run dev
   ```
3. Open http://127.0.0.1:5173, then More > Labs > Epic Replay.

For a production-style run use `npm run build && EPIC_REPLAY_URL=... npm start`. The bridge also
serves `/api/epic/*` there.

### Try it with no keys and no pipeline

```bash
node scripts/fake-epic-replay.mjs        # contract-following stand-in on 127.0.0.1:8010, makes no video
npm run dev
```

The fake returns a 2-second test clip as the "replay". Use it to see the flow, not the result.

### Settings

| Variable | Meaning |
| --- | --- |
| `EPIC_REPLAY_URL` | Epic Replay server, default `http://127.0.0.1:8010` |
| `EPIC_REPLAY_TOKEN` | Optional Bearer token sent upstream only, for an authenticating proxy |
| `EPIC_REPLAY_POLL_MS` | How often the bridge reads run state, default 1500 |

### What was and was not tested

- Unit and bridge tests plus Playwright against the fake server (`npm test`, `npm run test:e2e`).
- A contract check against the real Epic Replay FastAPI app in replay mode with seeded run folders:
  real styles, run state, play card, frames, range video and play-card answers worked.
- Not tested: a full live run through the real pipeline with DeepSeek and ElevenLabs.

### Before exposing it beyond localhost

Put authentication and HTTPS in front of both DigitalMate and Epic Replay. Epic Replay lists past
videos to anyone who can reach it.

## Fridge2Table (branch `feat/fridge2table`)

DigitalMate can be the frontend for the [Fridge2Table](https://github.com/agents-demo/fridge2table)
kitchen agent. Ask "What can I cook tonight?" in the chat, or pick the **Kitchen companion**, and the turn
goes to Fridge2Table through the bridge (`server/fridge.ts`). Its reply comes back as text, its tool trace
as the thinking steps, and its meals, swaps, shopping list and inventory as A2UI surfaces built by
`src/lib/fridgeSurfaces.ts`. Card buttons call Fridge2Table directly: **Show steps**, **I made it**,
**I bought these**, **Undo**, **Show my kitchen**. Photos attached in the composer are sent too, tagged
fridge / freezer / pantry from your words. Fridge2Table itself is not changed. Specs:
`specs/003-fridge2table-a2ui/`.

### Run it with the real Fridge2Table

```bash
npm ci
FRIDGE2TABLE_URL=https://fridge-to-table.onrender.com npm run dev
# or, with Fridge2Table running locally (uv run uvicorn app.api:app --port 8000):
FRIDGE2TABLE_URL=http://127.0.0.1:8000 npm run dev
```

Open http://127.0.0.1:5173 and ask "What can I cook tonight?". A Render instance that slept can take up to
a minute on the first request; open it once before a demo. To show a prepared kitchen, open Fridge2Table's
own page, set it up there (or use its `/admin/seed`), copy that browser's `household` cookie and start
DigitalMate with `FRIDGE2TABLE_HOUSEHOLD=<that id>`.

### Try it with no keys

```bash
npm run fridge:fake        # canned replies on 127.0.0.1:8020, no model
FRIDGE2TABLE_URL=http://127.0.0.1:8020 npm run dev
```

| Variable | Meaning |
| --- | --- |
| `FRIDGE2TABLE_URL` | Fridge2Table server. Unset = the feature is off and DigitalMate behaves as before |
| `FRIDGE2TABLE_HOUSEHOLD` | Optional: pin every browser to one Fridge2Table household |
| `FRIDGE2TABLE_TIMEOUT_MS` | Chat turn timeout, default 120000 |

The GitHub Pages build has no bridge, so Fridge2Table works only with `npm run dev`, `npm run preview`,
`npm start` or Docker.

## Homemind (branch `feat/homemind`)

A family board on the Family tab: ownership, "Who's taking this?", reminders and escalation, availability,
standing rules that only prepare a card, and simulated services. Off unless `HOMEMIND_ENABLED=1`; without it
the app is unchanged.

- Plan: `docs/PLAN.md`. Progress and decisions: `docs/PROGRESS.md`.
- Run the demo (start order, two browser profiles, the demo panel and its scene presets, the failure plan):
  `docs/homemind-demo.md`.
- Measured numbers (tests, scenes, model latency, sync time): `docs/homemind-stats.md`.
- Try it with no key: `HOMEMIND_ENABLED=1 HOMEMIND_DEMO=1 HOMEMIND_SECRET=<16+ characters> HOMEMIND_LLM=fake npm run dev`,
  then open `http://127.0.0.1:5173/?member=mom` and the Family tab.
- Live model check before a demo: `npx tsx scripts/homemind-live-check.mts` (paid calls; reads `.env.local`).
- Sync time between two windows: `node scripts/measure-sync.mjs` against a running Homemind dev server.

## Local RSS proxy

Discovery can import a real RSS 2.0, Atom or RDF feed during `npm run dev` and `npm run preview`.
The browser calls `GET /api/rss?url=…`; `server/rss.ts` validates the URL, follows at most three
redirects, enforces a 9-second timeout and a 2 MB response limit, and rejects loopback/private
hosts. Feed XML is parsed by `src/lib/rssParse.ts`, HTML is stripped from summaries, and up to
five usable items become feed cards stored in localStorage.

This is a development helper, not a production-hardened fetcher: DNS rebinding and egress
filtering belong in the future bridge deployment.

## Orbit bridge

The app can talk to a Jiuwen/Orbit gateway through `server/orbit.ts`. The browser never sees the
Bearer token; it sends a turn to the local bridge and receives normalized events over SSE.

```bash
export ORBIT_GATEWAY_URL="wss://gateway.example.com/orbit/ws?binding_id=default"
export ORBIT_TOKEN_FILE="$HOME/.config/digitalmate/orbit-token"
# or, for temporary local testing only:
export ORBIT_TOKEN="<bearer-token>"
npm run dev
```

You can also copy `.env.example` to `.env.local`; the Vite config loads it into the bridge
process without exposing it through `import.meta.env`.

To test the bridge without real credentials, run the fake gateway in one terminal:

```bash
npm run bridge:fake
```

Then start the app with an insecure local gateway and a test token:

```powershell
$env:ORBIT_GATEWAY_URL='ws://127.0.0.1:8899/orbit/ws'
$env:ORBIT_TOKEN='test-token'
$env:ORBIT_ALLOW_INSECURE_WS='1'
npm run dev
```

The fake gateway only implements `room.home`, `room.message` and `orbit.task.text`; it echoes
the prompt and is intended for smoke tests, not as a protocol reference.

## Offline and account-free use

No sign-in is required at any point. Chats, calendar events, saved cards and RSS subscriptions
are stored in the browser, and the app defaults to **Local mode**. The Orbit bridge is optional
and automatically falls back to the local mock when it is unavailable.

The production build is an installable PWA:

```bash
npm run build
npm run preview
npm run check:offline   # Playwright: reload the built app with the network disabled
```

`public/sw.js` caches the shell, hashed JS/CSS and assets after the first visit. It never
intercepts `/api/` requests, so RSS and Orbit calls always go to the network when online. The
service worker is registered only in production builds to avoid stale caches during development.

In a supported browser, use the install button in **Settings → Account-free access** or the
browser’s own “Install app” action.

## Local backup

Because there is no account, **Settings → Your data** can export every `digitalmate.web.v2.*`
key to a JSON file and import it again. Export includes chats, calendar events, saved cards,
RSS subscriptions, skills and settings. Import validates the app marker, version and keys,
replaces only DigitalMate keys, then reloads the app. Unrelated browser storage is untouched.

## Local skill bundles

**Skill center** can export every skill to `digitalmate-skills-YYYY-MM-DD.json` and import a
bundle again. Imports are validated and sanitised, capped at 50 skills, and merged by id; an
imported skill is installed and enabled locally. This is file-based sharing only — no account,
marketplace or OAuth flow.

## Local attachments

The composer can attach up to five local files (5 MB each). Text-like files are read in the
browser and previewed as text; images are previewed with an object URL; searchable PDFs have
their text extracted locally with `pdfjs-dist` (up to 20 pages). Nothing is uploaded. Sent
messages keep the file name, size and kind, while the file contents stay in memory for the
current session only.

Then choose **Settings → Cloud connection → Orbit cloud**. The settings sheet shows whether the
bridge is configured. If it is not, turns fall back to the local mock and say so.

Endpoints:

```text
GET  /api/orbit/health   → { configured, mode, gatewayHost, bindingId }
POST /api/orbit/turn     → text/event-stream of ChatTurnEvent JSON
POST /api/orbit/reset    → clear the bridge session cookie and cached room/submissions
```

Flow per turn:

1. open a WSS connection with `Authorization: Bearer …`,
2. call `room.home` to authorise the room,
3. send `room.message` with a `submission_id`,
4. forward `orbit.task.text` / task error events as SSE,
5. close the socket when the task reports `final`,
6. remember the room id and completed submission in an in-memory session keyed by an
   HttpOnly cookie. A repeated `submission_id` replays the cached result instead of sending
   the action twice.

The bridge is intentionally conservative: `wss://` only unless `ORBIT_ALLOW_INSECURE_WS=1`,
12-second request timeouts, 120-second turn timeout, 32 KB request body, and no token logging.
It currently uses a fresh upstream socket per turn; reconnect reconciliation and snapshot
recovery are still roadmap items. Sessions expire after 30 minutes.

## Self-hosting

The production build is a static SPA plus the local `/api/rss` and optional `/api/orbit`
endpoints. `services/bridge` serves both in production.

```bash
npm run build
npm run start
```

Or with Docker:

```bash
docker compose up --build
```

Then open `http://127.0.0.1:4173`. The default container needs **no account and no
environment variables**. To use the optional Orbit bridge, provide `ORBIT_GATEWAY_URL` and a
mounted token file, or use `ORBIT_TOKEN` for temporary testing.

Security notes and residual risks are documented in [docs/threat-model.md](docs/threat-model.md).

## Public static deployment

The **Deploy** workflow publishes `main` to GitHub Pages:

```text
https://michaelatamuk.github.io/digitalmate-web/
```

It builds with `VITE_BASE=/digitalmate-web/`, so the PWA, manifest and service worker work
under the repository subpath. GitHub Pages is static: local mode, chat, attachments, PDF
extraction, artifacts, memory, backup and PWA install all work, but `/api/rss` and
`/api/orbit` are unavailable there. Use the Docker/preview server when you need RSS import or
the optional Orbit bridge.

To host under a different path, set `VITE_BASE` at build time.

## Android

A Capacitor Android project is included:

```bash
npm run android:sync
cd android
./gradlew assembleDebug
```

Local mode needs no account. The native shell adds share, local notifications and a
home-screen widget. RSS/Orbit require `VITE_API_BASE` pointing at a hosted bridge; otherwise
they fail gracefully while all local features keep working. See
[docs/android-build.md](docs/android-build.md).

## Repository layout

```text
src/
  App.tsx                 app shell, state, transport selection
  components/
    a2ui/                 A2UI surface renderer
    BeeBou.tsx            mascot component
    HomeView, ChatView, DiscoveryView
    DetailsSheet.tsx      travel/train/food detail sheet
    AttachmentSheet.tsx   local text/image/PDF metadata preview
    CalendarEventSheet.tsx local calendar event form
    Overlays.tsx          history, skills, settings, memory, detail
    Chrome.tsx            status bar, top bar, brand mark
  i18n/I18nContext.tsx    language context and tr(en, zh) helper
  data/
    seed.ts               language selector for seed fixtures
    seed.en.ts            English discovery cards, skills, memory profile
    seed.zh.ts            Chinese discovery cards, skills, memory profile
    surfaces.ts           language selector for A2UI surfaces
    surfaces.en.ts        English surface fixtures
    surfaces.zh.ts        Chinese surface fixtures
  protocol/a2ui/
    types.ts              JSONL envelope types
    parser.ts             line parser, JSON Pointer updates and removal
    store.ts              surface store keyed by surfaceId
    queue.ts              throttling and coalescing for fast update streams
    demo.ts               protocol-driven demo surface
  lib/
    mockEngine.ts         prompt → thinking / text / surface (both languages)
    markdown.tsx          small Markdown renderer
    storage.ts            localStorage helpers
    rss.ts                browser client for the local RSS proxy
    rssParse.ts           RSS 2.0 / Atom / RDF parser and HTML cleanup
    backup.ts             local JSON export/import and validation
    attachments.ts        local file validation, reading and preview metadata
    skillBundle.ts        local skill import/export and sanitising
    artifacts.ts          local reply-to-artifact conversion and filenames
    memoryProfile.ts      validated local public-profile import
  transport/
    types.ts              ChatTransport and turn-event contract
    mock.ts               local mock transport
    orbit.ts              bridge client, SSE parsing, retry and health check
    discovery.ts          DiscoveryTransport and local filtering
  types.ts                shared UI, A2UI, RSS and transport types
public/
  bee/                    BeeBou assets
  icon.svg                app icon
  manifest.webmanifest    PWA manifest
  sw.js                   offline shell and runtime cache
docs/
  architecture.md         current layers and future Android/web split
  roadmap.md              mock → protocol → real backend → Android
  android.md              PWA-first / Capacitor-later decision
  android-build.md        APK build, widget, sharing and signing
  threat-model.md         local-first assets, boundaries and mitigations
  operations.md           deployment, env config, origin checks and token rotation
  accessibility.md        automated coverage and screen-reader checklist
  branding.md             naming, BeeBou caveat and asset licensing
  parity.md               feature coverage vs. the native app
  protocol/orbit.md       WSS/auth notes and known deployment topology
  protocol/a2ui.md        surface protocol and catalog coverage
services/
  bridge/                 standalone production static + API server
server/
  rss.ts                  dev/preview /api/rss proxy, size/redirect/SSRF guards
  orbit.ts                /api/orbit health + SSE turn bridge, WSS upstream
  orbitSession.ts         cookie sessions, room/snapshot continuity, submission cache
  a2uiStream.ts           bridge-side A2UI parsing and queue coalescing
services/bridge/
  index.ts                standalone production static + API server
android/                  Capacitor Android project, widget and signing config
tests/
  mockEngine.test.ts      mock replies, localized data and calendar surfaces
  a2uiProtocol.test.ts    JSONL parser, surface store and update queue
  rssParse.test.ts        RSS/Atom parsing and proxy URL guards
  orbitTransport.test.ts  bridge config, SSE parsing and transport events
  a2uiStream.test.ts      bridge-side surface streaming and parse errors
  discoveryTransport.test.ts local discovery loading and filters
  backup.test.ts          local backup export, validation and restore
  attachments.test.ts     local attachment kinds, validation and reading
  skillBundle.test.ts     skill bundle parsing, sanitising and merging
  artifacts.test.ts       local artifact titles, filenames and slides
  memoryProfile.test.ts   local public-profile import validation
e2e/
  app.spec.ts             Playwright UI, mobile, language and axe checks
scripts/
  fake-orbit.mjs          local fake Orbit gateway for bridge smoke tests
  check-offline.mjs       production offline reload check
```

## Path to Jiuwen/Orbit and Android

The UI now talks to a `ChatTransport`:

```text
React UI
  → ChatTransport
      → MockChatTransport   (default)
      → OrbitChatTransport  → /api/orbit/turn (SSE)
                               → Node bridge → Jiuwen/Orbit Gateway (WSS)
```

A browser cannot safely perform the native Huawei/AGC login exchange or hold provider
secrets, so the bridge owns the Bearer token and the upstream socket. What remains is the
production authentication exchange, snapshot reconciliation, and deployment hardening.

Android can connect directly to the gateway with its own native authentication. Possible
Android paths are documented in [docs/architecture.md](docs/architecture.md); the decision is
intentionally deferred until the protocol layer is stable.

## Attribution and branding

This is an **unofficial** project. It is inspired by
[openJiuwen-ai/DigitalMate](https://github.com/openJiuwen-ai/DigitalMate), which is licensed
under Apache-2.0.

The BeeBou mascot images in `public/bee/` are copied from the original project. They may be
subject to separate copyright, trademark or brand terms. Obtain permission or replace them
before commercial use or before implying official endorsement. See [NOTICE](NOTICE).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
