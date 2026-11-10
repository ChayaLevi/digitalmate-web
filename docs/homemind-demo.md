# Homemind demo: run guide

For the presenter. Two browser windows side by side: **Mom** (English) on the left, **Dad** (Simplified
Chinese) on the right. Five scenes, about 5 minutes. Numbers measured on real runs are in
`docs/homemind-stats.md`. What is simulated is listed at the end and must be said out loud.

## 1. Before the day

- A Windows laptop with Node 22 and this repo on branch `feat/homemind`, after `npm ci`.
- Network for the live model (DeepSeek Flash). Without it, use the simulated model (section 6).
- Two **browser profiles** (for example Chrome "Mom" and Chrome "Dad"). Two windows of one profile share the
  chat history and settings (`localStorage`), so the chat of one person shows up in the other's window. Two
  windows of one profile are fine for the board, not for the chat.
- `.env.local` in the repo root (git ignores it). Never show it on screen.

### Environment variables

| Variable | Demo value | Notes |
| --- | --- | --- |
| `HOMEMIND_ENABLED` | `1` | Without it the app is the old DigitalMate Web, with no Family tab. |
| `HOMEMIND_SECRET` | 16+ random characters | Signs the demo sign-in. Required. |
| `HOMEMIND_DEMO` | `1` | The demo clock, the demo panel and `?member=` in the URL. |
| `HOMEMIND_LLM` | `live` (or `fake`) | `fake` = canned keyword replies, labelled "Simulated model". |
| `HOMEMIND_LLM_BASE_URL`, `HOMEMIND_LLM_API_KEY`, `HOMEMIND_LLM_MODEL` | DeepSeek endpoint, key, `deepseek-flash` | Live model only. |
| `HOMEMIND_DATA_FILE` | `.homemind/state.json` (default) | The board. A reset rewrites it. |
| `HOMEMIND_DEBUG` | `0` | `1` logs each model call's time and size (no keys, no message text). |
| `PPMA_URL` | **unset** | PPMA is off by default. See section 7 to turn it on. |

## 2. Start order (about 2 minutes)

1. In PowerShell, in the repo folder:

   ```powershell
   npm run dev
   ```

   This reads `.env.local` and serves <http://127.0.0.1:5173>. (`npm run build; npm start` also works, on
   port 4173, but `npm start` does not read `.env.local`: set the variables in the shell first.)
2. Check the bridge: <http://127.0.0.1:5173/api/homemind/health> shows `"enabled":true,"ready":true`,
   `"llm":"live"` and `"demo":true`. `"ppma":"off"` is expected.
3. Profile "Mom": open <http://127.0.0.1:5173/?member=mom>. Language English (Settings, top right). Tap **Family**.
4. Profile "Dad": open <http://127.0.0.1:5173/?member=dad>. Language 简体中文. Tap **家庭**.
5. Put the windows side by side. Both show **Live / 实时** next to "Signed in as".
6. In Mom's window, open the **Demo panel** (the dashed box under the demo clock). It stays closed until you open it.
7. Tap **Prepare Scene 1**. Both windows go back to My day, and the demo clock shows a weekday 14:30.

## 3. The demo panel

Only with `HOMEMIND_DEMO=1`. Every preset is a **reset**: a fresh board, made at the moment that scene
needs, in both windows. They work whatever the real day and time are, including late in the evening,
because the demo clock moves forward to that moment (up to a week). The clock chip shows the weekday.

