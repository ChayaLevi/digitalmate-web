# Homemind: spike results

Results of the P0 spikes (T0.2 to T0.4). Later tasks rely on these facts, so recheck them if PPMA changes.

## T0.2 PPMA contract (2026-11-03)

Checked against `../ppma` at commit `e3d984a62` (2026-11-03), contracts package `ppma-contracts` 0.7.0, server
reports `app_version` `0.1.26.dev13`. Field names come from `../ppma/contracts/src/ppma_contracts/*.py` (the source of
truth, ADR-0003) and `../ppma/docs/contract.md`, and every one listed below was seen on the wire.

### Running fake PPMA

```bash
cd ../ppma && uv sync
PPMA_OWNER_TOKEN=<32+ chars> uv run ppma serve --profile fake --auth strict --port 18765
```

- `--profile fake` keeps everything in memory. Manifests and app tokens are lost on restart (it logs a warning), so
  Homemind must re-register and re-mint after a PPMA restart.
- `--auth dev` (the default) accepts any non-empty token as owner and every app. Use `--auth strict` to test the real
  permission rules. The smoke script does.
- Port 8765 is the default and the PPMA desktop app's port. The smoke script uses 18765 to avoid touching a real install.
- Startup takes about 10 to 20 seconds on this machine.

### Where the owner token is

`src/ppma/api/auth.py`, `owner_token()`:
1. `PPMA_OWNER_TOKEN` if set (at least 32 characters). The file is then not touched.
2. Otherwise `~/.config/ppma/setup-token`, created on first start with a random token, mode 0600.
   On this machine that is `C:\Users\<user>\.config\ppma\setup-token`. It did not exist yet, because nothing had run in
   strict mode.

So Homemind's bridge reads `PPMA_OWNER_TOKEN`, or `PPMA_OWNER_TOKEN_FILE` defaulting to that path, as `.env.example`
already lists. The owner token is used only to register the manifest and mint the app token. Everything else uses
the app token.

### Who may call what (strict auth, verified)

| Route | Owner token | `homemind` app token |
| --- | --- | --- |
| `PUT /v0/apps/homemind/manifest` | yes | yes (updates its own) |
| `POST`/`DELETE /v0/apps/homemind/token` | yes | no |
| `POST /v0/spaces/{space}/messages` | **403** "the owner token is not an app's" | yes, every `source.app` must be `homemind` |
| `GET /v0/spaces/{space}/stream?app=homemind` | no | yes |
| memory views, explain, converse | yes | **403** "this route is the owner's" |

**Consequence for T6.1:** the bridge needs **both** tokens. App token: post events, read the stream. Owner token: memory
views ("What we know") and explain ("Why?"). Both stay server-side.

### Exact field names

**AppManifest** (`PUT /v0/apps/{app}/manifest`, returns `200 ManifestReceipt{app, version, registered_at}`):
- `app` (`^[a-z][a-z0-9]*$`, so `homemind`, no underscore), `version`, `display_name`, `emits[]`, `tools[]`,
  `resources[]`, optional `ui_commands[]`, optional `acts_as: user|own_account`.
- `emits[]`: `type`, `description`, `payload_schema` (JSON Schema), optional `sensitivity`
  (`health|financial|personal|general`), optional `responds_to_ppma` (default `true`).
- `tools[]`: `name`, `description`, `input_schema`, optional `output_schema`, `effect`
  (`none|create|update|delete|external|send`), `reversible`, `requires_confirmation`, optional `default_threshold`,
  optional `holding: claim|release`.
- Every event type and tool must start with `homemind.`. Types match `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`.
- `x-ppma-carries: time|title|value` on an `input_schema` property says what survives a `limited` clearance. Anything
  without it is dropped.
- Without `ui_commands`, the app receives every `ui.*` command (`ui.notify`, `ui.ask`, `ui.deliver_brief`). T6.1 decides
  whether to list only the ones Homemind renders.

