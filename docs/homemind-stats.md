# Homemind: measured numbers

Only numbers from runs, with the date, the machine and the mode. **Live** means the real DeepSeek Flash
model over the network. **Fake** means the simulated model (`HOMEMIND_LLM=fake`, canned keyword replies),
which says nothing about what the real model understands. Machine: the development laptop (Windows 11,
Node 22.23.4, zone Asia/Jerusalem). PPMA was off in every run below.

Measured on 2026-11-10 (T9.1). Re-measure in T9.2 and on the demo laptop.

## Tests

| What | Result | Mode |
| --- | --- | --- |
| Unit tests (`npm test`) | 1005 passed, 1 skipped, 1 failed: a known PPMA timing test (10 s timeout under full-suite load). It passed alone right after (33 of 33). So 1006 of 1006 pass, with one rerun. | Fake model, simulated PPMA |
| Unit tests at 22:09 local (`TZ=Pacific/Kiritimati`, a Tuesday evening) | 1004 passed, 1 skipped, 1 failed: the same PPMA timing flake, passed on rerun. Before T9.1 one evening test and one Tuesday test failed. | Fake |
| e2e, whole suite (`npm run test:e2e`, 10:51 local) | **73 passed** (13.9 min): 44 base app, 29 Homemind | Fake model, PPMA unreachable on purpose |
| e2e, Homemind file at 22:21 local (`TZ=Pacific/Kiritimati`) | **29 passed** (7.9 min). Before T9.1, three tests failed after about 21:30. | Fake |
| Type check (`npx tsc --noEmit`) | clean | |
| Build (`npm run build`) | OK (only the existing chunk-size warning) | |

## Scenes

Each scene has an e2e test in `e2e/homemind.spec.ts` that runs it in two browser windows (Mom in English,
Dad in Chinese), with axe and 390 px checks. All passed in both e2e runs above.

| Scene | e2e test | Mode |
| --- | --- | --- |
| 1. Assignment and escalation | "Scene 1: …" and "demo panel: …" | Fake (no model in this scene) |
| 2. Kindergarten group (claim, Change to cake, update message) | "Scene 2: …"; screenshot part "screenshot (T5.3): …" | Fake |
| 3. A day gone wrong | "Scene 3: …" | Fake |
| 4. Wedding, pizza, babysitter | "Scene 4: …" | Fake |
| 5. Judgment and correction | "Scene 5: …" | Fake |

The model-dependent steps with the **live** model, through the real bridge code on each scene's preset
(`npx tsx scripts/homemind-live-check.mts --runs 3`, 2026-11-10 08:38 UTC): **21 of 21 passed**.

| Check | Preset | Passed |
| --- | --- | --- |
| 接龙 screenshot → party this Thursday 15:00, everything proposed | Scene 2 (Monday 10:00) | 3 of 3 |
| "Noa is sick today" → situation with at least 2 suggestions | Scene 3 (weekday 14:30) | 3 of 3 |
| "I'm at my cousin's wedding from Tuesday to Saturday" → Tuesday pickup becomes "Who's taking this?" | Scene 4 (Sunday 12:00) | 3 of 3 |
| The same sentence | Monday 10:00 | 3 of 3 |
| "What's on today?", "Add a task: buy milk tomorrow", "Dad takes the kindergarten pickup today" | Scene 1 | 9 of 9 |

Before a prompt fix in T9.1, the wedding sentence failed 3 of 3 with the live model (it was read as a
"situation"). The fake model never showed this.

## Latency with the live model

Wall time of one `POST /chat` through the bridge (in process, no browser), 3 runs each, in ms. The model's
own share is within 15 ms of these. Network: office connection to the DeepSeek endpoint.

| Request | Min | Median | Max |
| --- | --- | --- | --- |
| Screenshot (接龙 sample, 390 px at 2x) | 2501 | 2832 | 2884 |
| Sick report ("Noa is sick today") | 1032 | 1049 | 1219 |
| Wedding (Sunday) | 1321 | 1398 | 1491 |
| Wedding (Monday) | 992 | 1156 | 1266 |
| Question | 1118 | 1148 | 1332 |
| Add a task | 1047 | 1173 | 1202 |
| Assign | 832 | 859 | 1039 |

An earlier run the same morning, before the fix, gave the screenshot 2777 to 3586 ms and the sick report
1048 to 1233 ms.

## Sync between two windows

`node scripts/measure-sync.mjs --runs 10` against a local dev server (fake model; the model is not involved):
from Mom's tap on "Assign to Dad" to Dad's row showing "assigned", without a reload, in two separate browser
contexts on the same machine.

| Runs | Min | Median | Max |
| --- | --- | --- | --- |
| 10 | 428 ms | 580 ms | 1061 ms |

This includes the 150 ms the window waits to group several changes into one re-read. Over Wi-Fi to a phone
it was not measured.

## Not measured

- PPMA live (memory and proposals): T0.3 measured about 16 s per event. Not run again.
- A real phone, a Huawei browser, or a second device over Wi-Fi.
- Real (photographed) 接龙 screenshots: only the simulated sample.
- A full five-scene run with timing (T9.2).
