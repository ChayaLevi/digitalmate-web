# Homemind: progress

Update this file at the end of every task, per the session protocol in `CLAUDE.md`. Keep old log entries. Newest entry goes first.

## Where we are

- **Current task:** T1.2 done (item state transitions)
- **Next task:** T1.3 (visibility and availability)
- **Scenes working end to end:** none
- **Blocked on:** nothing
- **Last updated:** 2026-11-04, after T1.2

## Task status

Status values: `not started`, `in progress`, `partial`, `done`, `skipped`, `cut`.

| Task | Name | Status | Note |
| --- | --- | --- | --- |
| T0.1 | Project setup | done | Node 22.23.4. All green: 141 unit, 40 e2e, after two small test fixes |
| T0.2 | Spike: PPMA contract | done | `scripts/ppma-smoke.sh` passes 21 checks against fake PPMA. Facts in `docs/homemind-spikes.md` |
| T0.3 | Spike: PPMA with DeepSeek | done | Flash: memory and commands in about 16 s. Replay through `ppma serve` always misses, so it is not usable on stage. Results in `docs/homemind-spikes.md` |
| T0.4 | Spike: images and two windows | done | Flash read the simulated 接龙 screenshot: 7/7 facts, 3 of 3 runs, about 3 s with reasoning off. `sessionStorage` separates windows. 8/8 checks |
| T1.1 | Types, clock, store, seed | done | `server/homemind/{types,clock,store,seed}.ts`, 4 test files, 42 tests. 183 of 183 in all. Zone = machine's; tsc covers the core |
| T1.2 | Item state transitions | done | `server/homemind/core.ts`, 60 tests in `tests/homemindCore.test.ts`. 243 of 243 in all |
| T1.3 | Visibility and availability | not started |  |
| T2.1 | Routes and identity | not started |  |
| T2.2 | Surface builders | not started |  |
| T2.3 | Live events | not started |  |
| T3.1 | New components | not started |  |
| T3.2 | Family tab | not started |  |
| T3.3 | Live sync and alerts | not started |  |
| T4.1 | Reminders | not started |  |
| T4.2 | Settings and Scene 1 | not started |  |
| T5.1 | LLM client and intents | not started |  |
| T5.2 | Chat transport | not started |  |
| T5.3 | Screenshots and preparations | not started |  |
| T5.4 | Preferences | not started |  |
| T6.1 | PPMA client | not started |  |
| T6.2 | Proposals, memory and "Why?" | not started |  |
| T7.1 | Action guard | not started |  |
| T7.2 | Fake services | not started |  |
| T7.3 | Pizza rule and wedding | not started |  |
| T7.4 | Group claim | not started |  |
| T8.1 | A day gone wrong | not started |  |
| T8.2 | Judgment and summaries | not started |  |
| T8.3 | Sample email | not started |  |
| T9.1 | Demo panel and run guide | not started |  |
| T9.2 | Rehearsal | not started |  |
| T9.3 | Backup video | not started |  |

## Decisions made during the build

Record decisions that future chats need and that are not in `docs/PLAN.md`.

