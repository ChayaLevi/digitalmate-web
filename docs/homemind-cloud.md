# Homemind in the cloud (P10: quick deploy)

First version, 2026-11-10. P10 puts **today's single demo family** on Render behind an **access code**, so the team
lead gets a link. There are no accounts yet (P12): everyone who has the code shares one family and picks who they are
("I am Mom"). P11 to P14 (Postgres, accounts, several families) are not built.

## 1. What runs where

| Part | In the cloud (P10) |
| --- | --- |
| Family tab (Homemind) | Works. One shared demo family, the member picker behind the access code, the demo panel and the demo clock |
| Main chat | Works on its in-browser mock (no Orbit) |
| Discover | Works through `/api/rss` (behind the access code) |
| Labs (Epic Replay), kitchen questions (Fridge2Table) | Their usual error state: `/api/epic/*` and `/api/fridge/*` answer 404 in cloud mode, always |
| Orbit | `/api/orbit/*` answers 404 in cloud mode, always |
| `/api/homemind/debug/state` | 404 in cloud mode, even with `HOMEMIND_DEMO=1` |
| PPMA | Off (no `PPMA_*` variables). The Family tab shows "PPMA offline" only if it was configured; Memory shows only what Homemind saved |
| The model | DeepSeek Flash, live, with your key. **Everyone past the access code spends it** |

## 2. The service

The service was created by hand in the Render dashboard (not from a Blueprint):

- Web Service, Node, region **Singapore**, branch **`feat/homemind`**, **Starter** instance (always on; a free instance
  sleeps, and a sleeping instance fires no reminders).
- Build command: `npm ci --include=dev && npm run build` (`npm start` runs `tsx`, which is a dev dependency; keep `--include=dev`).
- Start command: `npm start`. Health check path: `/healthz`.

`render.yaml` in the repository describes the same service, for a rebuild. **Applying it as a Blueprint creates a
second service**, with its own URL and its own `HOMEMIND_SECRET`; it does not take over the hand-made one. If you ever
use it, delete or suspend the old service, and set the variables marked "set by hand" below on the new one.

## 3. Environment variables

Set in the dashboard: the service → **Environment** (left menu). Never put a key or the code in a file.

| Variable | Value | Notes |
| --- | --- | --- |
| `NODE_VERSION` | `22` | Already set |
| `HOST` | `0.0.0.0` | Already set. Render sets `PORT` itself |
| `HOMEMIND_ENABLED` | `1` | Already set |
| `HOMEMIND_DEMO` | `1` | Already set. Demo panel, clock jumps, simulated services |
| `HOMEMIND_SECRET` | 16 characters or more | Already set. Signs sessions and the access cookie. Changing it signs everyone out |
| `HOMEMIND_LLM` | `live` | Already set. `fake` runs with canned replies and spends nothing |
| `HOMEMIND_LLM_BASE_URL`, `HOMEMIND_LLM_API_KEY`, `HOMEMIND_LLM_MODEL` | your values | Already set. Server-side only |
| **`HOMEMIND_CLOUD`** | **`1`** | **Add after P10 is pushed.** Closes Orbit, Epic and Fridge, `debug/state`, and the model and PPMA detail in `/api/homemind/health` |
| **`HOMEMIND_ACCESS_CODE`** | **8 characters or more** | **Add after P10 is pushed.** The gate. Changing it shuts out everyone until they enter the new one |
| **`HOMEMIND_TIMEZONE`** | **`Asia/Shanghai`** | **Add after P10 is pushed.** Render runs in UTC; cloud mode refuses to start without it |

Do **not** set `ORBIT_*`, `EPIC_REPLAY_*`, `FRIDGE2TABLE_*` or `PPMA_*`. Cloud mode ignores them and prints a warning
with each name at startup.

**Add the three new variables together, in one save.** `HOMEMIND_CLOUD=1` without `HOMEMIND_TIMEZONE` stops the start
(on purpose), and without `HOMEMIND_ACCESS_CODE` the page is open and the member picker is off.

## 4. Steps after P10 is pushed

1. Wait for the deploy that the push starts: the service → **Events** shows "Deploy live" for the newest commit.
2. The service → **Environment** → under "Environment Variables", **Edit** (or **+ Add Environment Variable**), then add
   the three rows from the table above: `HOMEMIND_CLOUD` = `1`, `HOMEMIND_ACCESS_CODE` = your code, `HOMEMIND_TIMEZONE` = `Asia/Shanghai`.
3. Click **Save, rebuild, and deploy** (or **Save and deploy**). Render starts a new deploy with the variables.
4. Wait for "Deploy live" again under **Events**. If it fails, open **Logs**: a line `[homemind] HOMEMIND_TIMEZONE ...` or
   `[homemind] HOMEMIND_ACCESS_CODE must be 8 characters or more` names what to fix.

