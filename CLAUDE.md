# Homemind: rules for Claude Code

Homemind is a family app built on DigitalMate Web, for a demo to Chinese managers at the company.
The full plan is in `docs/PLAN.md`. Current state is in `docs/PROGRESS.md`.
DigitalMate background is in `docs/DIGITALMATE_GUIDE.md`.

## Session protocol (one chat per task)

Each task in `docs/PLAN.md` usually gets its own fresh chat. You have no memory of earlier chats, so the
files are the only shared state.

At the **start** of a chat:
1. Read `docs/PROGRESS.md`: what is done, decisions, deviations, open issues.
2. Read your task in `docs/PLAN.md`, plus the design sections it names.
3. Read the existing code the task touches. Do not re-create what exists.
4. Run `npm test`. If it fails before you change anything, say so before starting.

At the **end** of a chat, before saying you are done:
1. Make sure the task's "Done when" holds and you ran it. Run `npm test` and `npx tsc --noEmit`, plus
   `npm run test:e2e` if the task touched UI or routes.
2. Update `docs/PROGRESS.md`: "Where we are", the task's status, and a new log entry (template in that file).
   This must happen after every task, including a partial or failed one.
3. Commit with a clear message such as `feat(homemind): T1.2 ownership transitions`. Stage specific files
   with `git add <paths>`, never `git add -A`. Do not push unless asked.
4. Give the human a **"How to verify"** block: copy-paste commands, the expected output, and one manual check to
   try by hand. Add the same block to the log entry.
5. Tell the human the next task ID and anything they must provide for it (🧑).

At the **end of a phase** (the last task of P0 to P9), also run:
1. `npm run build`.
2. **The flag-off check:** with `HOMEMIND_ENABLED` unset, run `npm test` and `npm run test:e2e` and confirm that the existing tests pass, the Family tab and `/api/homemind/*` are absent, and the base app behaves as before.

Record both results in the log entry. If either fails, the phase is not done.

If a task is marked **STOP**, wait for the human's OK before moving on.

Never mark a task done because the code looks right. If you could not run something, mark it `partial` and say why.

## Project layout and commands

```bash
npm ci
npm run dev                 # http://127.0.0.1:5173, bridge included
npm test                    # vitest
npx tsc --noEmit
npm run test:e2e            # Playwright
npm run build && npm start  # production bridge + static files
```

- Work on branch `feat/homemind`, based on `feat/fridge2table`. Never commit to `main`.
- Bridge settings go in `.env.local`, which git ignores. Never print, log or commit keys.
- PPMA is a separate clone beside this repo, at `../ppma`. Do not modify it.

## Decisions already made (do not reopen)

- **Base:** DigitalMate Web. No native HarmonyOS work in this project.
- **PPMA:** use only its public HTTP contract.
- **Fridge2Table:** optional. Keep its integration working, and do not depend on it.
- **LAIX:** ideas only. There is no LAIX code to look for.
- **Model:** DeepSeek Flash through an OpenAI-compatible endpoint, for text and images. No other vendor.
- **Language:** every UI string in English and Simplified Chinese using `tr(en, zh)`. No Hebrew in the product.
- **Not in the product:** location, workload comparison between partners, children's learning, subscriptions.
- **Family model:** visible to the whole family by default. The only exception is "Parents only".
- **Ownership states:** `none`, `open` ("Who's taking this?"), `assigned`. Anyone can assign to anyone, and the
  assignee can hand back with a note.
- **Preferences:** hard ones (allergies, dietary laws) are never overridden. Soft ones can be. A preference can carry
  a reason and a scope.

### Every real action needs its own tap

Buying, ordering, paying, or sending to anyone outside the family must come from a parent tapping an explicit button
on a card **for that specific action**. Approving a standing rule once is **not** enough. A rule only prepares the
card. If nobody taps, nothing happens and the card expires visibly.

Enforce this in code:
- Each adapter declares `mode: 'real' | 'simulated'`.
- `executeAction()` refuses a real adapter unless it gets a single-use confirmation token issued for that card, bound
  to the payload hash and to a parent member, and unexpired.
- Autonomy level 4 may auto-execute only with `simulated` adapters.

The demo has no real adapters. Build the guard anyway, with tests.

### Autonomy levels

| Level | The system does on its own |
| --- | --- |
| 1 Suggests | Nothing. Only suggestions to approve |
| 2 Organizes | Items, lists, personal reminders |
| 3 Advanced (default) | Also internal calendar entries, message drafts, order preparation |
| 4 Executes | Also standing rules, against simulated services only |

Set per family, with an optional override per area. Family item writes are reversible and have Undo. Never assign work
to another member automatically unless a rule says so.