- T1.2: every change on an existing item must carry `version`, including the verbs (assign, claim, done...), not only PATCH. A wrong version gives `409 stale` with the current item. Undo needs no version: it checks that each item it touched is still at the version the change left it at.
- T1.2: a non-parent gets the same `404` for a "Parents only" item as for a missing one, for every change and for undo, even with a wrong version. Only parents can own one or be its candidates. A preparation is as private as its event, and follows it when the event's visibility changes.
- T1.2: only members with an account can act or own an item (so not Noa). A claim on an item someone else owns is refused (`409 conflict`), so two "I'll take it" taps can't both win. Reassigning is `assign`.
- T1.2: "Remove" is `cancel` (status `cancelled`, kept for Undo). Cancelling an event also cancels its preparations, and one Undo restores them all. Undoing a create removes the item, unless a preparation was added under it since.
- T1.2: a recurring item can't be marked done as a whole. One occurrence is cancelled with `cancel_occurrence` (a local date in `recurrence.exceptions`). `occurrences()` expands weekly items at the same local time, across daylight-saving changes.
- T1.2: items from `screenshot`, `email`, `group` and `ppma` sources are always created as `proposed`, whatever the caller asks.
- T1.2: `Activity.what` is short neutral English with no item title (the board looks up the item). Screens use `kind`, `itemId`, `memberId`, `note`, `ref`.
- T1.1: times in state are ISO strings in UTC. The family's time zone is used only to seed and display. **The human chose (2026-11-04): the zone of the machine running the bridge** (`machineTimezone()` in `seed.ts`), so the board matches the clock on screen. It is written into the state at seed time; a reset picks up a new zone. Tests pass `Asia/Shanghai` explicitly.
- T1.1: `tsconfig.json` now includes `server/homemind`, with the human's OK (2026-11-04), so `npx tsc --noEmit` checks the core.
- T1.1: the demo clock offset is persisted in the state file (`clockOffsetMs`), so a bridge restart keeps the jumped time. Reset sets it to 0. The offset only moves forward.
- T1.1: seeded items, members, preferences and rules carry an optional `titleZh` / `nameZh` / `textZh` / `reasonZh`, so the demo board reads in both languages. User-entered items stay in one language.
- T1.1: an unreadable or wrong-schema state file is moved aside to `<file>.unreadable-<ms>`, never deleted, and the seed is used. `load()` reports `source: 'recovered'`.
- T1.1: member ids are `mom`, `dad`, `maya`, `noa`. Dad's default `lang` is `zh`, the others `en`.
- T0.2: the bridge needs both PPMA tokens. The app token posts events and reads the stream. The owner token is the only one allowed to read memory views and explain. Both stay server-side.
- T0.3: both models were measured, as the human approved. `deepseek-flash` took 16 s with a better answer, and `deepseek-v4-pro` took 89 s. **The human chose `deepseek-flash` (2026-11-04)**, which matches CLAUDE.md. `.env.local` is set to it.
- T0.4: extraction and chat calls send `thinking: {type: "disabled"}`. With reasoning on, Flash can spend the whole `max_tokens` on reasoning and return empty content. With it off, quality was the same and the time halved.
- P0 STOP (2026-11-04, the human approved): (1) no PPMA replay on stage, so run live Flash and keep every scene working without PPMA; (2) `llm.ts` sends `thinking: {type: "disabled"}` and treats empty content as a validation failure; (3) the Family tab always shows the signed-in member and offers switching; (4) PPMA times are converted from UTC to the family's time zone. These override the matching lines in `docs/PLAN.md`.
- Identity (2026-11-04, the human): no password and no PIN. Demo sign-in only: pick a member from the list, switch at any time, and label it "Demo sign-in". Role rules (for example "Parents only") are still enforced on the server.
- T0.4: the human has no real 接龙 screenshot. The extraction fixture is the simulated `e2e/fixtures/homemind/jielong-sample.png`, labelled "Simulated sample" in the image.
- T0.3: PPMA replay is not usable for the demo. Plan: live Flash on stage, with Homemind's deterministic logic carrying every scene if PPMA is slow or down. The fallback options are in `docs/homemind-spikes.md`.
- T0.2: Homemind keeps one long-lived PPMA stream and persists its last stream id, because every connect and disconnect adds a `ppma.app_stream_status` event to PPMA's memory.

## Deviations from the plan

- T1.2: changed T1.1 types, as T1.1 allowed. `UndoPatch` is now `{ items: UndoEntry[] }` (one change can touch several items), with `afterVersion` per item. `Activity` gained `kind`, `itemId`, `memberId`, `note`, `ref`, `undone`. `Ownership` `open` gained optional `handedBackBy` and `note`. Nothing stored used the old shapes (activity was always empty).
- T1.2: the plan's verbs `ack` and `snooze` belong to reminders (T4.1). The core has `confirm` for "I'm on it" on an assignment; the bridge can map `ack` to it. Added `open`, `unassign`, `cancel`, `cancel_occurrence`, which the plan's verb list does not name.
- T0.1: fixed two existing test problems, with the human's OK (2026-11-04). `playwright.config.ts` webServers now pass variables through `env` (works on Windows). `tests/epicVite.test.ts` adds `strictPort: false` (no port race).

## Open issues

| Issue | Found in | Severity | Plan |
| --- | --- | --- | --- |
| `npm ci` reports 5 vulnerabilities (4 moderate, 1 high) in existing dependencies (6 on Node 20). | T0.1 | Low | Existing before this work. Not touched (no dependency changes without asking). |
| Fake PPMA issues no commands, so the `command.outcome` loop and PPMA proposals cannot be tested against it as is. | T0.2 | Medium, for T6.1 | Try `ppma serve --fake-script`, or write `scripts/fake-ppma.mjs` as the plan allows. |
| Fake PPMA's memory entries hold the event type name, not the content. | T0.2 | Low | T0.3 confirmed a real model (Flash) writes real content. Use live Flash for memory tests. |
| PPMA `--inference replay` always misses: every ask has a `NOW` block with the wall-clock time, and `ppma serve` cannot fix the clock. | T0.3 | Medium, for T6.1 and T9 | Use live Flash on stage. Optionally, Homemind saves good PPMA commands and offers them, labelled, when PPMA is offline. A PPMA clock option needs the human's OK. |
| PPMA withholds `command.outcome` from the cloud model (no sensitivity label, so treated as health and financial). | T0.3 | Low | Outcomes are still recorded. Do not widen clearances. |
| PPMA command times come in UTC (`+00:00`). | T0.3 | Medium, for T6.2 | Convert to the family's time zone. Check the demo machine's zone. |
| `npx tsc --noEmit` still does not check `server/*.ts` outside `server/homemind/` (for example the future `server/homemind.ts` adapter), nor `services/` or `vite.config.ts`. | T1.1 | Low | Existing setup. The adapter is covered by bridge tests. Widening `include` further needs the human's OK. |
| `npm test` sometimes fails all 20 files on the first cold run (the summary said "no tests"). The run right after gives the normal result. Seen in T0.2 (Node 20) and T0.3 (Node 22). | T0.2 | Low | Rerun once before investigating. The error was not captured. |