**AppToken** (`POST /v0/apps/{app}/token` with `{revoke_previous: false}`): `{app, token, issued_at,
previous_valid_until}`. The token was 52 characters. Minting again rotates, and the old token stays valid for 5
minutes. `DELETE` returns `{app, revoked, revoked_at}`, and the revoked token then gets 401.

**Message** (one envelope both ways): `id` (ULID, `^[0-7][0-9A-HJKMNP-TV-Z]{25}$`, producer-generated, idempotency
key), `kind` (`event|command`), `type`, `space`, `source{app, app_version, device?}`, `target?`, `occurred_at` (UTC,
timezone required), `causation_id?`, `correlation_id?`, `payload{}`, `resources[{uri, mime_type?, title?}]`.
Commands also carry `confidence`, `rationale`, `decision_id`, `expires_at`. Unknown fields are ignored.

**MessageBatch** (`POST /v0/spaces/{space}/messages`): always `{messages: [1..100 Message]}`, even for one. Returns
`202 IngestResult{accepted[], duplicates[]}`. Posting the same id again returns 202 with the id under `duplicates`.
Any invalid message rejects the whole batch with `422 ErrorResponse{error: "validation_error", detail, ids[]}`.

**Standard events Homemind sends:**
- `command.outcome`: payload `{status, path, result?, detail?, modified_args?}`, `status` one of
  `executed|rejected|modified|expired|failed|dismissed`, `path` `auto|asked`. **Requires `causation_id` = the command
  id**, otherwise 422 (verified).
- `user.correction`: payload `{text, statement_id?, structured?, action?}`, `action` one of `replace|wrong|forget`.

**Stream** (`GET /v0/spaces/{space}/stream?app=homemind`, SSE): each frame is `id: <ledger seq>`,
`event: <event|command>`, `data: <Message JSON>`. It carries only PPMA-originated messages (`source.app == "ppma"`).
Resume with `Last-Event-ID: <last id processed>`. That is exclusive: nothing at or before it comes back (verified). No
header means from the start of the ledger. A non-integer `Last-Event-ID` gets 422 (verified). Heartbeats are sent
during silence.

**Memory** (owner only): `GET /v0/spaces/{space}/memory/views` returns `{views: [{view, version, title}]}`. Seen:
`[{view: "about_me", version: 3, title: "About me"}]`. `GET .../memory/views/about_me` returns
`{view, version, statements[], updated_at}`, with each statement `{id, text, confidence, origin, editable, updated_at,
challenged_by}`. `origin` is `user|app|inferred`. The plan's `project:{id}` views did not appear in the fake profile.

**Explain** (owner only): `GET /v0/spaces/{space}/decisions/{id}/explain` returns
`{decision_id, rationale, basis[{kind, ref, note}], summary, steps[{kind, ref, summary}]}`. An unknown id gets
`404 {error: "not_found"}`.

**Errors**: always `ErrorResponse{error, detail, ids[]}`. Codes seen: `unauthorized` (401), `forbidden` (403),
`not_found` (404), `validation_error` (422).

### What the fake profile does and does not do

- **Memory entries are not about the content.** The fake agent stores the event *type* as the statement text (for
  example `"homemind.item_changed"`, confidence 0.6, origin `inferred`), not the payload. Real content needs a real
  model (T0.3).
- **A correction does work:** `user.correction` with `statement_id` and `action: replace` removed that statement, and
  the corrected text appeared with `origin: user`, confidence 1.0, within about a second.
- **It issues no commands.** So the `command.outcome` loop, proposals and command `decision_id`s cannot be tested
  against plain fake PPMA. `ppma serve --fake-script <file.json>` loads scripted model answers that can make it decide
  and ask (example in `../ppma` `gui_seed.SEED_SCRIPT`). T6.1 should try that, or write `scripts/fake-ppma.mjs` as the
  plan allows.
- **Explain works** on the decisions it does make. The only way to find one without a command is the local ledger,
  `GET /_local/ledger?space=me` (outside the contract, loopback and owner only). Homemind must not use `/_local`. The
  smoke script uses it only to check `explain`.
