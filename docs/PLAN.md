# Homemind: plan

Build the Homemind demo on DigitalMate Web. Rules and the session protocol are in `CLAUDE.md`. Current state is in `docs/PROGRESS.md`.
DigitalMate background is in `docs/DIGITALMATE_GUIDE.md`: read sections 2, 4, 5, 6, 7 and 8 when a task touches them.

Checked against the code on 2026-11-03.

Sections: 1 What we are building, 2 Architecture, 3 Key designs, 4 Tasks, 5 If time runs short, 6 Out of scope.

## 1. What we are building

**Homemind** is a family app. Each member has a personal view on one shared family board. It collects
what is happening at home, decides who needs to know what and when, and acts under rules the family set.

**The differentiator:** coordination between people: ownership, "Who's taking this?", escalation, and
cross-checking family members' availability. The demo must make this obvious.

**Audience and date:** Chinese managers at the company, about 1 to 1.5 weeks from 2026-11-03. Not
everything has to be real, but anything simulated must say so on screen.

### Demo script (the definition of done)

Two screens side by side: Mom and Dad. A language switch shows English and Simplified Chinese.

| Scene | What happens | Must show |
| --- | --- | --- |
| 1. Assignment and escalation | Mom assigns kindergarten pickup to Dad. It appears on his screen immediately. He does not confirm, the demo clock jumps, and Mom gets an alert. | Live sync, reminder, escalation |
| 2. Kindergarten group | A 接龙 sign-up message in Chinese arrives in a simulated group. Homemind claims apples and alerts the family. Tap "Change" and switch to a cake, using the saved preference "bake a cake because my daughter enjoys it most". Preparations and reminders are created. | Extraction, preference with a reason, correction message |
| 3. A day gone wrong | "Noa is sick." Homemind shows what falls through today and suggests who stays home and what to postpone. | Cross-checking, proposals to approve |
| 4. Wedding, pizza, babysitter | The wedding marks Mom unavailable. A conflict with her pickup is flagged. The Friday pizza card is prepared with a smaller order and waits for one tap. A babysitter message is drafted. Tap "Why?". | Availability, explicit button, explanation |
| 5. Judgment and correction | A non-urgent message waits for the evening summary, with the reason visible. A memory detail is corrected and the next suggestion changes. | Silence, memory correction |

Closing line: "Today's assistants manage one person. We manage the coordination between family members."

## 2. Architecture

```
Browser: DigitalMate Web (Family tab, chat, A2UI cards, alert banner)
   |  HTTP + SSE, same origin
Bridge: server/homemind.ts (routes, validation, identity, A2UI builders)
   |
Homemind core: server/homemind/* (source of truth: items, ownership, reminders,
   |            escalation, rules, availability, preferences, activity log, clock)
   |-- LLM client (DeepSeek Flash: chat intents, screenshot extraction)
   |-- PPMA client (long-term memory, proactive proposals, explanations)
   |-- Fake services (kindergarten group, pizza vendor, babysitter, inbox, weather)
```

Principles:
1. **Homemind core is the source of truth for the board.** PPMA is memory and advice, not the database.
2. **Everything that must never fail on stage is deterministic:** assignment, sync, reminders, escalation,
   availability conflicts, rule preparation.
3. **The core has no network or UI code.** It is pure functions over state plus an injected clock, so it
   can be tested, moved to a separate server, or ported to native later. `server/homemind/` never imports
   from `src/`, and it returns domain data rather than A2UI.
4. **Pattern:** A for chat, B-style forms for add and edit, shown in a main-app tab rather than under Labs.
   This is a product decision: the board is the product.
5. **Run the core inside the bridge process.** Do not add a separate service. Guard the scheduler as a
   `globalThis` singleton so Vite reloads do not start a second one.

### File layout

```
server/homemind.ts                 thin adapter: routes, plugin, handleHomemindRequest, builds surfaces
server/homemind/types.ts           domain types (imported by client too, no node imports)
server/homemind/core.ts            pure state transitions
server/homemind/visibility.ts      per-member filtering
server/homemind/availability.ts    conflict detection
server/homemind/reminders.ts       schedule, tiers, quiet hours, batching, escalation
server/homemind/rules.ts           standing rules, preparing action cards
server/homemind/actions.ts         adapters, confirmation tokens, executeAction
server/homemind/store.ts           JSON persistence (atomic write), seed, reset
server/homemind/clock.ts           real clock + demo offset
server/homemind/scheduler.ts       tick loop
server/homemind/events.ts          per-member SSE hub
server/homemind/llm.ts             OpenAI-compatible client, fake mode
server/homemind/intents.ts         chat intent and extraction schemas, validators, prompts
server/homemind/ppma.ts            PPMA contract client, retry queue
server/homemind/explain.ts         "Why?" records
server/homemind/fakes.ts           simulated services
server/homemind/seed.ts            demo family
src/lib/homemindSurfaces.ts        pure A2UI builders
src/transport/homemind.ts          HomemindTransport, runHomemindAction, session
src/components/FamilyView.tsx      Family tab host (My day, Family, Calendar, Search, Rules, Memory)
src/components/AlertBanner.tsx     live alerts from SSE
src/components/a2ui/homemindComponents.tsx  TaskList, CalendarBoard
scripts/fake-llm.mjs               canned OpenAI-compatible endpoint for tests and rehearsals
tests/homemind*.test.ts
e2e/homemind.spec.ts
specs/004-homemind-a2ui/{spec,plan,tasks}.md
```

## 3. Key designs

### Domain types (starting point)

```ts
type MemberRole = 'parent' | 'teen' | 'child';
interface Member { id; name; role: MemberRole; hasAccount: boolean; lang: 'en'|'zh';
                   quietHours?: { from: string; to: string }; }
interface Family { id; name; timezone; members: Member[]; backupContact?: { name; channel };
                   autonomy: { default: 1|2|3|4; byArea?: Record<string, 1|2|3|4> };
                   weekStartsOn: 0|1; paused: boolean; }

type ItemType = 'event' | 'preparation' | 'task';
type Ownership = { state: 'none' } | { state: 'open'; candidateIds: string[] }
               | { state: 'assigned'; ownerId: string; confirmed: boolean };
interface Item { id; type: ItemType; title; notes?; start?; end?; allDay?;
  forMemberIds: string[]; ownership: Ownership;
  visibility: 'family' | 'parents'; sensitive: boolean; importance: 'normal' | 'critical';
  unavailableMemberIds: string[]; parentEventId?: string; recurrence?: Recurrence;
  status: 'proposed' | 'open' | 'done' | 'cancelled';
  source: { kind: 'manual'|'chat'|'screenshot'|'email'|'group'|'rule'|'ppma'; label; simulated?: boolean };
  createdBy: string; version: number; }

type Tier = 'urgent' | 'timed' | 'summary';
interface Reminder { id; itemId; recipientIds: string[]; fireAt; tier: Tier; attempts: number;
  status: 'scheduled'|'sent'|'acknowledged'|'cancelled'; escalation?: EscalationStep[]; }
interface Preference { id; aboutMemberId?; text; reason?; strength: 'hard'|'soft'; scope?: string; }
interface Rule { id; title; trigger; actionTemplate; limits; area; enabled; createdBy; }
interface ActionCard { id; adapter; mode: 'real'|'simulated'; payload; payloadHash;
  status: 'pending'|'executed'|'failed'|'expired'|'cancelled'; expiresAt; whyId; }
interface Activity { id; at; actor: string; what; whyId?; undo?: UndoPatch; }
interface Why { id; summary; basis: Array<{ kind; ref?; note }>; source: 'rule'|'model'|'ppma'; decisionId?: string; }
```

Every change goes through `applyChange(state, change, actor, clock)`. It increments `version`, writes
`Activity`, and returns events to publish. Stale versions: the first write wins, and the second caller gets
`409` with the current item, shown as "This changed. Here is the latest."

### Identity

The demo needs two members at once, including two windows on one machine.

- `GET /api/homemind/members` returns the family. On first entry, the Family tab shows a member picker.
- The bridge signs a session token containing the member id. `HOMEMIND_SECRET` is required when enabled.
- The client keeps the token in **`sessionStorage`** (per window) and sends `x-homemind-session`. Do not
  use a cookie, because a cookie is shared across windows.
- `?member=mom` in the URL pre-selects a member, but only when `HOMEMIND_DEMO=1`.
- **Known limit:** chat history and settings are in `localStorage`, shared by windows in one browser
  profile. For stage use two browser profiles or two devices. Add this to the run guide. Do not rewrite
  storage.
