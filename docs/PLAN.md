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
| Cut first | Email ingestion, birthday, babysitter ranking, weekly summary, hosting |

If a feature is cut, remove it from the demo rather than faking it unlabeled.

## 6. Out of scope for this plan

Native HarmonyOS port, real orders or payments, real WeChat or DingTalk access, real push notifications, real
email and calendar connections, production auth and multi-tenancy, Fridge2Table sync, Xiaoyi integration, and the
first-version features not named above (bag by day, maintenance, chore rotation, no time to cook, weather rules).

For later porting, keep core logic free of web APIs and prefer catalog components, as listed in guide section 10.