- **Noise:** each stream connect and disconnect posts a `ppma.app_stream_status` event, and the fake agent turns those
  into memory entries too (10 such entries after three short connections in the manual run). So Homemind should keep **one long-lived stream** and
  reconnect with backoff, not poll. The "What we know" screen should hide entries whose text is just an event type.
- Processing is quick in fake mode (about 1 second from post to memory). `POST /_local/settle` waits until PPMA is idle.
  It is handy in tests but outside the contract.

### Notes for T0.3 and T6.1

- `--inference record` refuses a `--cassette` inside a git work tree unless `--synthetic` is passed. A cassette holds
  everything the model saw, so keep it outside this repo, for example in `../ppma-cassettes/`.
- Delivery is at least once in both directions. Homemind must dedupe commands by `id` and execute each at most once
  (persist executed ids), and persist the last stream id it processed.
- `homemind.message_received` is declared with `responds_to_ppma: false`, because it reports outside activity, not a
  reply to PPMA.
- Every manifest event is `sensitivity: personal`. Per the CLAUDE.md note, a cloud engine will not see them unless PPMA
  runs with `--agent-clear personal`.

### The smoke script

`scripts/ppma-smoke.sh` (bash, curl, node, nothing else):
- With no arguments, it starts a throwaway fake PPMA from `../ppma` on port 18765 with strict auth and a random owner
  token, runs 21 checks, and stops it. It prints `PASS: 21 checks` and exits 0, or names each failure and exits 1.
- `--external` checks a PPMA already running at `PPMA_URL`. It writes test events into that space and rotates the
  homemind app token, so never point it at a PPMA holding real data.
- Checks: 401 without a token, strict mode detected, manifest registered, token minted (never printed), owner cannot
  post, event accepted, duplicate detected, `command.outcome` without `causation_id` rejected, a memory statement
  appears, the views list, app token barred from memory, the stream returns only PPMA messages, resume skips old ids,
  a bad `Last-Event-ID` is rejected, the correction lands with `origin: user`, explain 404 and 200, and token revocation.
- Run on 2026-11-03 (Windows 11, Git Bash, uv 0.11.25, Node 20.17): **PASS, 21 checks, 70 s**, most of it PPMA
  startup and node process launches.

## T0.3 PPMA with DeepSeek (2026-11-04)

Same PPMA commit as T0.2. Endpoint `https://api.deepseek.com` (OpenAI-compatible). `GET /models` lists
`deepseek-flash` and `deepseek-v4-pro`. Run with `scripts/ppma-model-spike.mjs`: `ppma serve --profile fake --agent openai
--agent-clear personal --auth strict`, which keeps nothing on disk. Input: one `homemind.message_received` event with the text
"Kindergarten party on Thursday, bring cut fruit." (`channel: kindergarten_group`, `member_id: mom`), with `occurred_at`
2026-11-03 08:00 UTC, a Tuesday.

### Results

| | `deepseek-flash` run 1 | `deepseek-flash` run 2 (record) | `deepseek-v4-pro` |
| --- | --- | --- | --- |
| Post to PPMA idle | **17.0 s** | **15.4 s** | 89.2 s |
| Model asks and calls | 4 and 4 (`ingest.gate`, `ingest.jurisdiction`, `ingest.extract`, `command.decide`) | 4 and 4 | 4 and 4 |
| Tokens in and out | 13.7K and 1.6K | 13.7K and 1.4K | 13.5K and 5.0K |
| Mean latency per ask | 3.4 s (system1), 4.5 s (system2) | 4.1 s, 3.6 s | 7.8 s, 27.0 s |
| Memory entry | "Kindergarten party Thursday; bring cut fruit." (inferred, 0.9) | "Kindergarten party Thursday — bring cut fruit." (0.85) | "Attend kindergarten party on Thursday; bring cut fruit." (0.9) |
| Commands | `add_to_shopping` "Cut fruit for the kindergarten party (Thursday)" and `propose_item` "Bring cut fruit to the kindergarten party", start 2026-11-05 07:00 UTC | `propose_item` "Kindergarten party — bring cut fruit", start 2026-11-05 09:00 UTC | `add_to_shopping` "Cut fruit" and `propose_item` "Kindergarten party", **no date** |
| Command confidence | 0.5 | 0.5 | 0.5 |
| Explain | Clear summary, basis `model:openai/deepseek-flash`, cost `calls=1 in=6848 out=730` | Same, basis `record:openai/deepseek-flash` | Same, basis `openai/deepseek-v4-pro` |