If you want no minute at all in which the new code runs without the gate, do step 2 **before** the push and choose
**Save only**; the push then deploys with them.

## 5. Checks on the live URL

Replace `https://YOUR-SERVICE.onrender.com` with the URL at the top of the service page.

| Check | How | Expected |
| --- | --- | --- |
| The service is up | Open `https://YOUR-SERVICE.onrender.com/healthz` | `{"ok":true,"app":"digitalmate-web"}` |
| Startup log | The service → **Logs**, the newest start | `Cloud mode: on (Orbit, Epic and Fridge bridges closed)`, and no `[cloud]`, `[access]` or `[homemind]` warning lines |
| **The gate page** | Open the URL in a private window | A small page "Homemind demo 演示" asking for "Access code 访问码". A wrong code shows "That code is not right. 访问码不正确。"; the right one opens the app |
| The API is gated too | In a private window (no code yet), open `/api/homemind/health` | `{"error":"access_code_required",...}` |
| **Orbit is closed** | Open `/api/orbit/health` (with or without the code) | `{"error":"not_available","message":"This service is not available in the cloud demo"}`, status 404. Same for `/api/epic/health` and `/api/fridge/health` |
| **No debug state** | After entering the code, open `/api/homemind/debug/state` in the same browser | `{"error":"not_found","message":"Not found"}` (404). Without the code it is the access-code error instead, which is also fine |
| Health shows cloud mode | After entering the code, open `/api/homemind/health` | `{"enabled":true,"ready":true,"demo":true,"cloud":true}` and nothing else |
| **Shanghai time** | Family tab → pick Mom → the "Demo clock" chip at the top | The weekday and time **in Shanghai** (in November, Israel time + 6 hours). If it shows Render's UTC time (Israel − 2 hours), `HOMEMIND_TIMEZONE` did not apply: check the variable and deploy again |
| Two people | Two browsers (or a normal and a private window, each with the code): Mom in one, Dad in the other | Mom assigns today's pickup to Dad; it appears on Dad's board at once ("Live") |

Run guide for the scenes: `docs/homemind-demo.md`. The demo panel ("Prepare Scene 1" to 5) works the same in the cloud.

## 6. What is lost, and when

- **The board lives on the instance's disk** (`.homemind/state.json`). Every deploy, restart, or change of a variable
  erases it, and the next request seeds a fresh demo family. Chat history in the Family companion is in memory only.
- Sessions (who you picked) last 12 hours and survive a restart while `HOMEMIND_SECRET` stays the same. The live stream
  shows "Reconnecting…" during the restart and comes back by itself.
- The access cookie lasts 7 days per browser. Changing `HOMEMIND_ACCESS_CODE` or `HOMEMIND_SECRET` ends every cookie.
- Reminders and the 20:00 summary fire only while the instance runs. A restart after 20:00 skips that evening's summary.
- A Render deploy runs the old and the new process side by side for a short while. With the file store both may write;
  the newest deploy's fresh seed wins. Avoid deploying in the middle of a demo.

## 7. What this is not (say it)

- **The access code is a gate, not a login.** Everyone with the code shares one family and can pick any member,
  Mom included; nothing proves who is who. Accounts come in P12.
- **Everyone with the code spends your model key.** There is no per-family or daily cap yet (P14). Set `HOMEMIND_LLM=fake`
  to stop spending; the chat then says "Simulated model".
- **One shared demo family.** "Prepare Scene N" or "Reset" on the demo panel resets the board for everyone who is in.
- Everything simulated stays labeled on the card: the kindergarten group, the pizza shop, the babysitters, the sample
  inbox, the backup contact (nothing is ordered, sent or read from a real mailbox). See "Demo facts" in `docs/PROGRESS.md`.
- Too many wrong codes (10 in 15 minutes from one address) give "Too many wrong codes" for 15 minutes. Which address
  Render passes to the app is not yet checked (T14.2); if people on one office network share it, one person's typos
  can lock out the others for 15 minutes.

## 8. The check from China

Before anything else is built on this link, ask the team lead to open it **from the company network in China**, on a
laptop and on a phone, and report:

1. Does the gate page load, and how long does it take?
2. After the code: does the app load, and does the Family tab show **Live / 实时** (the stream) after picking a member?
3. Does a change in one window (Mom assigns the pickup to Dad) appear in the other within a second or two?
4. Does the Family chat answer (the live model is called from Singapore, not from the browser)?

`onrender.com` may be slow or blocked from some networks, and the live stream (SSE) is the first thing to suffer.
If it fails, record what loaded and what did not, before trying anything else.
