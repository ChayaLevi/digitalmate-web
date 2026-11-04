# Homemind: progress

Update this file at the end of every task, per the session protocol in `CLAUDE.md`. Keep old log entries. Newest entry goes first.

## Where we are

- **Current task:** T0.1 and T0.2 done. Node upgraded to 22.23.4
- **Next task:** T0.3
- **Scenes working end to end:** none
- **Blocked on:** T0.3 needs the DeepSeek endpoint, key and model name
- **Last updated:** 2026-11-04, after the T0.1 follow-up

## Task status

Status values: `not started`, `in progress`, `partial`, `done`, `skipped`, `cut`.

| Task | Name | Status | Note |
| --- | --- | --- | --- |
| T0.1 | Project setup | done | Baseline recorded on Node 22.23.4. `epicVite` fails only in the full run, from a port race between two existing tests (Open issues) |
| T0.2 | Spike: PPMA contract | done | `scripts/ppma-smoke.sh` passes 21 checks against fake PPMA. Facts in `docs/homemind-spikes.md` |
| T0.3 | Spike: PPMA with DeepSeek | not started |  |
| T0.4 | Spike: images and two windows | not started |  |
| T1.1 | Types, clock, store, seed | not started |  |
| T1.2 | Item state transitions | not started |  |
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

- T0.2: the bridge needs both PPMA tokens. The app token posts events and reads the stream. The owner token is the only one allowed to read memory views and explain. Both stay server-side.
- T0.2: Homemind keeps one long-lived PPMA stream and persists its last stream id, because every connect and disconnect adds a `ppma.app_stream_status` event to PPMA's memory.

## Deviations from the plan

- T0.1: `npm run test:e2e` cannot start on Windows, so e2e ran through a temporary config instead (see Open issues and the T0.1 log).

## Open issues

| Issue | Found in | Severity | Plan |
| --- | --- | --- | --- |
| `npm run test:e2e` fails on Windows: `playwright.config.ts` webServer commands use `VAR=x cmd`, which `cmd.exe` rejects ("'FAKE_EPIC_PORT' is not recognized"). | T0.1 | High: every UI task needs e2e | Proposed fix, waiting for the human's OK: move the variables into each webServer's `env: {...}` field. Until then, use the Windows config recipe in the T0.1 log. |
| `tests/epicVite.test.ts` always fails in a full `npm test` with "Port 5173 is already in use", even with the port free. It passes alone (3/3). Cause: Vite treats `port: 0` as unset, so `epicVite` and `epicMediaStream` both start on 5173 in parallel. `epicMediaStream` sets `strictPort: false` and moves to another port. `epicVite` inherits `strictPort: true` from vite.config.ts and fails. (T0.1 first blamed the running dev server. That was wrong.) | T0.1 | Medium: `npm test` is never fully green | Proposed fix, waiting for the human's OK: add `strictPort: false` to the `server` options in `tests/epicVite.test.ts`, as `epicMediaStream` already does. Until then, confirm with `npx vitest run tests/epicVite.test.ts`. |
| `npm ci` reports 5 vulnerabilities (4 moderate, 1 high) in existing dependencies (6 on Node 20). | T0.1 | Low | Existing before this work. Not touched (no dependency changes without asking). |
| Fake PPMA issues no commands, so the `command.outcome` loop and PPMA proposals cannot be tested against it as is. | T0.2 | Medium, for T6.1 | Try `ppma serve --fake-script`, or write `scripts/fake-ppma.mjs` as the plan allows. |
| Fake PPMA's memory entries hold the event type name, not the content. The demo's memory screen needs a real model. | T0.2 | Medium, for T6.2 | T0.3 checks a real model. |
| `npm test` once failed all 20 files on the first cold run (the summary said "no tests"). The run right after gave the normal result. | T0.2 | Low | Rerun once before investigating. |

## What needs the human

- [ ] DeepSeek endpoint, key and exact model name, for T0.3 and T0.4
- [x] PPMA clone at `../ppma`, for T0.2
- [ ] A real 接龙 screenshot, if available, for T0.4
- [ ] Huawei phone for a browser test, if available, for T9.2
- [ ] Someone to review the Chinese text, for T9.2

## Current settings

Never put keys here.

| Setting | Value |
| --- | --- |
| Base branch | `feat/fridge2table` |
| Work branch | `feat/homemind` |
| LLM mode | not set |
| Model name | not set |
| PPMA mode | fake, strict auth, port 18765, for the smoke check only |
| PPMA space | `me` |

## Known baseline

Measured on 2026-11-03 on `feat/fridge2table`, before any Homemind work: `npm test` gave 141 passing tests in 20 files, and `tsc --noEmit` was clean on Node 22. `npm run test:e2e` was not run. Confirmed 2026-11-04 on Node 22.23.4 (Windows): tsc clean, build OK, e2e 40 passed (with a Windows-syntax config). `npm test`: 138 passed + 3 skipped of 141. The 3 are `epicVite`, from the port race in Open issues, and they pass alone.

## Demo facts to say out loud

Things that are simulated or limited, kept current for the presenter.

- The demo is the web version, not a native HarmonyOS app.
- The group, vendor, babysitter, inbox and weather are simulated and labeled.
- Real WeChat group access is not available. The realistic product route is sharing and screenshots.

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