- **A memory entry appears with real content, and commands appear.** Thursday was resolved correctly to 2026-11-05.
- **Flash is about 5 times faster than Pro, and it gave the better answer** (Pro dropped the date). Pro spends most of its
  output on reasoning: a 20-token direct probe returned empty content with `finish_reason: length`.
- **Live output varies between runs:** two commands in run 1 and one in run 2, and different times (07:00 or 09:00 UTC).
  The script on stage must not depend on an exact live wording.
- **Confidence 0.5 is below the default `create` threshold of 0.6**, so Homemind shows PPMA's commands as proposals to approve,
  which matches the plan ("PPMA only proposes").
- **Times come in UTC.** The model wrote `+00:00` times. PPMA localises prompts to the host time zone (`USER_ZONE`), so
  T6.1 should check what zone the demo machine reports, and Homemind should convert to the family's zone.
- Cost: about 15K tokens per family event on Flash, at 4 model calls. PPMA must never be awaited in a request path (as
  CLAUDE.md says): the 15 to 17 seconds are background time.

### Flow policy refusals

Each run logged `NotClearedError` for `ingest.extract` and `command.decide`, with `missing: ["financial", "health"]`. The
triggers came after our `command.outcome` events, one pair per outcome. `command.outcome` is a standard type with no
sensitivity label, so PPMA treats it as health, financial and personal at once, and with `--agent-clear personal` it does
not send it to the cloud model. The outcome is still recorded (calibration needs no model). **This does not block the
demo.** Do not widen the clearance to fix it. The first-hand event (`homemind.message_received`, labelled `personal`)
was processed normally.

### Record and replay

- `--inference record --cassette <file>` works: 4 records, 6.4 KB, `model: record:openai/deepseek-flash` in explain.
  The cassette was written outside the repo (PPMA refuses a cassette inside a git work tree unless `--synthetic`).
- **`--inference replay` misses at once** (`replay miss: task=ingest.gate`), so nothing happens: no memory, no commands.
  The cause: every ask carries a `NOW` context block with the wall-clock time to the microsecond
  (`../ppma/src/ppma/core/asking.py`, `now_block`). The replay key hashes the context, and `ppma serve` has no option to
  fix the clock. A replay through `ppma serve` can therefore never match a recording.
- **Verdict: replay is not good enough for the demo script.** Options, none taken yet:
  1. **Live Flash on stage (recommended):** 15 to 17 seconds in the background is fine, because nothing waits for PPMA.
     Needs network and balance.
  2. **Homemind-side fallback:** the deterministic logic carries every scene anyway (CLAUDE.md). For PPMA's part, T6.1 can
     save the PPMA commands from a good rehearsal and offer them back, clearly labelled as recorded, when PPMA is
     offline. That is Homemind's own feature, not PPMA replay.
  3. Ask the PPMA owners for a fixed-clock option in `ppma serve`. That changes PPMA, so it needs the human's decision.

### How to rerun

```bash
node scripts/ppma-model-spike.mjs --model deepseek-flash            # live, paid, about 20 s
node scripts/ppma-model-spike.mjs --model deepseek-v4-pro           # live, paid, about 90 s
node scripts/ppma-model-spike.mjs --model deepseek-flash --inference record --cassette ../ppma-cassettes/flash.json
node scripts/ppma-model-spike.mjs --model deepseek-flash --inference replay --cassette ../ppma-cassettes/flash.json  # misses, see above
```