- The picker is not real authentication. Label it as demo sign-in.

### Live updates

`GET /api/homemind/events` (SSE) per member, filtered through `visibility.ts`. The client refreshes
surfaces on `item.changed` and shows `AlertBanner` on `alert`. Send heartbeats, reconnect with backoff, and
clear on `demo.reset`. Pass the session token as a query parameter here only if `EventSource` is used, or use
`fetch` streaming to keep it in a header (preferred).

### Clock and scheduler

All time logic takes an injected clock. `scheduler.ts` ticks every 5 seconds and fires what is due.
`POST /api/homemind/demo/clock` (only when `HOMEMIND_DEMO=1`) jumps the offset forward and ticks at once.
Show a visible "Demo clock" chip with the current simulated time.

### Reminders and escalation

- Regular reminder: sent once. No response moves it to the next summary.
- Critical: up to 3 alerts, then one escalation to the next person, then the backup contact if configured.
- Unassigned ("open") item near its time: escalates to both parents.
- Quiet hours: only `urgent` breaks them. Several small updates are batched into one alert.
- Responses: `Done`, `I'm on it`, `Hand off`, `Remind me later`. Any recipient's response closes the alert
  for all recipients.
- Suggest `critical` for matches such as child pickup. A parent can always set it.
- `pause` (the stop button) stops all automatic actions and rules. Reminders still fire.

### Availability

An event's `unavailableMemberIds` is checked against assigned items overlapping in time. A conflict produces
an `open` proposal: "Mom is at the wedding on Tuesday. Who takes pickup?" Unavailability appears in everyone's
summary, unless the event is "Parents only".

### LLM use

`server/homemind/llm.ts` calls `HOMEMIND_LLM_BASE_URL` + `/chat/completions` with JSON output and
`HOMEMIND_LLM_MODEL`. Two jobs only:

1. **Chat intent:** the text becomes `{intent, ...}`, one of `ask`, `create_event`, `create_task`,
   `add_preparation`, `assign`, `claim`, `mark_done`, `add_preference`, `create_rule`, `report_situation`, `why`.
2. **Extraction:** text or an image becomes `{events[], preparations[], requests[], sign_up?}`, each with a
   confidence value and a source quote.

Rules:
- Validate every model reply against a hand-written validator. On failure retry once, then show an error.
  Model output never reaches state without validation.
- Treat message and screenshot content as data. Put it in a clearly delimited block and instruct the model
  not to follow instructions inside it. Extraction output only creates **proposed** items.
- The context for `ask` contains only what `visibility.ts` allows for that member.
- Dates are resolved against the injected clock. Pass today's date and timezone in the prompt.
- `HOMEMIND_LLM=fake` uses canned replies, for tests and rehearsal. It is shown as "Simulated model" in the UI.

Chat writes follow the autonomy level: family item writes apply with Undo, and rules and external actions
return a card that needs a tap.

### PPMA integration

Call the contract directly from TypeScript over HTTP. The Python SDK is not needed.

| Direction | Call | Use |
| --- | --- | --- |
| Register | `PUT /v0/apps/homemind/manifest` | Events and tools below |
| Auth | `POST /v0/apps/homemind/token` with the owner token | App token, server-side only |
| Report | `POST /v0/spaces/{space}/messages` as a `MessageBatch` | Item changes, preferences, outcomes |
| Listen | `GET /v0/spaces/{space}/stream?app=homemind` | Commands, with `Last-Event-ID` resume |
| Close the loop | `command.outcome` event | Report every command's outcome |
| Correct | `user.correction` event | "That's wrong" on the memory screen |
| Read memory | `GET /v0/spaces/{space}/memory/views[/{view}]` | "What we know" screen |
| Explain | `GET /v0/spaces/{space}/decisions/{id}/explain` | "Why?" on PPMA-originated items |

Manifest (confirm exact fields against `contracts/generated/`):
- Emits, all `sensitivity: personal`: `homemind.item_changed`, `homemind.preference_stated`,
  `homemind.member_unavailable`, `homemind.reminder_outcome`, `homemind.message_received`.
- Tools: `homemind.get_board` (`none`), `homemind.propose_item` (`create`, reversible),
  `homemind.propose_preparation` (`create`, reversible), `homemind.add_to_shopping` (`create`, reversible).
- **Do not expose a tool that sends or orders.** PPMA only proposes, and proposals land as `proposed` items
  or cards.

Failure behavior:
- `ppma.ts` queues outgoing events and retries. PPMA being down must not block any user action.
- A `PPMA offline` chip appears on the memory screen. Do not invent memory.
- When there is no PPMA decision, "Why?" shows Homemind's own `Why` record with `source: 'rule'` or `'model'`,
  and says which. Never present a rule's explanation as if it came from PPMA.
- PPMA calls are slow by design (several model calls per event). Never await them in a user request path.
- For the demo, record a run with `--inference record` and replay with `--cassette`, and keep the live mode
  available. Confirm in T0.3 that replay is deterministic enough for the script.

### A2UI screens

Prefer existing components, for later native porting.

| Screen or card | Components | Status |
| --- | --- | --- |
| My day | `SurfaceRoot`, `TaskList`, `ActionBar` | `TaskList` new |
| Family | `MetricGrid`, `InfoRows`, `List`, `TaskList` | Mostly existing |
| Event with preparations | `ExpandableCard`, `TaskList`, `ActionBar` | Mostly existing |
| Calendar | `CalendarBoard` (day, week, month; filter by person and area) | New |
| Add and edit | `TextField`, `ChoiceGroup`, `Toggle`, `FilePicker`, `ActionBar` | Existing, web only |
| Proposed items | `ApprovalCard` or `ConfirmPanel` + `ActionBar` | Existing, check actions |
| Order card | `PaymentCard`, `ConfirmPanel` | Existing, label as simulated |
| "Why?" | `ThinkingCard`, `InfoRows` | Existing |
| Errors | `ErrorNotice` | Existing |

`TaskList` data: `Array<{id, title, meta, ownerLabel, state, tone, simulated?, actions: A2uiAction[]}>`.
Follow `RecipeOptions` for per-row actions. `CalendarBoard` must work at 390 px and pass axe.

Add a small "Simulated" badge component or a field that existing cards render. Do this without breaking
existing surfaces.

### Fake services

`server/homemind/fakes.ts`, in-process, each visibly labeled:
- **Kindergarten group:** a chat-style list with a Chinese 接龙 fixture and a "post next message" demo control.
  Claiming posts a reply, and changing posts a correction.
- **Pizza vendor:** menu, price, open or closed, order confirmation.
- **Babysitter:** ranked contacts, canned availability, drafted message that needs a tap.
- **Inbox:** sample messages from approved senders.
- **Weather:** a canned forecast, only if a scene needs it.

### Bridge routes