## What needs the human

- [x] DeepSeek endpoint, key and model names (in `.env.local`), for T0.3 and T0.4
- [x] DeepSeek key with balance (replaced on 2026-11-04)
- [x] Model chosen: `deepseek-flash` (2026-11-04)
- [x] OK on the P0 STOP report, including the 4 plan changes (2026-11-04)
- [x] PPMA clone at `../ppma`, for T0.2
- [x] Real 接龙 screenshot: none available. A simulated one is used instead
- [ ] Huawei phone for a browser test, if available, for T9.2
- [ ] Someone to review the Chinese text, for T9.2

## Current settings

Never put keys here.

| Setting | Value |
| --- | --- |
| Base branch | `feat/fridge2table` |
| Work branch | `feat/homemind` |
| LLM mode | live (`.env.local`) |
| Model name | `deepseek-flash` |
| PPMA mode | fake, strict auth, port 18765, for the smoke check only |
| PPMA space | `me` |

## Known baseline

Measured on 2026-11-03 on `feat/fridge2table`, before any Homemind work: `npm test` gave 141 passing tests in 20 files, and `tsc --noEmit` was clean on Node 22. `npm run test:e2e` was not run. Since 2026-11-04 on Node 22.23.4 (Windows), after the two test fixes: `npm test` 141 passed in 20 files, tsc clean, build OK, `npm run test:e2e` 40 passed.

## Demo facts to say out loud

Things that are simulated or limited, kept current for the presenter.

- The demo is the web version, not a native HarmonyOS app.
- The group, vendor, babysitter, inbox and weather are simulated and labeled.
- Real WeChat group access is not available. The realistic product route is sharing and screenshots.
- The 接龙 screenshot used in tests is simulated and says so. Extraction was measured only on that one clean image, not on real photos.
- PPMA's memory and proposals need the live model and network on stage (replay does not work). Without them the board still works, and the memory screen says PPMA is offline.

## Log

Template (copy for each task):

```
### T?.? Task name: done | partial | failed (YYYY-MM-DD)
**Built:** what, and in which files
**Decisions:** and why
**Deviations:** from the plan
**Test results:** commands run and results
**Not done or not verified:**
**Next task should know:**
**How to verify:**
- Commands:
- Expected output:
- Manual check:
```