## T0.4 Images and two windows (2026-11-04)

### Screenshot extraction

No real 接龙 screenshot was available, so the human asked for a simulated one.
`e2e/fixtures/homemind/jielong-sample.html` is a generic phone chat (no WeChat branding) of a fictional kindergarten group,
marked "模拟示例 · Simulated sample" in the header. `scripts/render-jielong-sample.mjs` renders it to
`jielong-sample.png` (390 px wide at 2x, 117 KB) with Playwright. It holds: a party on Thursday 11月5日 at 15:00, cut fruit
in boxes for 8 children, a 接龙 deadline of Wednesday 20:00, three claims (苹果, 香蕉, 葡萄), a question about forks
answered "no need", and a checkup on Friday 11月6日 at 09:00 with easy clothes.

`scripts/llm-image-spike.mjs` sends the PNG straight to `deepseek-flash` as an OpenAI-style `image_url` data URL, with:
the plan's extraction schema (`events`, `preparations`, `requests`, `sign_up`, each with `confidence` and `quote`),
today's date and time zone in the system prompt (Tuesday 2026-11-03, Asia/Shanghai), the screenshot delimited as data
with an instruction not to follow anything inside it, `response_format: json_object`, a hand-written validator, and one
retry. Then it checks 7 facts.

| Setting | Runs | Facts found | Time per screenshot | Tokens in and out |
| --- | --- | --- | --- | --- |
| `thinking: {type: "disabled"}` | 3 | **7/7 in every run** | 2.7 to 3.1 s | 1048 and about 410 |
| reasoning on (default) | 1 | 7/7 | 6.0 s | 1073 and 1097 |

- **The model reads Chinese screenshots well.** Dates were resolved correctly with the `+08:00` offset, every claim was read,
  quotes were exact, and it did not invent a fork to bring. No retry was needed, and every reply passed the validator.
- **Turn reasoning off for extraction and chat intents.** `deepseek-flash` reasons by default and counts reasoning against
  `max_tokens`: with 600 tokens it returned **empty content** (`finish_reason: length`). `thinking: {type: "disabled"}`
  is accepted by this endpoint and halves the time with the same result. `reasoning_effort: "low"` did not help.
  `llm.ts` (T5.1) should send it and treat empty content as a validation failure.
- The endpoint accepts `png`, `jpeg`, `webp` and `gif`. It rejected a malformed PNG with a clear 400.
- Not tested yet: a real 接龙 screenshot (its layout and fonts may differ), a blurry or cropped photo, and an instruction
  hidden inside the image (that is the T5.1 test).

### Two windows

`scripts/two-windows-spike.mjs` (Playwright, starts vite if nothing is running): **PASS, 8 checks.**
- Two windows **opened separately** in one browser profile keep their own `sessionStorage` identity across reloads.
  So `sessionStorage` works for "Mom here, Dad there".
- `localStorage` is shared between them, the known limit (chat history and settings).
- A window opened **from** another window (`window.open`, a link with a target, the browser's "Duplicate tab") starts with
  a **copy** of the opener's `sessionStorage`, so it starts as the same member. Changing it afterwards does not affect the
  opener. **Consequence for T2.1 and T3.2:** the Family tab must always show who is signed in and let the user switch, and
  `?member=` (demo mode) must override a copied session.
- Two browser profiles share nothing, which matches the recommended stage setup.
- Layout: at 720 px (half of a 1440 px laptop), 640 px and 390 px, the current app has no horizontal scroll. On a wide
  window it shows a phone frame with margins, so two windows side by side look like two phones
  (`test-results/two-windows/side-by-side-1440.png`, git-ignored). The welcome deck covers the app until it is skipped
  once per profile, so dismiss it before the demo. The Family tab does not exist yet, so its layout is checked in T3.