All whitelisted and validated.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/homemind/health` | `{enabled, llm, ppma, demo}` |
| GET | `/api/homemind/members` | Member picker |
| POST | `/api/homemind/session` | Demo sign-in |
| GET | `/api/homemind/screen/:name` | `my-day`, `family`, `calendar`, `search`, `rules`, `memory`, `activity`, `settings`: returns a turn with JSONL |
| GET | `/api/homemind/events` | SSE |
| POST | `/api/homemind/items` | Create |
| PATCH | `/api/homemind/items/:id` | Edit, with `version` |
| POST | `/api/homemind/items/:id/:verb` | `assign`, `claim`, `handback`, `ack`, `snooze`, `done`, `approve`, `dismiss`, `undo` |
| GET | `/api/homemind/why/:id` | Explanation |
| POST | `/api/homemind/chat` | Multipart chat turn: text and images |
| POST | `/api/homemind/actions/:id/confirm` | Execute an action card, parents only |
| POST | `/api/homemind/actions/:id/cancel` | Cancel |
| POST | `/api/homemind/preferences` | Save or correct a preference |
| POST | `/api/homemind/rules` | Create, enable, disable (parents only for those that spend or write out) |
| PUT | `/api/homemind/settings` | Autonomy, quiet hours, pause |
| POST | `/api/homemind/demo/:verb` | `clock`, `reset`, `post-group-message`, only when `HOMEMIND_DEMO=1` |

### Environment variables

```
HOMEMIND_ENABLED=1
HOMEMIND_SECRET=
HOMEMIND_DEMO=1
HOMEMIND_DEBUG=0
HOMEMIND_DATA_FILE=.homemind/state.json
HOMEMIND_LLM=live|fake
HOMEMIND_LLM_BASE_URL=
HOMEMIND_LLM_API_KEY=
HOMEMIND_LLM_MODEL=
PPMA_URL=http://127.0.0.1:8765
PPMA_OWNER_TOKEN=          # or PPMA_OWNER_TOKEN_FILE
PPMA_SPACE=me
```

Add `.homemind/` to `.gitignore`. Add all of these to `.env.example`, with no real values.

## 4. Tasks

**How to read a task:** 🧑 means the human must provide something. **STOP** means wait for the human's OK afterwards.
"Model" is a suggestion for which Claude Code model to pick for that chat. Small adjacent tasks can share one chat.

Estimated total: about 7 working days. The owner does not work on Fridays.

### P0: Setup and spikes

The goal is to find blockers while there is still time to change course.

**T0.1 Project setup** (Sonnet)
- Confirm the branch is `feat/homemind`. Run `npm ci`, `npm test`, `npx tsc --noEmit`, `npm run build`, `npm run test:e2e`.
  Record results in PROGRESS. If Playwright can't find a browser, follow guide section 8.
- Add `.homemind/` to `.gitignore`. Add the env vars from section 3 to `.env.example` with no real values.
- Write short `specs/004-homemind-a2ui/spec.md`, pointing to `docs/PLAN.md`, per the team convention.
- **Done when:** baseline results are recorded, and the only changes are docs and config.

**T0.2 Spike: PPMA contract** (Opus) 🧑 PPMA clone at `../ppma`
- `uv sync`, then `uv run ppma serve --profile fake`. Find where the owner token is written.
- Write `scripts/ppma-smoke.sh`: register a manifest, mint a token, post an event, read the stream and memory views.
- Confirm exact field names against `../ppma/contracts/` and record them in `docs/homemind-spikes.md`.
- **Done when:** the script runs end to end against fake PPMA with a clear pass or fail.

**T0.3 Spike: PPMA with DeepSeek** (Opus) 🧑 model endpoint, key, model name
- Run with `--agent openai`, `PPMA_LLM_*` and `--agent-clear personal`.
- Post "Kindergarten party on Thursday, bring cut fruit." Record whether a memory entry and a command appear, the latency,
  and the number of model calls. Try `--inference record` and replay with `--cassette`.
- **Done when:** the results are in `docs/homemind-spikes.md`, including whether replay is good enough for the script.

**T0.4 Spike: images and two windows** (Sonnet) 🧑 model key, one real 接龙 screenshot if available
- Send a Chinese 接龙 screenshot straight to the model and confirm structured extraction.
- Confirm `sessionStorage` gives two windows separate identities, and test the side-by-side layout.
- **Done when:** results are in `docs/homemind-spikes.md`.

**STOP after P0.** Report what works, the latency, and any change to this plan.
- If PPMA with DeepSeek is too slow or unstable live: keep it for memory and recorded proposals, and rely on deterministic logic
  and `llm.ts` on stage. Tell the human.
- If the model cannot read images: ask the human for the approved alternative. Do not add a vendor.
- If there is no key: continue with `HOMEMIND_LLM=fake` and flag it.

### P1: Core domain

**T1.1 Types, clock, store, seed** (Sonnet)
- `types.ts`, `clock.ts`, `store.ts` (JSON, atomic write), `seed.ts`.
- Seed: Mom and Dad (parents), Maya (teen, 15), Noa (child, 5, no account), plus the demo's starting items. Names are fictional.
- Add `tests/homemindBoundary.test.ts`, which fails if any file in `server/homemind/` imports from `src/`, `server/orbit.ts`, `server/fridge.ts` or Vite, or if `src/` has a non-type import from `server/homemind/`.
- **Done when:** unit tests cover save, load, reset and the clock offset, and the boundary test passes.

**T1.2 Item state transitions** (Opus)
- `core.ts`: `applyChange(state, change, actor, clock)`. Every ownership transition, assign, claim, hand back, done, stale version
  (`409` with the current item), Undo, activity log, recurrence with one cancelled occurrence, and preparations under events.
- **Done when:** unit tests cover each case, and `core.ts` has no networking or React imports.

**T1.3 Visibility and availability** (Opus)
- `visibility.ts`: per-member filtering. `availability.ts`: conflict detection producing an `open` proposal.
- **Done when:** tests prove a teen gets no trace of a Parents-only item, and that the wedding-versus-pickup conflict is flagged.

### P2: Bridge

**T2.1 Routes and identity** (Opus)
- `server/homemind.ts` with all routes in section 3, registered in both places, active only with `HOMEMIND_ENABLED=1`.
- Signed session token, `x-homemind-session`, `sessionStorage`, `?member=` only when `HOMEMIND_DEMO=1`. Add the debug aids.
- **Done when:** bridge tests pass following `tests/fridgeBridge.test.ts`: unknown paths give 404, cross-origin is rejected, bad ids
  are rejected, and with the flag off the full existing suite passes unchanged.

**T2.2 Surface builders** (Sonnet)
- `src/lib/homemindSurfaces.ts`: pure functions, EN and ZH, one per screen, plus error and empty states and a "Simulated" label.
- **Done when:** unit tests parse each one through `A2uiSurfaceStore.fromJsonl`.

**T2.3 Live events** (Sonnet)
- `events.ts`: SSE hub per member, filtered, with heartbeats. Client reads with `fetch` streaming to keep the token in a header.
- **Done when:** a test proves a teen's stream gets no Parents-only event, and that reconnecting works.

### P3: Screens

**T3.1 New components** (Opus)
- `homemindComponents.tsx`: `TaskList` with per-row actions, `CalendarBoard` with day, week and month views and filters. Register in
  `A2uiSurfaceView.tsx`. Add the "Simulated" badge without breaking existing surfaces.
- **Done when:** component tests pass, and screenshots at 390 px are checked in both languages.

**T3.2 Family tab** (Opus)
- `FamilyView.tsx`: picker, sub-navigation, `form` state, applying JSONL, mapping actions to bridge calls.
- Screens: My day, Family, Calendar, Search, Add and edit, Rules, Activity, Settings.
- Add the `family` tab, `kind: 'homemind'`, the Family persona, and Homemind branding only when enabled.
- **Done when:** in a browser, a member can create an event with preparations, edit it, delete a preparation, assign it and search for it.

**T3.3 Live sync and alerts** (Sonnet)
- Wire SSE into `FamilyView`, add `AlertBanner`.
- **Done when:** a Playwright test with two contexts shows Mom assigning and Dad seeing it without reloading. Axe passes.

### P4: Reminders and escalation

**T4.1 Reminders** (Opus)
- `reminders.ts`, `scheduler.ts` (a `globalThis` singleton, 5-second tick), demo clock endpoint and chip.
- Unit tests with a fake clock: a single regular reminder, critical attempts then escalation, open item escalating to both parents, quiet
  hours, batching, one response closing it for all, backup text with no details, neutral wording, pause.
- **Done when:** those tests pass.

**T4.2 Settings and Scene 1** (Sonnet)
- Settings: quiet hours, autonomy, pause, backup contact, the "an alert can be missed" note. Reminder responses on cards.
- **Done when:** an e2e test runs Scene 1.

**STOP after P4.** Scene 1 is the minimum viable demo. Show it to the human.

### P5: Chat and screenshots

**T5.1 LLM client and intents** (Opus)
- `llm.ts`, `intents.ts`, `scripts/fake-llm.mjs`. Intents and extraction as in section 3. Validators, a retry, the injected date.
- **Done when:** tests pass for each intent, invalid output, and instruction text inside a message having no effect.

**T5.2 Chat transport** (Sonnet)
- `src/transport/homemind.ts`, routing in `send()`, mapping to `ChatTurnEvent`. Writes follow the autonomy level, with Undo.
- **Done when:** e2e chat with the fake model answers, adds, reassigns and explains. A teen asking about a Parents-only item gets no trace of it.

**T5.3 Screenshots and preparations** (Opus)
- Upload through `FilePicker` or chat attachment. Proposed items with source quotes, one-tap approval. Suggested preparations with times.
- **Done when:** the real model handles 5 sample inputs, with results recorded. The fake model covers the e2e test.

**T5.4 Preferences** (Sonnet)
- Save with reason and scope. Hard ones block a choice. The cake preference applies to the daughter's party and not to every event.
- **Done when:** unit and e2e tests prove the scoping and the hard block.

### P6: PPMA

**T6.1 PPMA client** (Opus)
- `ppma.ts`: manifest, token, outgoing queue with retry, stream with resume, `command.outcome` for every command, an offline chip.
- **Done when:** tests pass against `ppma serve --profile fake`, or `scripts/fake-ppma.mjs` if needed. A user action still works with PPMA down.

**T6.2 Proposals, memory and "Why?"** (Opus)
- Map commands to proposals with `source: 'ppma'`. "What we know" from memory views, with correct and forget via `user.correction`. Explanations via `explain`.
- **Done when:** a correction visibly changes a later suggestion (Scene 5). If PPMA can't do this reliably in time, let the preference store drive the change, show
  the correction in both places, and report it honestly.

### P7: Rules and actions

**T7.1 Action guard** (Opus)
- `actions.ts`: adapters, tokens, `executeAction`, expiry, payload hash.
- **Done when:** tests prove each refusal: no token, reused, expired, changed payload, non-parent, level 4 on a real adapter.

**T7.2 Fake services** (Sonnet)
- `fakes.ts`: kindergarten group with a Chinese 接龙 fixture, pizza vendor, babysitter, inbox, weather. All labeled.
- **Done when:** unit tests pass, and the label is visible on every card.

**T7.3 Pizza rule and wedding** (Opus)
- `rules.ts`: a Friday rule prepares a card 30 minutes ahead, checks availability, adjusts size, stops on a price over the cap, a closed vendor or a calendar change.
  No tap means it expires visibly. "Why?" on the card. Babysitter draft if both parents are out.
- **Done when:** an e2e test runs Scene 4.

**T7.4 Group claim** (Opus)
- Per group, off by default, first time needs approval, food and low-cost only, stops on unclear messages. At level 4 against the simulated group, it claims and alerts. "Change" posts a correction.
- **Done when:** an e2e test runs Scene 2.

**T7.5 Source changes mark dependent work as stale** (Opus) (optional, cut first if short on time)
Idea taken from Orbit's revision model. Do not copy Orbit code: it has no license.
- Messages from the simulated group and inbox get an id and a version. Every item, preparation, claim and draft
  created from a message records `sourceRef: { id, version }`.
- Add a demo control "update message" to the simulated group. Fixture: the party moves from Thursday to Friday,
  and the sign-up list changes so apples are no longer needed.
- When a message gets a new version: extract it again, and compare dates, times and requested items in code.
  Use the model only to extract, never to decide what changed.
- Every item that depends on the old version gets `stale: { reason, oldValue, newValue }`. Its pending reminders
  pause, and any draft or action card that quotes it is held. A held card never executes, even at autonomy level 4.
- One card: "The kindergarten changed the party to Friday. 3 items depend on it." Actions: `Apply changes`,
  `Keep as is`, `Discard`. Apply moves the event, reschedules the preparations, and posts a correction in the
  simulated group if a claim is affected. Keep clears the flag. Every action has Undo.
- Notify the owners of the affected items, with neutral wording. "Parents only" still applies.
- If this task is done, add it to the run guide as the last beat of Scene 2.
- **Done when:** unit tests prove stale marking, that a held card cannot execute, that Apply reschedules correctly
  and that Keep clears the flag; an e2e test runs Scene 2 with the update.

### P8: Remaining scenes

**T8.1 A day gone wrong** (Opus)
- `report_situation`: what falls through today, who stays home, what to postpone, a teacher message draft that needs a tap.
- **Done when:** an e2e test runs Scene 3.

**T8.2 Judgment and summaries** (Sonnet)
- Tier decision with a visible reason. Daily and weekly summary cards: "What you need to do" first, general events for everyone.
- **Done when:** an e2e test runs Scene 5.

**T8.3 Sample email** (Sonnet) (cut first if short on time)
- Simulated inbox, approved senders, item visible only to the mailbox owner until approved, one item when both parents got the same message.
- **Done when:** unit tests pass.

### P9: Demo readiness

**T9.1 Demo panel and run guide** (Sonnet)
- Hidden panel: clock jump, post group message, one-tap reset. `docs/homemind-demo.md`: start order, env vars, two browser profiles, failure plan. Update `README.md`.
- **Done when:** following the guide from a clean start works.

**T9.2 Rehearsal** (Opus) 🧑 Chinese text review, Huawei phone if available
- Run all five scenes 3 times in a row from reset, live, and measure the time. Target is about 5 minutes. Fix what breaks. Test on a Huawei phone browser if available.
- **Done when:** `npm test`, `npm run test:e2e`, `npm run build` pass, 3 clean runs are recorded, and with the flag off the base app is unchanged.

**T9.3 Backup video** 🧑
- The human records the full script. Claude Code helps prepare, and lists known gaps for the human to mention.
- **Done when:** the video exists and has been watched through.

**Default demo setup:** one laptop running the bridge (`npm run build && npm start`) and PPMA locally, with two browser profiles side by side. Phones on the same network are optional, using
`HOST=0.0.0.0` and checking allowed origins. Hosting is a stretch goal, since free hosting sleeps and PPMA needs persistent storage.

### Added outside the plan: family shopping lists (S.1)

**Built 2026-11-10 by Shira Zaloshinki, outside this task list; recorded here afterwards at the human's request.** Not part of any phase and
not in the demo script (`docs/homemind-demo.md`). Details, test results and open points: `docs/PROGRESS.md`, log entry "S.1".

- **What it is.** A **Shopping** screen in the Family tab: one list per store type. Six default stores with fixed ids and both languages
  (Supermarket 超市, Pharmacy 药店, Mall 商场, Post office 邮局, Hardware store 五金店, Market 菜市场); a family can add its own stores (at most 20)
  and remove one only when its list is empty.
- **Items.** Any member with an account adds an item with an optional note and a quantity (1 to 99, shown as "− n +"), marks it bought and back,
  removes it, and clears the bought items of a store. Adding something already waiting at that store adds nothing: the screen names the item and
  offers +1, "Make it n" or keeping it. Item ids are never reused (`lastItem`).
- **Runs.** One member takes a store's run ("I'll go", 我去买). Only that member releases it; another member taking it gets a 409. Taking a run puts a
  task "Shopping at <store>" on the member's board for today (source kind `shopping`), so it is on their My day with the normal item actions and Undo.
  **The task leads:** reassigned on the board, the run follows; handed off or removed, the store is free and its list stays; **marked done, that
  store's list is emptied** (bought and not bought) and the store is free.
- **Seed.** A reset puts 14 items across the six stores, in English and Chinese, with nobody going.
- **Code.** Pure core `server/homemind/shopping.ts` (`shoppingOf`, `settleShoppingRuns`, `applyShopping`, `parseShoppingBody`); `HomemindState.shopping`
  and `ShoppingStore`/`ShoppingItem`/`ShoppingState` in `types.ts`; `POST /api/homemind/shopping` (session needed) and the `shopping` screen in
  `server/homemind.ts`, with `settleShoppingRuns` in `commit()`; the `shopping.changed` stream event; surfaces in `src/lib/homemindSurfaces.ts`;
  `TaskList` rows take an optional `quantity`, and the shared `TextField` accepts `inputType: "number"`. Tests: `tests/homemindShopping.test.ts`.
- **Rules it keeps.** Nothing is bought or ordered: a list is a note for the family. The whole family sees the lists; there is no "Parents only".
  The model and PPMA are not involved.
- **For later phases.** The lists live in the family's state document, so P11 stores them with it, and T11.3's two-household test should include them.
  The chat cannot add to a list yet.

### P10 to P14: Homemind in the cloud (several families)

**Added 2026-11-10, after T9.1, for the human's review. No code yet.** Checked against the code on that date.

**Goal.** A feasibility demo on Render: anyone the human approves opens a link, creates an account, creates a family or joins one,
and several families use the app at the same time, fully separated. Demo only: no password reset, no email sending, PPMA off in the cloud.
This replaces "hosting" in the stretch-goal sentence above and "production auth and multi-tenancy" in section 6, for a demo grade of both.
P10 can be done before or after T9.2 (Rehearsal); P11 to P14 should wait until T9.2 is done, because they touch `runtime()` and `dispatch()`.

**Decisions (the human's, do not reopen).**
- One Render web service, one instance (SSE and the in-memory runtime need that), Postgres on Render.
- One family = one state document. The core (`core`, `visibility`, `rules`, `judgment`, `actions` guard) does not change. What changes is
  storage, identity and the per-family runtime.
- Who can sign up, two ways, both on:
  1. **Pre-approved emails.** A global list (`HOMEMIND_SIGNUP_EMAILS`) may sign up and create a family. A parent can also add an email to
     their family and pick its member (for example "Dad"); that email joins directly on sign-up.
  2. **A join link per family** (`/join/<code>`). Anyone with the link can create an account and send a request. A parent of that family
     approves or rejects it, and on approval picks which member it is (an existing member without an account, or a new member with a name
     and role). Until then the person sees only a "waiting for approval" screen. A parent can turn the link off or make a new one.
- Email and password, hashed with Node's built-in `scrypt`. No reset, no email sending.
- Session: the HMAC token and the `x-homemind-session` header stay; the token gains `userId` and `householdId`. It stays in `sessionStorage`.
- `HOMEMIND_CLOUD=1` ("cloud mode"): no password-less `POST /session {memberId}`, no `/debug/state`, and the other DigitalMate bridges are
  not reachable without a session (they use the human's API keys).
- Time zone per family, from the browser when the family is created. Render runs in UTC, so `machineTimezone()` must not decide it there.
- "Create a demo family" seeds today's demo data. The demo panel, clock jumps and fake services show only in a demo family. The demo clock
  offset stays inside each family's state.
- PPMA stays off in the cloud.
- Local mode keeps working as today: without `DATABASE_URL` the file store is used, every existing test passes, and the flag-off check passes.

**Decisions made while planning (the human can change them).**
- **A user belongs to one family** (`memberships.user_id` is unique). No family switcher. A second family needs a second email
  (`name+2@gmail.com` works). Pending join requests: one at a time per user.
- **Only emails on the global list can create a family.** A person who joined by link or by a family's pre-approved email cannot.
- **`hasAccount` stays in the state and is derived.** It is read in about 35 places in the core. Cloud code sets it from the memberships
  every time a runtime loads and every time a membership changes, so a crash between the database write and the state write heals itself.
- **Removing someone removes their access, not the person.** The member stays on the board (items, history), with `hasAccount: false`.
  A family always keeps at least one parent with an account. Deleting a member who has no account is a separate, later action, not in P13.
- **Sign out is client-side**: the token is forgotten. It stays valid until it expires (12 h) if someone copied it. Said in the doc.
- **In the cloud the picker is replaced, never reached around**: `GET /members` (unauthenticated, lists the family) is not served in cloud mode;
  `GET /me` replaces it.

#### What in the current code makes this harder than described

These are the places that assume one family or one process. Each is owned by a task below.

1. **One runtime per process.** `runtime()` in `server/homemind.ts:206` keeps one `Holder` on `globalThis`, keyed by the data-file path.
   `dispatch()` (`:1608`) calls `runtime()` with no household. Good news: `Runtime` (`:178`) already holds everything per family (state, clock, store,
   hub, llm, ppma, adapters, chats). Only the lookup is global. Owner: T11.3.
2. **One scheduler task ticks one runtime.** `scheduledTick()` (`:376`) reads the single holder. `scheduler.ts` is a `globalThis` singleton with one task.
   It must tick every loaded family, and one family's error must not stop the others. Owner: T11.3.
3. **`machineTimezone()`** decides the zone in `seedState` (`seed.ts:216`) and in `/demo/reset` (`homemind.ts:1560`). Owner: T10.2.
4. **"Demo" is a process-wide env flag.** `demoOnly` routes are checked before any runtime is found (`dispatch`, `:1619`), and the unauthenticated
   `/health` returns `demo` for the whole process. It must become a property of the family. Owner: T11.3, T12.3.
5. **Three unauthenticated routes show or do too much**: `GET /members` (lists the family), `POST /session` (anyone becomes anyone),
   `GET /debug/state` (the whole state, Parents-only items included, with `HOMEMIND_DEMO=1`). Owner: T10.1 and T12.2.
6. **The store is one file with no household in it.** `HomemindStore` (`store.ts`) has `file`; `Runtime.file` is also used to name the PPMA sync
   file (`ppmaSyncFileFor(rt.file)`). Owner: T11.1 (file becomes optional on the runtime).
7. **The seed is built on fixed member ids** (`mom`, `dad`, `maya`, `noa`), and the sample inbox, the group fixture and the presets name them.
   That is fine because ids are scoped to one state, but it means those features exist only in a demo family. An empty family needs its own
   `seedEmptyState`. Owner: T12.3.
8. **Every commit saves the whole state** (`rt.store.save` clones it with `JSON.parse(JSON.stringify())`). On Postgres that is one JSONB `UPDATE`
   per change, per family. Fine for a demo; T11.2 measures the real size of a seeded family and records it.
9. **`tsx` is a devDependency but `npm start` runs `tsx services/bridge/index.ts`.** A Render build that skips dev dependencies will start
   nothing. T10.4 uses `npm ci --include=dev` in the build command. Moving `tsx` to `dependencies` would be a dependency change: ask first.
10. **Render's zero-downtime deploys run the old and the new process side by side for a while.** Both would tick, send reminders and save
    to the same families. "One instance" is not enough on its own. T11.2 adds a version check on every save and a Postgres advisory lock so
    only one process ticks.
11. **Browser storage is shared across accounts.** `localStorage` holds the main chat history, the persona notes and the memory profile
    (`STORAGE_KEYS` in `src/lib/storage.ts`). In the cloud, someone who signs out and another who signs in on the same browser profile would see
    the first person's chat. T12.4 clears the Homemind-related keys when the user id changes or on sign out. (Two windows in one profile still
    share `localStorage`; that known limit stays.)
12. **Restarts and sleeping.** The 20:00 summary goes out only when a tick *crosses* 20:00, so a restart after 20:00 skips that evening's (already
    documented in T8.2). A sleeping or restarting instance fires no reminders. A free Render web service sleeps when idle and a free filesystem
    is erased on every deploy; check Render's current plan terms before choosing a plan. The demo needs an always-on instance.
13. **Reach from China.** The audience is Chinese managers. The `onrender.com` domain may be slow or blocked from the company network, and SSE
    is the first thing to suffer. T10.4 asks the human to have the team lead open the link early, before anything else is built on it.
14. **`isSameOrigin()`** already reads `x-forwarded-host` and `x-forwarded-proto`, so it should work behind Render's proxy; the first real
    deploy checks it. Client IP for rate limits comes from `x-forwarded-for`, whose trusted position must be taken from Render's documentation
    and tested on the first deploy (T14.2).

#### Estimate (working days of Claude Code, with the human's reviews not counted)

| Phase | Days | Why |
| --- | --- | --- |
| P10 Quick deploy | 1.5 to 2 | Small code, but the first contact with Render and the gate |
| P11 Storage | 4 to 5 | T11.3 is the risky one: it touches the dispatcher, the scheduler and the test hooks |
| P12 Accounts | 3 to 4 | New screens in both languages, at 390 px, with axe |
| P13 Joining | 4 to 5 | Two paths, a people screen, removal, and the live parts |
| P14 Hardening and deploy | 3.5 to 4.5 | The isolation test over every route, and e2e with Postgres and four contexts |
| **Total** | **16 to 20** | About 3 to 4 working weeks. P10 alone gives the team lead a link in about 2 days |

If time is short, the order to cut from the bottom: the per-family model cap in T14.2 (keep the global one), the people-management extras in
T13.4 (keep approve and reject), the demo family seed in P12 (keep the empty one). Never cut T14.1.

#### Environment variables added (all in `.env.example` with no real values)

```
HOMEMIND_CLOUD=1                 # cloud mode (P10)
HOMEMIND_ACCESS_CODE=            # the gate (P10); optional once accounts exist
HOMEMIND_TIMEZONE=Asia/Shanghai  # P10: the single demo family's zone. Required in cloud mode until P12 takes it from the browser
DATABASE_URL=                    # P11: Postgres. Unset: the file store, as today
HOMEMIND_SIGNUP_EMAILS=          # P12: comma-separated, may sign up and create a family
HOMEMIND_LLM_DAILY_CAP=          # P14: model calls per family per day
HOMEMIND_LLM_GLOBAL_DAILY_CAP=   # P14: model calls per day for the whole service
TEST_DATABASE_URL=               # tests only: a throwaway Postgres
```

Do **not** set `ORBIT_*`, `EPIC_REPLAY_*`, `FRIDGE2TABLE_*` or `PPMA_*` on Render. The cloud-mode startup prints a warning for each one it finds.

### P10: Quick deploy

Today's single demo family on Render behind an access code, so the team lead gets a link fast. Accounts do not exist yet; the member picker stays,
but only behind the code (see "Questions" at the end of this section).

**T10.1 Cloud mode and closing the other bridges** (Sonnet)
- New `server/cloud.ts`: `cloudMode()` (`HOMEMIND_CLOUD=1`), `cloudGate(request, response)` that answers for the other bridges, and a startup check
  that warns when `ORBIT_*`, `EPIC_REPLAY_*`, `FRIDGE2TABLE_*` or `PPMA_*` are set. Register the gate **first** in both `services/bridge/index.ts`
  (before the `/api/rss`, `/api/epic/`, `/api/fridge/` and `/api/orbit/` branches) and `vite.config.ts` (a `cloudGatePlugin()` before the other plugins).
- What the other bridges are, from the code: `/api/orbit/*` (`server/orbit.ts`: bearer token and gateway, so it spends the human's Orbit access),
  `/api/epic/*` (`server/epic.ts`: proxy to an Epic Replay server, optional bearer token), `/api/fridge/*` (`server/fridge.ts`: Fridge2Table, keyed to a
  cookie), `/api/rss` (`server/rss.ts`: fetches any public URL for the Discover tab; no key, but it is an open fetch proxy, and `isPrivateHost` checks
  the hostname only, not what it resolves to). The DigitalMate chat itself uses its local mock unless Orbit is configured, so with the env vars unset the
  first three hold no key; the gate is belt and braces plus a stop to anyone setting them by mistake.
- **Decided by the human (2026-11-10): nothing is hidden.** Every tab stays visible, for a real presentation. The main chat runs on its in-browser mock
  (no Orbit variables locally either) and Discover works through `/api/rss`, so both keep working in the cloud as they do locally. In cloud mode
  `/api/orbit/*`, `/api/epic/*` and `/api/fridge/*` answer `404 not_available`, always: Epic Replay and Fridge2Table need their own servers, which are not
  running in the cloud (nor configured in `.env.local`), so Labs and kitchen questions show their usual error state, as they do locally without those servers.
  `/api/rss` stays open behind the access code in P10 and needs a Homemind session from P12 on.
- In cloud mode, `GET /api/homemind/debug/state` is a 404 even with `HOMEMIND_DEMO=1`, `?member=` is ignored, and `GET /health` returns only
  `{enabled, ready, demo}` (no `llm` mode, no PPMA detail).
- **Done when:** bridge tests with `HOMEMIND_CLOUD=1`: each of the four prefixes answers 404 and a fake upstream is never called; `debug/state` is 404
  with `HOMEMIND_DEMO=1`; with the flag unset every existing test passes unchanged; `tests/homemindBoundary.test.ts` passes.

**T10.2 Time zone from an env var** (Sonnet)
- `HOMEMIND_TIMEZONE` (IANA name, checked with `Intl.DateTimeFormat`; invalid is a startup error that names the variable). `runtime()` passes it to
  `seedState({timezone})` (`homemind.ts:210`), and `/demo/reset` uses `rt.state.family.timezone` instead of `machineTimezone()` (`homemind.ts:1560`).
- Unset in local mode: the machine's zone, as today. Unset in cloud mode: the server refuses to start and says to set it (a silent UTC would make
  "today's pickup" land on the wrong day). A state that already has another zone keeps its own and logs one warning.
- **Done when:** a test run with `TZ=UTC` and `HOMEMIND_TIMEZONE=Asia/Shanghai` shows the seed's "today" and every preset target on the Shanghai day;
  an invalid value is refused; all existing tests pass in the machine's zone.

**T10.3 Access code gate** (Sonnet)
- `HOMEMIND_ACCESS_CODE` (8 characters or more). New `server/accessGate.ts` (pure parts: cookie sign and verify, code check with `timingSafeEqual`)
  and a thin handler, registered first in both places (after T10.1's gate). Every request except `/healthz` needs the cookie `hm_access`
  (HttpOnly, SameSite=Lax, Secure behind `x-forwarded-proto: https`, signed with a key derived from `HOMEMIND_SECRET` under its own label, 7 days).
  Without it: a page request gets a small gate page (inline, English and Chinese, no external assets; the existing CSP allows it) and an `/api/*` request
  gets `401 {error: 'access_code_required'}`. `POST /access {code}` sets the cookie. 10 wrong codes per IP per 15 minutes give `429` (in memory).
- The cookie is a gate, not an identity: the Homemind session stays in `sessionStorage` and the header, so two windows can still be two people.
  The SSE stream (`fetch`) carries the cookie by itself.
- **Done when:** tests: no cookie, wrong code, right code, expired cookie, a cookie signed with another key, `/healthz` open, `429` after the limit, an SSE
  request without the cookie gets 401, code unset means no gate and no change.

**T10.4 Render files, local dry run and first guide** (Sonnet) 🧑 STOP
- `render.yaml` (a Blueprint): one web service, Node 22 (`NODE_VERSION`), `buildCommand: npm ci --include=dev && npm run build`, `startCommand: npm start`,
  `healthCheckPath: /healthz`, `HOST=0.0.0.0`. Env: `HOMEMIND_ENABLED=1`, `HOMEMIND_CLOUD=1`, `HOMEMIND_DEMO=1`, `HOMEMIND_SECRET` (generated by Render),
  `HOMEMIND_ACCESS_CODE` and the model variables (set by hand in the dashboard, `sync: false`), `HOMEMIND_TIMEZONE=Asia/Shanghai`, `HOMEMIND_LLM=fake` until the
  human chooses `live`. No `PPMA_*`, no Orbit, Epic or Fridge variables. State is on the instance's disk and is lost on deploy and restart in P10; the guide says so.
- `docs/homemind-cloud.md`, first version: deploy steps for P10, the env var table, the access code, what is lost on restart, what is simulated, and the
  check from China (ask the team lead to open the link on the company network and report what loads and whether Live shows).
- **Done when:** a local dry run with the exact build and start commands and the same env (`PORT=10000 HOST=0.0.0.0`): `/healthz` is 200, the gate asks for
  the code, Mom and Dad work in two windows through Scene 1, the four closed prefixes answer 404, and the demo panel works. `npm test`, `npx tsc --noEmit`,
  `npm run test:e2e` and `npm run build` pass, and the flag-off check passes. **No deploy and no push: the human deploys.**
  **STOP** for the human's OK, the deploy, and the team lead's report.

**P10 end of phase:** `npm run build` and the flag-off check, recorded in the log.

### P11: Storage

**T11.1 Store interface** (Opus)
- In `store.ts`: `interface StateStore { load(): Promise<LoadResult>; save(state): Promise<void>; reset(): Promise<HomemindState> }` and
  `interface StoreProvider { open(householdId: string, seed: () => HomemindState): StateStore; households(): Promise<string[]> }`.
  `HomemindStore` implements `StateStore` with no behavior change. A `FileStoreProvider` opens exactly one household, `local`, on `HOMEMIND_DATA_FILE`.
  `Runtime.store` becomes `StateStore`; `Runtime.file` becomes optional (the PPMA sync file needs it, so PPMA stays file-store only).
- A shared contract test, `tests/homemindStoreContract.ts` (load seeds when empty, save then load, reset, saves in call order, unreadable data moved aside
  and never deleted), run against the file store now and against Postgres in T11.2.
- **Done when:** all existing tests pass unchanged, the contract passes on the file store, and `git diff` shows no change in `core`, `visibility`, `rules`,
  `judgment`, `actions`.

**T11.2 Postgres store and migrations** (Opus) 🧑 OK to add `pg`; a throwaway Postgres for tests (`TEST_DATABASE_URL`)
- Ask before adding `pg`. `server/homemind/storePg.ts` (loaded with a dynamic `import()`, so local mode never touches it), `server/homemind/migrations/001_init.sql`
  and a small runner (`migrate.ts`, a `schema_migrations` table, run once at start under an advisory lock) when `DATABASE_URL` is set.
- Tables: `users` (id, email stored lower-case with a unique index, password_hash, created_at, last_sign_in_at); `households` (id, name, timezone,
  kind `demo | regular`, join_code unique and nullable, join_enabled, llm_day, llm_calls, created_by, created_at); `memberships` (user_id **unique**, household_id,
  member_id, unique on household_id plus member_id, created_at); `preapproved_emails` (household_id, email, member_id or the new member's name, role and lang,
  added_by, unique on household_id plus email); `join_requests` (id, household_id, user_id, status `pending | approved | rejected`, member_id, decided_by,
  created_at, decided_at); `household_state` (household_id, state jsonb, version int, updated_at).
- `save(state)` is `UPDATE ... SET state, version = version + 1 WHERE household_id AND version = $expected`; no row updated is a `state_conflict` error. The runtime that
  gets one drops itself and reloads, never overwrites. A **Postgres advisory lock** ("scheduler leader") lets only the process that holds it tick, so the old
  process of a zero-downtime deploy stops ticking while the new one starts. Saves for one household stay serialized in call order.
- A state row that cannot be read as Homemind state is copied to `household_state_unreadable` and the family is not reseeded silently (it shows an error).
  Pool of at most 5, `statement_timeout` and `connectionTimeoutMillis` set, TLS from the URL.
- Measure and record in PROGRESS: the size of a seeded family's state, and the time of a save.
- **Done when:** the store contract passes on Postgres (skipped with a visible message when `TEST_DATABASE_URL` is unset); migrations apply twice without error; a
  version conflict is tested; the leader lock is tested with two connections; without `DATABASE_URL` nothing imports `pg`.

**T11.3 A runtime per family** (Opus)
- In `server/homemind.ts`: replace the single `HOLDER` with a registry on `globalThis`, `Map<householdId, Promise<Runtime>>`, and `runtimeFor(householdId)`.
  Local mode has one household, `local`, so every existing call works. `dispatch()` finds the household from the session (T12.1), so the order becomes
  session, runtime, then the demo check. The demo check becomes `rt.state.family.demo === true` in cloud mode, and the `HOMEMIND_DEMO` env in local mode.
- `scheduledTick()` ticks every loaded runtime one after another, each in its own try and catch, with a `running` guard per runtime. At start in cloud mode
  every household in the store is loaded, so reminders keep working after a restart. A cap on loaded families (200) refuses the rest with a visible error.
- `startPpma` does nothing in cloud mode, even if `PPMA_URL` is set. The test hooks (`llmOverride`, `adaptersOverride`, heartbeat) stay global.
  `resetHomemindRuntime()` closes every family's streams.
- `EventHub` gains `closeFor(memberId)` (used by T13.1 when access is removed).
- **Done when:** a unit test with two households in one process: a change, a reminder, a clock jump and a reset in A leave B's state, subscribers and clock
  untouched; one tick covers both and a throwing store in A does not stop B; the 20:00 summary of A (Asia/Shanghai) and B (America/New_York) go out at their own
  20:00; all existing tests pass on the `local` household; `tests/homemindBoundary.test.ts` passes.

**P11 end of phase:** `npm run build` and the flag-off check, recorded in the log.

### P12: Accounts

**T12.1 Passwords and the new token** (Opus)
- `server/homemind/cloud/password.ts`: `crypto.scrypt` (N=16384, r=8, p=1, 64-byte key, 16-byte random salt), stored as `scrypt$N$r$p$salt$hash`, compared with
  `timingSafeEqual`. Password 8 to 128 characters, NFKC-normalized. Email lower-cased and trimmed, 254 characters, checked by hand. An unknown email runs a dummy hash so
  the answer takes the same path. No new dependency.
- Token: `signSession` keeps its signature and gains an options object; the payload becomes `{u: userId, h: householdId, m: memberId, exp}`. `readSession` returns all of
  it. A user with no family yet gets `{u, exp}` only, which works for `/me`, creating a family and the join routes. In cloud mode a token without `u` and `h` is refused;
  in local mode the old `{m, exp}` token still works. Every request checks the membership against the family's runtime, so removing access takes effect at once.
- **Done when:** tests for hash and verify, a wrong password, an unknown email, a tampered token, an expired one, a token with `h` swapped, an old local token (works in
  local mode, refused in cloud mode).

**T12.2 Sign up, sign in, sign out** (Opus)
- Routes under `/api/homemind/auth/`: `POST signup {email, password, joinCode?}`, `POST signin {email, password}`, `POST signout` (answers 204; the client forgets
  the token), plus `GET /me` (user, family name, member, `demo`, pending state, `canCreateFamily`). All validate by hand, cap the body at 4 KB, call `isSameOrigin()`.
- Sign-up is allowed only when the email is on `HOMEMIND_SIGNUP_EMAILS` or in some family's `preapproved_emails`, or a valid join code comes with it. Anything else is
  `403 not_invited` with a neutral message. A used email is `409 email_taken` (the demo accepts that this tells a stranger the email exists).
- In cloud mode `POST /session`, `GET /members` and `?member=` do not exist (404). Local mode is unchanged.
- **Done when:** bridge tests for every path above, including bodies that are too large, a cross-origin request, and a method that is not allowed.

**T12.3 Create a family** (Opus)
- `POST /households {kind: 'empty' | 'demo', name, timezone, memberName, lang}`. Only a user whose email is on the global list and who has no family. The time
  zone is checked with `Intl` on the server; the browser sends `Intl.DateTimeFormat().resolvedOptions().timeZone`.
- New `seedEmptyState({now, timezone, familyName, creator})` in `seed.ts`: the creator as the first parent, an empty board, default settings, no rules, no
  preferences, no sample data. The demo kind uses the existing `seedState({now, timezone})`, with the creator linked to Mom, and sets `Family.demo = true`
  (new optional field, absent in local state). Everyone else in a demo family starts with `hasAccount: false` until linked (derived, see the decisions).
- **Done when:** tests for both seeds; two families created by two users get different ids and do not share a single object; a demo family's creator is Mom with an
  account and Dad has none; a non-demo family has no demo routes (404) and no clock chip data; the zone is taken from the request and an invalid one is refused.

**T12.4 Sign-in, sign-up and create-family screens** (Sonnet)
- `src/components/CloudAuth.tsx`: sign in, sign up (with `?join`), create a family (empty or demo, name, your name), all in English and Chinese with `tr(en, zh)`.
  A visible notice on sign-up: "This is a demo. Do not enter real family information." / "这是演示版，请勿输入真实的家庭信息。". Calls in `src/transport/homemind.ts`
  (all through `apiUrl()`); the session in `sessionStorage` keeps its key and gains the user and family. `FamilyView` shows these screens instead of the picker when
  `/health` says cloud mode; local mode keeps the picker. A sign-out button on Settings.
- On sign out, and when the user id differs from the last one, remove the browser-stored chat and notes of the main app (the `STORAGE_KEYS` entries
  `messages`, `archived`, `topics`, `memoryProfile`, `personaNotes`, `personaProfiles`, `savedCards`, `tasks`, `artifacts`), so a shared browser does not show
  the previous person's conversation. The task lists the exact keys it clears in the log.
- **Done when:** e2e: sign up with a global email, create a demo family, see Mom's board; sign out, sign in, see it again; wrong password shows an `ErrorNotice`; a
  second account on the same browser sees none of the first one's chat. 390 px, axe clean, English and Chinese. Local-mode e2e (73) unchanged.

**P12 end of phase:** `npm run build` and the flag-off check, recorded in the log.

### P13: Joining

**T13.1 Members and removing access** (Opus)
- `server/homemind/members.ts` (pure, no storage, no network): `addMember(state, {name, nameZh?, role, lang})` (no account), `linkMember(state, memberId)`,
  `unlinkMember(state, memberId)`, with the guards: the last parent with an account cannot be unlinked; an id that is not in the family is refused. Linking and
  unlinking are the only writes to `hasAccount`; a `syncAccounts(state, linkedMemberIds)` applies the memberships when a runtime loads.
- Routes (parents only, 403 otherwise): `POST /members {name, role, lang}` and `POST /members/:id/remove-access`. Removing access deletes the membership, sets
  `hasAccount: false`, closes that person's streams (`closeFor`), and their next request is `401`. Their items, history and preferences stay. Neutral wording in every notice.
- **Done when:** tests: add, link, unlink, the last-parent guard, the removed person's next request is 401 and their open stream ends, items they owned are unchanged
  (Homemind assigns nothing on its own), a teen cannot call either route.

**T13.2 Pre-approved emails** (Opus)
- Parents add `{email, memberId}` (an existing member without an account) or `{email, newMember: {name, role, lang}}`. `GET /preapproved` and `DELETE /preapproved/:id`,
  parents only. On sign-up with that email the membership is created at once and no request is made. If the person already has an account, it is attached at the next
  `/me`. Email compare is case-insensitive. One email in two families: the first sign-in wins; the other entry stays unused.
- **Done when:** tests: sign-up with a pre-approved email lands as that member and sees that family's board; a removed invite does nothing; a member who already has an
  account cannot be invited again; family B's parent cannot list or delete family A's invites (404); an email not on any list is `403 not_invited`.

**T13.3 Join link and requests** (Opus)
- Code: 128 random bits, base64url. `GET /join/:code` (public, rate limited): `{valid, familyName}`; an unknown, off or replaced code looks the same. `POST /join/:code/request {note?}`
  for a signed-in user with no family: one pending request per user, at most 20 pending per family. Parents: `GET /join-requests`, `POST /join-requests/:id/approve
  {memberId}` or `{newMember: {name, role, lang}}`, `POST /join-requests/:id/reject`, and `POST /join-link {action: 'off' | 'new'}`. A new code invalidates the old one;
  requests already made stay pending.
- Approval writes the membership in a database transaction, then links the member in the state through `commit()`. The state is derived from memberships on every load (T13.1),
  so a failure between the two heals itself. Parents get a stream message `members.changed` and a neutral notice ("Someone asked to join"); the requester's screen polls `/me`.
- **Done when:** tests: valid, off, replaced and unknown codes; a request; a second request refused; the flood cap; approve to an existing member and to a new one; reject;
  a teen cannot approve; family B's parent cannot see or approve A's request (404); the approved person's next `/me` returns the family.

**T13.4 Waiting, approval and people screens** (Sonnet)
- The "waiting for approval" screen (polls `/me` every 5 s while the tab is visible, with backoff, and turns into the board without a reload), the rejected screen, and the
  People screen in Settings for parents: members and who has an account, invite by email (pick an existing member or add one), the join link (copy, turn off, make a new
  one), pending requests with approve (member mapping) and reject, remove access. The People screen is an A2UI surface from `homemindSurfaces.ts` using the existing form
  components; the sign-in and waiting screens are plain React (they exist only in the cloud web app).
- **Done when:** e2e: A creates a demo family; B signs up by the link; B sees "waiting"; A approves B as Dad; B's window becomes Dad's board without a reload; C is rejected and sees
  nothing of the family; A removes Dad's access and B's window returns to sign-in. 390 px, axe clean, English and Chinese.

**P13 end of phase:** `npm run build` and the flag-off check, recorded in the log.

### P14: Hardening and deploy

**T14.1 Isolation test** (Opus)
- `tests/homemindIsolation.test.ts`. Two families in one Postgres (or the file-store provider with two households) with recognisable strings, the same member ids (`mom`, `dad`), and a
  Parents-only item in each. The route table is exported (`homemindRouteTable()`), and a meta-test fails if any route has no isolation case, so a route added later cannot ship untested.
- For every route: A's token with B's ids (items, cards, claims, rules, situations, source changes, preferences, whys, mail ids, join requests, invites) always gives `404`, with no
  body that names anything of B. Also: a screen or search of A never contains B's strings; the SSE stream of A gets nothing when B changes (and the reverse); the model context built for A (spy
  on the `LlmClient`) contains no string of B; a token whose `h` was changed fails its signature; A's Mom token cannot act as B's Mom; a removed member is refused; PPMA is not started in
  cloud mode; concurrent requests from A and B in the same tick do not mix.
- **Done when:** the test passes and the meta-test covers every route in the table.

**T14.2 Rate limits and the daily model cap** (Opus)
- `server/homemind/cloud/rateLimit.ts`: in-memory buckets with an injected clock and a size cap. Sign-in: 10 per 15 minutes per IP and 5 per email. Sign-up: 5 per hour per IP. Join
  request: 5 per hour per user. `GET /join/:code`: 30 per minute per IP. Answer `429` with `Retry-After`. The client IP comes from `x-forwarded-for` at the position Render documents;
  the task states which and tests with a spoofed header on the first deploy.
- `HOMEMIND_LLM_DAILY_CAP` per family (counted in `households.llm_day` and `llm_calls`, the family's local day) and `HOMEMIND_LLM_GLOBAL_DAILY_CAP` for the whole service, counted around
  `LlmClient` in `llmOf()`; a retry counts. Over the cap the chat answers with a plain, visible message ("The model limit for today is reached; the board still works") and the board,
  assignment, reminders and escalation keep working. Never a silent fake answer.
- **Done when:** tests for each limit with the injected clock; the chat over the cap shows the message and not a 500; the counter resets on the next local day; another family is not affected.

**T14.3 e2e with two families and four contexts** (Opus) 🧑 a throwaway Postgres (Docker or a reachable one)
- A new Playwright project on its own port with `HOMEMIND_CLOUD=1` and `TEST_DATABASE_URL` (skipped with a visible message when unset), and a small compose file for a throwaway Postgres.
  Four `browser.newContext()` at once: family A (Mom, Dad) and family B (Mom, Dad). Scene 1 runs in A while B works on its own board: B's Dad sees none of A's pickup, B's clock chip
  does not move when A jumps the clock, a reset in A leaves B's board, and when A removes Dad's access A's Dad window returns to sign-in while B is untouched.
- **Done when:** the project passes 3 times in a row, and the local e2e (73) still passes.

**T14.4 Deploy with Postgres and the cloud guide** (Sonnet) 🧑 STOP
- `render.yaml` gains the `databases` block and `DATABASE_URL` from it; `HOMEMIND_SIGNUP_EMAILS` and the model variables are set by hand (`sync: false`); the access code becomes optional.
- `docs/homemind-cloud.md`, complete: deploy steps, every env var, how to approve someone (both ways, step by step), what to do when someone is stuck (no reset exists), what is lost
  or kept on restart, the known limits (sign out, shared `localStorage`, the 20:00 summary after a restart, region and reach from China), and a demo script for "two families at once"
  (who sits where, what each does, about 5 minutes, what to say about what is simulated).
- **Done when:** the human has deployed, `/healthz` is 200 with Postgres, the guide was followed from scratch by the human, the isolation test and the four-context e2e pass, and the
  phase-end checks pass: `npm run build`; the flag-off check; and the same two checks with `HOMEMIND_CLOUD` unset and no `DATABASE_URL` (local mode). **No deploy and no push by Claude: STOP.**

#### Questions for the human (answers change P10 to P14)

1. ~~Which tabs close in cloud mode?~~ **Answered 2026-11-10:** none is hidden; see T10.1.
2. ~~P10 and the picker.~~ **Answered 2026-11-10: yes.** The picker stays in P10 only, only while `HOMEMIND_ACCESS_CODE` is set and `DATABASE_URL` is not, and is removed for good in T12.2.
3. **Plan and region on Render.** Always-on instance and a region close to China? (Check Render's current plans; do not use a sleeping instance for the demo.)
4. **Helper script for stuck people.** No reset exists. Do you want a tiny `scripts/homemind-admin.ts` (list users, delete a user, set a password) you can run in Render's shell? It is outside your list.
5. **`tsx`.** The build command uses `npm ci --include=dev`. Moving `tsx` to `dependencies` is cleaner but is a dependency change; OK to do it in T10.4?

## 5. If time runs short

Cut in this order, from the bottom up:

| Priority | Keep |
| --- | --- |
| Must | Scene 1, board and calendar, EN/ZH switch |
| Must | Scene 2 with screenshot extraction, preferences |
| Should | Scene 4 with the order card and "Why?" |
| Should | Scene 5 with a correction |
| Could | Scene 3 |
| Could | Live PPMA, as opposed to recorded (never cut memory entirely without telling the owner) |
| Cut first | Email ingestion, stale-on-source-change (T7.5), birthday, babysitter ranking, weekly summary, hosting |

If a feature is cut, remove it from the demo rather than faking it unlabeled.

## 6. Out of scope for this plan

Native HarmonyOS port, real orders or payments, real WeChat or DingTalk access, real push notifications, real
email and calendar connections, production-grade auth and multi-tenancy (a demo grade of both is planned in P10 to P14), Fridge2Table sync, Xiaoyi integration, and the
first-version features not named above (bag by day, maintenance, chore rotation, no time to cook, weather rules).

For later porting, keep core logic free of web APIs and prefer catalog components, as listed in guide section 10.

**Orbit and the native path.** Native DigitalMate sends its home chat to an Orbit server through a gateway, so
on Huawei phones Homemind will need to become either an Orbit capability or on-device tools. This is why
`server/homemind/` must stay free of DigitalMate and web imports. Orbit is not part of this demo: DigitalMate Web's
chat uses its local mock by default, and Homemind owns its own board and logic. Ask the human before touching
`server/orbit.ts` or the Orbit code.