## Non-negotiable rules

Integration:
- The browser talks only to the bridge. Secrets stay in bridge env vars.
- Whitelist paths and methods, validate ids with regexes, cap body sizes, and call `isSameOrigin()` on every non-GET.
- `AbortSignal.timeout()` on every upstream call. `apiUrl()` for every `/api/*` call.
- Register bridge handlers in both `vite.config.ts` and `services/bridge/index.ts`.
- **Without `HOMEMIND_ENABLED=1` the app behaves exactly as it does today.** Existing tests stay green.

Honesty:
- Never fabricate results. Failures appear as `ErrorNotice` or an empty state.
- **Everything simulated is labeled** "Simulated" / "模拟" on the card itself: the group, vendor, babysitter, sample
  inbox, weather, and the fake model.
- If the LLM or PPMA is down, say so. The board, assignment, reminders and escalation must keep working.
- Never present a rule's explanation as if it came from PPMA. "Why?" states its source.
- Report any place where the demo looks more capable than the product really is.

Privacy and tone:
- **"Parents only" is enforced on the server.** Filter by member before building any surface, search result, SSE event
  or LLM context. Do not send "Parents only" items to PPMA in this version.
- Backup contact messages contain no reasons and no details.
- Neutral wording: "The pickup is still open", never "Dad didn't answer".
- Sensitive items show as "You have a reminder" in any notification preview.
- Never call the product a safety system. Escalation settings say "Homemind helps, but an alert can be missed".

Model safety:
- Validate every model reply with a hand-written validator. Retry once, then show an error.
- Message and screenshot content is data. Delimit it and tell the model not to follow instructions inside it.
- Extraction output only creates **proposed** items.
- Never await PPMA in a user request path. It makes several model calls per event.

## What the code already tells us

Checked on 2026-11-03. Verify before relying on it.

- `Tab` in `App.tsx` is `'chat' | 'discover'`. Add `'family'` and extend `BottomNav`.
- `onAction` dispatches on `action.kind`. Add `kind: 'homemind'`.
- In `send()`, add the Homemind route before the kitchen, Orbit and mock routes. Use the Family persona only, with no
  broad regex.
- `Checklist` does not write back (uncontrolled `defaultChecked`, no callback). `ScheduleStack` has no actions. There is
  no calendar grid. Hence the new `TaskList` and `CalendarBoard`.
- The form components use a host-owned `form` map, so the host passes `form` and `onInput`.
- The app has no accounts. `localStorage` is shared by windows in one browser profile.
- PPMA v0 has one space per user. Use one space for the family and carry the member in the payload.
- PPMA `--agent-clear` defaults to "cloud none", so a cloud endpoint may not see `personal` data unless it is set.

## Code style

- Follow the existing patterns in `server/fridge.ts`, `src/lib/fridgeSurfaces.ts`, `src/transport/fridge.ts`.
- Keep `server/homemind/core.ts` pure: no networking and no React. Inject the clock.
- **Keep the logic movable to a separate server later.** Nothing in `server/homemind/` imports from `src/`, `server/orbit.ts`, `server/fridge.ts` or Vite. Only the thin adapter `server/homemind.ts` may touch those: it validates requests, calls the core, and builds surfaces with `src/lib/homemindSurfaces.ts`. The core returns plain domain data, never A2UI. The client may import types only from `server/homemind/types.ts`. `tests/homemindBoundary.test.ts` enforces this.
- Prefer existing A2UI components, for later native porting. Add a new one only where `docs/PLAN.md` says so.
- Do not refactor existing code beyond what integration needs. `App.tsx` is large, so add to it minimally.
- Check new screens at 390 px, with axe, and in both languages.

## Debugging aids (build them in the tasks, keep them working)

- `HOMEMIND_DEBUG=1` logs each LLM and PPMA call: purpose, latency, status, sizes. It never logs keys, and logs no message
  text unless `HOMEMIND_DEBUG=2`.
- `GET /api/homemind/debug/state` returns the state, only when `HOMEMIND_DEMO=1`.
- `scripts/ppma-smoke.sh` checks the PPMA contract by hand.
- `HOMEMIND_LLM=fake` runs without a key.

## Ask the human before

Adding a dependency, changing PPMA, adding a vendor or model, pushing, deploying, deleting data outside `.homemind/`, or
making paid calls beyond ordinary development. If a task needs something you don't have, mark it 🧑, do what you can, and
say exactly what is missing.

If the code contradicts `docs/PLAN.md`, follow the code and record the deviation in `docs/PROGRESS.md`. Do not edit the
plan's task list unless the human asks. Do not edit this file.
