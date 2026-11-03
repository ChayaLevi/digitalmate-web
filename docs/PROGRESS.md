# Homemind: progress

Update this file at the end of every task, per the session protocol in `CLAUDE.md`. Keep old log entries. Newest entry goes first.

## Where we are

- **Current task:** T0.1 partial (only the 3 `epicVite` tests are left to confirm, see log)
- **Next task:** T0.2
- **Scenes working end to end:** none
- **Blocked on:** nothing. T0.2 needs the PPMA clone at `../ppma`
- **Last updated:** 2026-11-03, after T0.1

## Task status

Status values: `not started`, `in progress`, `partial`, `done`, `skipped`, `cut`.

| Task | Name | Status | Note |
| --- | --- | --- | --- |
| T0.1 | Project setup | partial | All set up. `epicVite` (3 tests) not run: port 5173 was in use by a running dev server |
| T0.2 | Spike: PPMA contract | not started |  |
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

- None yet.

## Deviations from the plan

- T0.1: `npm run test:e2e` cannot start on Windows, so e2e ran through a temporary config instead (see Open issues and the T0.1 log).

## Open issues

| Issue | Found in | Severity | Plan |
| --- | --- | --- | --- |
| `npm run test:e2e` fails on Windows: `playwright.config.ts` webServer commands use `VAR=x cmd`, which `cmd.exe` rejects ("'FAKE_EPIC_PORT' is not recognized"). | T0.1 | High: every UI task needs e2e | Proposed fix, waiting for the human's OK: move the variables into each webServer's `env: {...}` field. Until then, use the Windows config recipe in the T0.1 log. |
| `tests/epicVite.test.ts` needs port 5173 free: vite.config.ts sets `port: 5173, strictPort: true`, and the test's `port: 0` doesn't override it. A running `npm run dev` makes the suite fail. | T0.1 | Low | Stop the dev server before running `npm test`. |
| Node here is v20.17.0. `@axe-core/playwright`, `@capacitor/cli` and `pdfjs-dist` want Node >=22.13 (EBADENGINE warnings). Tests, tsc and build still pass. | T0.1 | Low | Upgrade to Node 22 when convenient. The baseline was measured on Node 22. |
| `npm ci` reports 6 vulnerabilities (5 moderate, 1 high) in existing dependencies. | T0.1 | Low | Existing before this work. Not touched (no dependency changes without asking). |
| `docs/HOMEMIND_BUILD_PLAN.md` is untracked and looks like an older draft of `docs/PLAN.md`. | T0.1 | Low | Left uncommitted. The human decides whether to keep or delete it. |

## What needs the human

- [ ] DeepSeek endpoint, key and exact model name, for T0.3 and T0.4
- [ ] PPMA clone at `../ppma`, for T0.2
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
| PPMA mode | not set |
| PPMA space | `me` |

## Known baseline

Measured on 2026-11-03 on `feat/fridge2table`, before any Homemind work: `npm test` gave 141 passing tests in 20 files, and `tsc --noEmit` was clean on Node 22. `npm run test:e2e` was not run. T0.1 confirmed these on Node 20.17 (Windows), except `epicVite` (port in use). e2e: 40 passed, using a Windows-syntax config.

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