| Button | Demo clock goes to | Also |
| --- | --- | --- |
| Prepare Scene 1 | next weekday 14:30 (pickup at 16:30) | |
| Prepare Scene 2 | next Monday 10:00 | Claims on for the class group, posting on its own (level 4, simulated group only) |
| Prepare Scene 3 | next weekday 14:30 (pickup 16:30, swimming 17:00) | |
| Prepare Scene 4 | next Sunday 12:00 (pizza shop open) | |
| Prepare Scene 5 | next Monday 19:30 | Claims on, the teacher's message and the 接龙 already posted and claimed |
| +15 min, +1 h | forward | Also on the clock chip |
| Jump to next reminder | the next reminder attempt or evening summary | "No reminder or summary is scheduled" if none |
| Post group message | | The next of 3 sample messages in the simulated class group |
| Update message | | The teacher moves the party to Friday; the 接龙 drops apples (Scene 2's last beat) |
| Prepare the next card now | | The pizza rule prepares Friday's card now, instead of 30 minutes before |
| Reset (now) | the real time | A fresh board with no clock offset |

After a preset, Mom's window says what to do next ("Scene 2 is ready. Claims are on. Tap Post group message twice.").

## 4. The scenes

Tap the preset before each scene. Each scene stands alone, so the order can change, and a scene can be
repeated by tapping its preset again. Lines in *italics* are what to say.

### Scene 1: assignment and escalation (about 1 min). Preset: **Prepare Scene 1**

1. Mom: **Family** tab → on "Kindergarten pickup" tap **Assign to Dad**.
   Dad's window shows it at once, with "妈妈把「幼儿园接孩子」交给了你".
   *"Mom gives the pickup to Dad. It is on his phone at once. No reload."*
2. Dad does nothing. Demo panel: **Jump to next reminder** (clock 15:30). Dad gets "请确认：幼儿园接孩子".
3. **Jump to next reminder** three more times: Dad's second and third reminders (15:40, 15:50), then at 16:00
   Mom gets "Kindergarten pickup at 16:30 is not confirmed yet."
   *"Dad didn't confirm, so Homemind tells Mom, in neutral words. It never says 'Dad ignored it'."*
4. Optional: once more (16:10), and the backup contact gets a short message: "(Simulated)", with no details.
5. Mom taps **I'll take it** on the alert or the row. Every alert closes in both windows.
   *"Homemind helps, but an alert can be missed. It is not a safety system."*

### Scene 2: the kindergarten group (about 1.5 min). Preset: **Prepare Scene 2**

1. Demo panel: **Post group message** twice: the teacher's party message, then the 接龙 sign-up.
   Homemind claims apples in the simulated group; Dad's window: "Homemind 已替家里认领苹果…（模拟群）".
   *"The group is simulated: there is no WeChat access. Claims are on only because a parent turned them on, for food under 50 CNY."*
2. Mom: **My day** → the claim row → **Why?**: read by fixed rules, not the model, source a Homemind rule.
3. Under "Change to", cake is first: "Saved preference: … because Noa enjoys baking it with us the most".
   Tap **Change** on cake. The correction is posted in the group; Dad's board gets "为派对做蛋糕（8个小朋友）" as "谁来负责？".
   *"It never claims something a person has to make. Mom picks cake because of the family's saved reason."*
4. The screenshot (optional, live model): Mom → **Chat with Homemind** → attach
   `e2e/fixtures/homemind/jielong-sample.png` → send. The card lists the party (this Thursday 15:00), the
   checkup, the preparations, with the source quotes, all as **suggestions**. One tap approves.
   *"The model reads the picture. Nothing goes on the board until a person approves."*
5. Last beat (optional): **Update message**. Dad gets "幼儿园修改了一条消息"; Mom's My day: "The kindergarten
   changed the party to Friday. 4 items depend on it." → **Apply changes** (Undo is on the card).
   *"The two versions are compared in code, not by the model."*

### Scene 3: a day gone wrong (about 1 min). Preset: **Prepare Scene 3**

1. Mom: **Chat with Homemind** → "Noa is sick today". The card shows the pickup "Not needed", swimming
   "Postpone a week", and "Stay home with Noa". Nothing changes yet.
   *"The model only reads who and which day. What falls through comes from fixed rules over the board."*
2. Dad's window: My day shows "谁可以留在家" with both parents "当天没有标记外出". Dad taps **我来**.
   *"It compares who is free that day. It never picks a parent."*
3. Mom: **Family** → **Apply all (2)**. Dad sees "妈妈已采纳". **Why?** says fixed rules, source a Homemind rule.
4. The message to Teacher Wang waits on a card: Mom taps **Confirm**. It goes to the simulated teacher only.

### Scene 4: wedding, pizza, babysitter (about 1.5 min). Preset: **Prepare Scene 4**

1. Mom: **Chat with Homemind** → "I'm at my cousin's wedding from Tuesday to Saturday".
   Dad's **家庭** tab: Tuesday's pickup is now "谁来负责？".
   *"The wedding marks Mom away, and her pickup that clashes is flagged."*
2. Demo panel: **Prepare the next card now**. Mom's My day: "Friday pizza night: order", 1 large + 1 medium,
   154 CNY for 3 at home (Mom away), labelled Simulated, waiting for one tap.
3. Dad taps **为什么？** on the card: the rule, who is away and why; source a Homemind rule, not PPMA.
4. Optional: Dad adds a Friday 18:00 work dinner where he is away (+ Add, "Who is away": Dad). The card is
   replaced at once: 89 CNY for 2, plus a babysitter message card (Xiao Chen, simulated).
5. Dad taps **确认** on the pizza card: one order at the simulated shop.
   *"A rule only prepares the card. Nothing is bought until a parent taps that card. No tap: it expires and says so."*
6. Rules tab: tap **Friday pizza night** for its details: trigger, cap, area, last and next run, Why.
   A parent can change the cap or time, turn it off, or delete it (with Undo).

### Scene 5: judgment and correction (about 1 min). Preset: **Prepare Scene 5**

1. Demo panel: **Post group message** once: "…秋游回执…不着急". No alert in either window.
   Mom's My day: "Waits for the evening summary (20:00): the sender wrote “不着急” (not urgent)".
   *"Not everything deserves a ping. The reason is shown."*
2. Mom: **Memory** → **Edit** on "For kindergarten parties, bake a cake" → "For kindergarten parties, bring
   cookies", reason "Noa likes to pick the cookies herself now" → **Save the correction**.
   My day: under "Change to", cookies now carry the saved preference, and cake does not.
3. Demo panel: **Jump to next reminder** (or +1 h). Both get "evening summary"; Dad taps **查看**:
   "你需要做的事" first, then the note with its reason.

Closing line: *"Today's assistants manage one person. We manage the coordination between family members."*

## 5. What to say out loud (simulated or limited)

From PROGRESS.md "Demo facts to say out loud", the ones the audience will notice:

- This is the web version, not a native HarmonyOS app. The sign-in is a demo picker, not authentication.
- The group, pizza shop, babysitter, teacher, inbox and weather are **simulated** and labelled "Simulated / 模拟".
  There is no WeChat access; the realistic product route is sharing and screenshots.
- Alerts are banners in the open app. There are no push notifications.
- The demo clock moves only the app's own time, forward. A preset moves it to the scene's moment.
- The 接龙 sign-up is read by fixed rules (one standard format, 11 foods), not the model, and stops when unclear.
- How urgent a group message is, is decided by word lists, not the model.
- Allergy and dietary blocks use simple patterns and a short word list: "it helps, but it can miss things".
- The live model reads chat and screenshots (about 1 to 1.5 s per message, about 3 s per screenshot).
  The screenshot was measured on simulated clean images, not real phone photos.
- PPMA (long-term memory) is off in this demo. The correction in Scene 5 is on Homemind's own saved preferences.
- "Why?" always says its source: a Homemind rule or the model, never PPMA unless PPMA answered.

## 6. If something goes wrong

| Symptom | Do this |
| --- | --- |
| The model is slow or down (chat card says the model failed) | Say so. The board, assignment, reminders and escalation keep working. To continue the chat beats, stop the server, set `HOMEMIND_LLM=fake` in `.env.local`, `npm run dev` again, tap the scene's preset. The chat card then says "Simulated model". |
| A window shows "Reconnecting…" or stops updating | Reload that window (F5). It signs in again from `?member=`. |
| "Your demo sign-in ended" | Reload; the `?member=` link signs in again. |
| The board is in a strange state | Tap the scene's preset again (a fresh board in both windows). |
| The demo panel is missing | `HOMEMIND_DEMO=1` is not set. Fix `.env.local` and restart. |
| No Family tab at all | `HOMEMIND_ENABLED=1` or `HOMEMIND_SECRET` is missing. Check `/api/homemind/health`. |
| Chat history appears in the wrong window | Both windows are in one browser profile. Use two profiles. |
| The pizza card's Confirm says the shop is closed | The demo clock is on a Monday or after 21:30. Tap **Prepare Scene 4**. |
| Nothing works | Play the backup video (T9.3). |

To check the live model before going on stage (7 paid model calls, about 15 seconds):

```powershell
npx tsx scripts/homemind-live-check.mts --runs 1
```

It ends with "all 7 passed" (screenshot, sick report, wedding twice, question, add, assign).

## 7. Optional: PPMA live

PPMA is long-term memory and proposals. It is **off by default** and not needed for the script. With the live
model it takes **about 16 seconds per event**, so proposals arrive well after the action; never wait for it on stage.

1. In the PPMA clone (`../ppma`), start it with the live model as in `docs/homemind-spikes.md` (T0.3):
   `uv run ppma serve` with `--agent openai`, the `PPMA_LLM_*` settings and `--agent-clear personal`.
2. In `.env.local`, set `PPMA_URL` (for example `http://127.0.0.1:8765`), `PPMA_OWNER_TOKEN` or
   `PPMA_OWNER_TOKEN_FILE`, and `PPMA_SPACE=me`. Restart `npm run dev`.
3. Health shows `"ppma":"ok"`. The Memory tab then lists what PPMA remembers, next to Homemind's own preferences.
4. If PPMA goes down, the Family tab shows "PPMA offline" and everything else keeps working.

Replay (`--cassette`) does not work through `ppma serve` (T0.3), so there is no recorded fallback.