### T1.2 Item state transitions: done (2026-11-04)
**Built:**
- `server/homemind/core.ts`: `applyChange(state, change, actor, clock)` for `create`, `edit`, `assign`, `open` ("Who's taking this?"), `unassign`, `claim`, `confirm`, `handback` (with note), `done`, `cancel`, `cancel_occurrence`, `approve`, `dismiss`, `undo`. It returns `{ ok: true, state, activity, items, events }` or `{ ok: false, status, code, message, current? }` with status 400, 403, 404 or 409. Each success increments `version`, appends one `Activity` with an Undo patch, and returns `item.changed` events (with `previousVisibility` when an item leaves a view). Also `occurrences()` (weekly expansion with cancelled dates), `preparationsFor()`, `canSee()`, `eligibleOwners()`. Imports only `./clock` and `./types`. Ids come from the clock plus a suffix, so tests are deterministic.
- `server/homemind/types.ts`: see Deviations.
- `tests/homemindCore.test.ts`: 60 tests. Ownership (each transition, Scene 1 assign and confirm, hand back with and without a note, claim race), stale versions (two writers on one version), create, edit, remove, proposed items, preparations under events (including Parents-only inheritance), "Parents only" (no trace for a teen), Undo (once, refused after a later change, create, cascade, permissions), recurrence (one cancelled occurrence, `until`, daylight saving in Berlin), the activity log, and an import check on `core.ts`. The seed state is deep-frozen, so any mutation of the input throws.
**Decisions:** see "Decisions made during the build" (T1.2 entries).
**Deviations:** T1.1 types extended, and the verb set differs from the plan's route list (see "Deviations from the plan").
**Test results:**
- `npm test` before any change: 24 files, 183 passed. After: 25 files, **243 passed**.
- `npx vitest run tests/homemindCore.test.ts`: 60 passed.
- Mutation checks: removing the stale-version check made 3 tests fail; pushing into the input state made 48 fail (deep-freeze). Both reverted, and `git diff` showed `core.ts` back to the tested version.
- `npx tsc --noEmit`: clean. Also the strict command from T1.1 over `server/homemind/*.ts tests/homemind*.test.ts`: clean.
- No UI or route change, so e2e was not run. Not the end of a phase.
**Not done or not verified:** nothing calls `applyChange` yet (the bridge, T2.1). The full per-member view (what a teen's board, search and events contain) is T1.3; the core only refuses changes to items a member can't see. The activity log is not capped yet.
**Next task should know:**
- T1.3 should build `visibility.ts` on `canSee()` from `core.ts` (or move it there and import it back), and filter `activity` by `itemId`. An event with `item: null` (an undone create) carries `previousVisibility`.
- The availability check (T1.3) can use `occurrences()` for recurring items, and should create its `open` proposal through `applyChange` with `{ kind: 'open' }` or a `create` with `proposed: true`.
- The bridge (T2.1) maps `ChangeError.status` straight to the HTTP status, and on `409` returns `current` ("This changed. Here is the latest.").
**How to verify:**
- Commands: `npx vitest run tests/homemindCore.test.ts` · `npm test` · `npx tsc --noEmit`
- Expected output: `Tests  60 passed (60)`. Then `Test Files  25 passed (25)` and `Tests  243 passed (243)`. tsc prints nothing.
- Manual check: in `server/homemind/core.ts`, change `if (change.version !== item.version)` to `if (false)` and run the first command. 3 tests fail, including "two members act on the same version". Then undo the edit with `git checkout server/homemind/core.ts`.

### T1.1 Types, clock, store, seed: done (2026-11-04)
**Built:**
- `server/homemind/types.ts`: domain types from PLAN section 3, plus `HomemindState`, `Recurrence`, `EscalationStep`, `UndoPatch`, `RuleTrigger`, `ID_PATTERN`. No imports at all.
- `server/homemind/clock.ts`: `createDemoClock(base, offset)` with `now`, `advance` (forward only), `setOffset`; `fixedClock` for tests; time-zone helpers `localParts`, `zonedToUtc` (DST gap moves forward, overlap takes the earlier), `addDays`, `toIso`. Pure, `Intl` only.
- `server/homemind/store.ts`: `HomemindStore` with `load` (seed if missing, move aside if unreadable), `save` (snapshot, serialized, temp file then rename, retries a Windows `EPERM`), `reset`. `writeJsonAtomic`, `isHomemindState`, `dataFileFromEnv`.
- `server/homemind/seed.ts`: `seedState({ now, timezone })`. Mom, Dad (parents), Maya (teen, 15), Noa (child, 5, no account), simulated backup contact Grandma Lin. Items: today's critical pickup about 2 h ahead with no owner (Scene 1), Noa's swimming today (Mom), Maya's piano tomorrow, a "Who's taking this?" library task, next Tuesday's pickup owned by Mom (Scene 4 conflict), a Parents-only sensitive counselor meeting, Sunday family dinner with a "buy flowers" preparation. Preferences: the cake for kindergarten parties with its reason and scope (soft), no peanuts (hard). Rule: Friday pizza, 30 min lead, 250 CNY cap.
- Tests: `tests/homemindBoundary.test.ts`, `homemindClock.test.ts`, `homemindStore.test.ts`, `homemindSeed.test.ts`.
**Decisions:** see "Decisions made during the build" (T1.1 entries). The boundary test also forbids React in the core, requires `types.ts` to have no imports, and tests its own scanner on sample code, so it cannot pass by finding nothing.
**Deviations:** none from the task. Added fields beyond the plan's type sketch: `Member.age`, `Member.nameZh`, `Item.titleZh`, `BackupContact.simulated`, `Preference.textZh`/`reasonZh`.
**Test results:**
- `npm test` before any change: 20 files, 141 passed. After: 24 files, **182 passed**.
- `npx vitest run tests/homemind`: 4 files, 41 passed.
- Boundary test checked by mutation: a temporary `server/homemind/zz-violation.ts` importing `../orbit` and `src/lib/zz-violation.ts` importing `seedState` made exactly those 2 tests fail. The files were removed.
- `npx tsc --noEmit`: clean. It does not cover `server/` (Open issues), so also: `npx tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler --allowImportingTsExtensions --skipLibCheck --types node server/homemind/*.ts tests/homemind*.test.ts`: clean.
- No UI or route change, so e2e was not run. Not the end of a phase.
**Not done or not verified:** nothing uses the store yet (T2.1 wires it). Behavior under a real Windows file lock was not reproduced; the rename retry is untested.
**Follow-up, same day (the human's answers):** (1) `tsconfig.json` `include` is now `["src", "server/homemind"]`; checked by mutation (a temporary file with a type error made `tsc` fail, then removed). (2) The seed's default zone is the machine's (`machineTimezone()`, here `Asia/Jerusalem`); `DEFAULT_TIMEZONE` was removed and the seed tests pass `Asia/Shanghai` explicitly, plus one new test for the default. Results: `npx tsc --noEmit` clean, `npm run build` OK, `npm test` 183 of 183 in 4 runs in a row. One earlier run had "1 failed, 174 passed, 9 skipped"; I did not capture which file and could not reproduce it in the 4 runs after. It is probably the known cold-run flake (Open issues), but that is not confirmed.
**Next task should know:**
- `applyChange` (T1.2) should take `Clock` from `clock.ts` and `HomemindState` from `types.ts`. `Activity.undo` is `{ itemId, before }`; change it if T1.2 needs more.
- The bridge (T2.1) should build the clock as `createDemoClock(Date.now, state.clockOffsetMs)`, write `clockOffsetMs` back after a jump, and seed with `seedState({ now: Date.now() })` on reset (offset 0).
- Seed item ids are fixed (`pickup-today`, `pickup-tuesday`, `counselor-meeting`, ...), so tests and later scenes can refer to them.
**How to verify:**
- Commands: `npx vitest run tests/homemind` · `npm test` · `npx tsc --noEmit`
- Expected output: `Test Files  4 passed (4)` and `Tests  42 passed (42)`. Then `Tests  183 passed (183)`. tsc prints nothing (it now covers `server/homemind`).
- Manual check: run `npx tsx -e "import('./server/homemind/seed.ts').then(m => console.log(JSON.stringify(m.seedState({ now: Date.now() }).items.map(i => [i.id, i.start]), null, 1)))"` and confirm `pickup-today` is about 2 hours from now in UTC, and `pickup-tuesday` is next Tuesday at 16:30 in this machine's zone (14:30 UTC in Israel in winter).

### T0.1 Test fixes: done (2026-11-04)
**Built:** with the human's OK, two fixes to existing tests. `playwright.config.ts`: the three webServers pass their variables in `env: {...}` instead of the `VAR=x cmd` prefix, so `npm run test:e2e` runs on Windows. `tests/epicVite.test.ts`: `strictPort: false`, like `epicMediaStream`, which ends the race for port 5173.
**Decisions:** none beyond the fixes.
**Deviations:** none. The temporary Windows config recipe in the T0.1 log is no longer needed.
**Test results:** `npm test`: 20 files, 141 passed. `npx tsc --noEmit`: clean. `npm run test:e2e`: 40 passed, 4.1 min.
**Not done or not verified:** CI on Linux was not run. `env` is standard Playwright behavior, merged over `process.env`.
**Next task should know:** `npm test` and `npm run test:e2e` run as is on this Windows machine.
**How to verify:**
- Commands: `npm test` · `npm run test:e2e`
- Expected output: `Tests 141 passed (141)` · `40 passed`
- Manual check: run `npm test` while `npm run dev` is running. It still passes.

### T0.1 Project setup, follow-up: done (2026-11-04)
**Built:** no code. Node upgraded from 20.17.0 to 22.23.4 with `winget install OpenJS.NodeJS.22`, at the human's request, then `npm ci`. Deleted the untracked `docs/HOMEMIND_BUILD_PLAN.md`, at the human's request.
**Decisions:** Node 22, not the LTS 26: it is the version the baseline was measured on, and it satisfies `>=22.13`.
**Deviations:** none.
**Test results:** Node 22.23.4:
- `npm ci`: no EBADENGINE warnings. 5 audit findings.
- `npm test`: 138 passed + 3 skipped of 141, twice. Port 5173 was free. `npx vitest run tests/epicVite.test.ts`: 3 passed.
- `npx tsc --noEmit`: clean. `npm run build`: OK.
- e2e (Windows config): 40 passed, 3.6 min.
**Not done or not verified:** the two proposed fixes (e2e `env`, `epicVite` `strictPort`) wait for the human's OK.
**Next task should know:** the real cause of the `epicVite` failure is the port race (Open issues). A running dev server is not the cause.
**How to verify:**
- Commands: `node -v` · `npm test` · `npx vitest run tests/epicVite.test.ts`
- Expected output: `v22.23.4`. 19 of 20 files pass, and only `epicVite` fails ("Port 5173 is already in use"). Alone: 3 passed.
- Manual check: `npm ci` prints no `EBADENGINE`.

### T0.4 Spike: images and two windows: done (2026-11-04). End of P0
**Built:** `e2e/fixtures/homemind/jielong-sample.html` and `.png` (simulated, labelled), `scripts/render-jielong-sample.mjs` (renders it with Playwright), `scripts/llm-image-spike.mjs` (screenshot to structured extraction, with validator, retry and 7 fact checks), `scripts/two-windows-spike.mjs` (sessionStorage identity and side-by-side layout, 8 checks). Results in `docs/homemind-spikes.md`.
**Decisions:** reasoning off for extraction (see Decisions). A generic chat look with no WeChat branding, so the fixture imitates no real product.
**Deviations:** a simulated screenshot instead of a real one, at the human's request.
**Test results:**
- `node scripts/llm-image-spike.mjs --runs 3`: PASS, 7/7 facts in 3 of 3 runs, 2.7 to 3.1 s each, no retries. `--thinking on`: 7/7, 6.0 s.
- Direct probes: the endpoint accepts `image_url` data URLs. Flash with 600 tokens and reasoning on returned empty content (`finish_reason: length`). `thinking: {type: "disabled"}` returned a right answer in 2 s.
- `node scripts/two-windows-spike.mjs`: PASS, 8 checks (separate windows keep separate identities, localStorage is shared, `window.open` or Duplicate tab copies the opener's identity, a second profile shares nothing, no horizontal scroll at 720, 640 and 390 px).
- **Phase-end checks (P0), flag off** (`HOMEMIND_ENABLED` unset in the shell and absent from `.env.local`): `npm test` 141 of 141, `npm run test:e2e` **40 of 40** (3.8 min), `npm run build` OK (4.5 s), `npx tsc --noEmit` clean. The Family tab and `/api/homemind/*` are absent, since no Homemind code exists yet (`server/homemind*`, `src/lib/homemind*` and `FamilyView` do not exist). The base app behaves as before.
**Not done or not verified:** a real or blurry 接龙 photo. An instruction hidden inside an image (T5.1). The Family tab layout (T3).
**Next task should know:**
- A window opened from another starts with a copy of its session, so the Family tab must show the signed-in member and allow switching, and `?member=` must override a copied session.
- The welcome deck covers the app until skipped once per browser profile. Skip it in both profiles before the demo, and in e2e set `STORAGE_KEYS.welcomeSeen`.
- Use `readEnvFile` from the spike scripts as the pattern for reading `.env.local` without printing keys. The bridge itself uses Vite's `loadEnv`.

**P0 STOP report** (PLAN section 4: what works, latency, changes to the plan):
- Works: the PPMA contract (21 checks), PPMA with Flash (memory and proposals in about 16 s), screenshot extraction (7/7, about 3 s), and two identities in one profile through `sessionStorage`.
- Latency: Flash chat call about 1 to 2 s, screenshot extraction about 3 s, PPMA per event 15 to 17 s in the background (4 model calls, about 15K tokens).
- Changes to the plan, for the human to approve:
  1. PPMA replay through `ppma serve` cannot work (a wall-clock time in every ask). On stage use live Flash, and keep every scene working without PPMA. The plan's "record with `--inference record` and replay with `--cassette`" is dropped unless the PPMA owners add a fixed clock.
  2. `llm.ts` sends `thinking: {type: "disabled"}`, and treats empty content as a failed validation.
  3. Identity: show the current member and allow switching in the Family tab, because a duplicated window copies the session.
  4. PPMA command times come in UTC. Homemind converts them to the family's time zone.

### T0.3 Spike: PPMA with DeepSeek: done (2026-11-04)
**Built:** the T0.3 results section in `docs/homemind-spikes.md`. `scripts/ppma-model-spike.mjs` fixes: `not_cleared` is a subset of `permanent` (it was counted twice), and the report lists asks that the flow policy withheld.
**Decisions:** measured both models before choosing. Recommend Flash and wait for the human. Do not change PPMA to get replay working.
**Deviations:** none from the plan. The plan's fallback, "keep PPMA for memory and recorded proposals", can't use PPMA replay (see Open issues).
**Test results:**
- Direct probe with the new key: `deepseek-flash` 200 in 1.0 s. `deepseek-v4-pro` 200 in 1.4 s, with empty content at 20 tokens (it reasons first).
- `ppma-model-spike.mjs --model deepseek-flash`: PPMA idle after 17.0 s, 4 asks, 4 calls, 13.7K tokens in, 1.6K out. One memory entry with the content. Two commands (shopping item, and a proposed item on Thursday 2026-11-05). Confidence 0.5. Explain works.
- `--model deepseek-v4-pro`: 89.2 s, 4 asks, 4 calls, 5.0K tokens out. Memory entry right. Two commands, but the proposed item has no date. PASS.
- `--model deepseek-flash --inference record`: 15.4 s, 4 records in the cassette, one command this time. PASS.
- `--inference replay` with that cassette: `replay miss: task=ingest.gate`, nothing processed, exit 1. Cause: the `NOW` block in every ask.
- `npx tsc --noEmit`: clean (Node 22.23.4). `npm test`: the first, cold run failed all 20 files with "no tests" (the known flake). The next two runs passed 141 of 141.
- No UI change, so e2e was not needed.
**Not done or not verified:** the model choice is the human's. A replay with a frozen clock was not tried, because that would change PPMA.
**Next task should know:** T0.4 uses the same `.env.local`. Read the key with code that never prints it (see `readEnvFile` in `scripts/ppma-model-spike.mjs`). For images, check first whether the endpoint accepts `image_url` content, with one small request.
**How to verify:**
- Commands: `node scripts/ppma-model-spike.mjs --model deepseek-flash; echo $?`
- Expected output: `PPMA idle: yes after` about 15 to 20 s, one memory statement about the kindergarten party, at least one `homemind.*` command, `PASS: the model answered every ask it was sent`, then `0`. The wording varies between runs.
- Manual check: compare the "Results" table in `docs/homemind-spikes.md` with your own run. The DeepSeek usage page should show a few requests of about 15K tokens each.

### T0.3, first attempt: blocked (2026-11-04)
**Built:** `scripts/ppma-model-spike.mjs`: starts PPMA (`--profile fake`, in memory; `--agent openai`, `--agent-clear personal`, strict auth, port 18766) with `PPMA_LLM_*` taken from `.env.local`, never printing the key. It posts the kindergarten message as `homemind.message_received` (fixed id and time, so a replay sees the same input), answers any command, waits for PPMA to go idle, and reports memory statements, commands, model asks, calls, tokens, latency and failures. Supports `--inference record|replay --cassette`. The manifest moved to `scripts/ppma-homemind-manifest.json`, shared with `ppma-smoke.sh`. Committed in `23c922f`.
**Decisions:** `--profile fake` with `--agent openai`, so nothing goes into `~/.local/share/ppma`. Measure both models before choosing (the human approved).
**Deviations:** none.
**Test results:** `GET /models` returns 200 and lists `deepseek-flash` and `deepseek-v4-pro`. Five tiny direct `/chat/completions` probes all return `402 Insufficient Balance`. One spike run: PPMA's first ask (`ingest.gate`) failed with `PermanentInferenceError` after 2 s, so there were no memory entries and no commands. The script now reports that as FAIL with exit code 1, which I checked. `bash scripts/ppma-smoke.sh` still passes 21 checks after the manifest move.
**Not done or not verified:** everything that needs model answers: memory content, commands, latency, call counts, record and replay, and the Flash versus Pro comparison.
**Next task should know:** after the top-up, run `node scripts/ppma-model-spike.mjs --model deepseek-flash`, then `--model deepseek-v4-pro`. Record with `--inference record --cassette <path outside the repo>` and replay with `--inference replay --cassette <same path>`. PPMA logs only the error class, not the HTTP body, so check a failure with a direct probe.
**How to verify:**
- Commands: `node scripts/ppma-model-spike.mjs --model deepseek-flash --wait 120; echo $?`
- Expected output now: `FAIL: 1 model call(s) failed` and `1`. After the top-up: `PASS: the model answered every ask` and `0`.
- Manual check: on the DeepSeek platform, the balance page shows the account at 0.

### T0.2 Spike: PPMA contract: done (2026-11-03)
**Built:** `scripts/ppma-smoke.sh`, which starts a throwaway fake PPMA from `../ppma` (strict auth, port 18765, random owner token), then registers the draft Homemind manifest, mints an app token, posts events, reads the stream with resume, reads memory views, posts a correction, calls explain, and revokes the token. 21 checks, PASS or FAIL, exit code 0 or 1. `--external` checks a running PPMA at `PPMA_URL`. `docs/homemind-spikes.md` holds the exact field names, the permission table and what the fake profile does.
**Decisions:** The script defaults to starting its own server, because `--external` writes test events and rotates the app token, and port 8765 may be a real PPMA install with real data. It needs only bash, curl and node, so there is no `jq` or Python dependency. The draft manifest follows PLAN section 3, with no tool that sends or orders, and `responds_to_ppma: false` on `homemind.message_received`.
**Deviations:** none from the plan. Extra checks beyond the plan: correction, explain, error cases and revocation.
**Test results:**
- `bash scripts/ppma-smoke.sh`: PASS, 21 checks, 70 s. The two failures in the first run were bugs in the script (curl writes no file when nothing arrives; a wrong argv index). PPMA was right both times.
- Fail paths: `PPMA_DIR=/nonexistent` prints "no PPMA clone" and exits 1. `--external` with nothing listening prints "is PPMA running at ...?" and exits 1.
- `npx tsc --noEmit`: clean. `npm test`: 19 of 20 files, 138 passed and 3 skipped, the same as the baseline (`epicVite`: port 5173 in use by the running dev server). The first `npm test` of the chat failed all 20 files once, before any change, and passed normally on rerun (see Open issues).
- `../ppma`: `git status` clean after the work. `uv sync` created only its git-ignored `.venv`.
**Not done or not verified:** the `command.outcome` loop, because fake PPMA issues no commands. `--auth dev` mode was not run, though the script detects it and skips the permission checks.
**Next task should know:**
- Owner token: `PPMA_OWNER_TOKEN`, else `~/.config/ppma/setup-token` (created on the first strict start).
- `--inference record` refuses a cassette inside a git work tree unless `--synthetic` is passed. Keep cassettes outside this repo.
- Cloud engines see `personal` events only with `--agent-clear personal`.
**How to verify:**
- Commands (Git Bash, from the repo root, with port 18765 free): `bash scripts/ppma-smoke.sh; echo $?`
- Expected output: 21 lines starting with `PASS`, then `PASS: 21 checks`, then `0`. It takes about 1 to 2 minutes.
- Manual check: run `PPMA_DIR=/nonexistent bash scripts/ppma-smoke.sh` and confirm a clear `FAIL: no PPMA clone` and exit code 1. Then open `docs/homemind-spikes.md` and compare one field list with `../ppma/contracts/src/ppma_contracts/manifest.py`.

### T0.1 Project setup: partial (2026-11-03)
**Built:** `.homemind/` added to `.gitignore`. All Homemind and PPMA env vars from PLAN section 3 added to `.env.example`, commented out, with no values. `specs/004-homemind-a2ui/spec.md` written: a short summary that points to `docs/PLAN.md`. Also committed `CLAUDE.md`, `docs/PLAN.md` and `docs/PROGRESS.md`, so later chats share them.
**Decisions:** `.env.example` lists the vars commented out, like the existing Orbit/Fridge2Table sections, so copying it changes nothing. `HOMEMIND_LLM` is shown as `fake`, so a copied file never runs live by accident.
**Deviations:** e2e ran through a temporary Windows-syntax copy of `playwright.config.ts` (same servers, ports and tests). The repo config was not changed.
**Test results:** on `feat/homemind`, Node v20.17.0, Windows 11:
- `npm ci`: OK. EBADENGINE warnings (Node 22.13+ wanted) and 6 audit findings, both existing before this work.
- `npm test`: 19 of 20 files passed, 138 passed + 3 skipped of 141. The 3 skipped are `tests/epicVite.test.ts`, which failed in `beforeAll` with "Port 5173 is already in use" because a DigitalMate dev server (node PID 7968) was already running. I did not stop it, since it wasn't mine. Same result before and after the changes.
- `npx tsc --noEmit`: clean.
- `npm run build`: OK (tsc + vite build, 6 s).
- `npm run test:e2e`: fails to start on Windows (see Open issues). With the Windows config: **40 passed** (app, epic-replay, fridge2table), 4.0 min.
**Not done or not verified:** the 3 `epicVite` tests, until 5173 is free. Everything else matches the known baseline.
**Next task should know:**
- To run e2e on this machine until the config is fixed, copy `playwright.config.ts` outside the repo. Set `testDir`/`outputDir`/`cwd` to absolute repo paths. Rewrite each command as `set FAKE_EPIC_PORT=18010&& node ...` (no space before `&&`). Run with `NODE_PATH=<repo>/node_modules npx playwright test --config <copy>`.
- Stop any `npm run dev` before `npm test`.
**How to verify:**
- Commands (Git Bash, with no dev server running on 5173):
  `npm test` · `npx tsc --noEmit` · `git check-ignore -v .homemind/x` · `grep -c "HOMEMIND_\|PPMA_" .env.example`
- Expected output: 20 files, 141 passed. tsc prints nothing. `.gitignore:37:.homemind/  .homemind/x`. `14`.
- Manual check: open `specs/004-homemind-a2ui/spec.md` and confirm its links to `docs/PLAN.md`, `CLAUDE.md` and `docs/PROGRESS.md` open.
