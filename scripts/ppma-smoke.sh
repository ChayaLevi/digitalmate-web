#!/usr/bin/env bash
# PPMA north-contract smoke check for Homemind (T0.2). See docs/homemind-spikes.md.
#
#   scripts/ppma-smoke.sh              start a throwaway fake PPMA from ../ppma (strict auth), check it, stop it
#   scripts/ppma-smoke.sh --external   check an already running PPMA at $PPMA_URL instead
#
# --external writes test events into $PPMA_SPACE and mints a new homemind app token (the old one
# stays valid for PPMA's 5-minute grace period). Do not point it at a PPMA holding real data.
#
# Env: PPMA_DIR (default ../ppma), PPMA_SMOKE_PORT (default 18765), PPMA_SMOKE_WAIT (seconds to wait
# for memory to change, default 60), and for --external: PPMA_URL, PPMA_SPACE (default me),
# PPMA_OWNER_TOKEN or PPMA_OWNER_TOKEN_FILE (default ~/.config/ppma/setup-token).
# Needs bash, curl and node. Never prints a token. Exit code 0 = PASS, 1 = FAIL.

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
MODE=start
[ "${1:-}" = "--external" ] && MODE=external
WAIT="${PPMA_SMOKE_WAIT:-60}"
SPACE="${PPMA_SPACE:-me}"
WORK="$(mktemp -d)"
SERVER_PID=""
PASSED=0
FAILED=0

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    # On Windows, uv.exe is a native process: kill only stops uv and leaves python running.
    if [ -r "/proc/$SERVER_PID/winpid" ] && command -v taskkill >/dev/null 2>&1; then
      taskkill //F //T //PID "$(cat "/proc/$SERVER_PID/winpid")" >/dev/null 2>&1
    else
      kill "$SERVER_PID" 2>/dev/null
    fi
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { PASSED=$((PASSED + 1)); echo "  PASS  $1"; }
fail() { FAILED=$((FAILED + 1)); echo "  FAIL  $1"; [ -n "${2:-}" ] && echo "        $2"; }
die() { fail "$1" "${2:-}"; finish; }
finish() {
  echo
  if [ "$FAILED" -eq 0 ]; then echo "PASS: $PASSED checks"; exit 0; fi
  echo "FAIL: $FAILED of $((PASSED + FAILED)) checks failed"
  [ "$MODE" = start ] && [ -s "$WORK/ppma.log" ] && { echo "--- last PPMA log lines"; tail -n 15 "$WORK/ppma.log"; }
  exit 1
}

# node one-liners: `j FILE 'expr over d'` prints the expression's value for the JSON in FILE.
j() { node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));const v=($2);process.stdout.write(v===undefined||v===null?'':typeof v==='object'?JSON.stringify(v):String(v))" "$@"; }
ulid() { node -e "const C='0123456789ABCDEFGHJKMNPQRSTVWXYZ';let t=Date.now(),s='';for(let i=0;i<10;i++){s=C[t%32]+s;t=Math.floor(t/32)}const r=require('crypto').randomBytes(16);for(const b of r)s+=C[b%32];console.log(s)"; }
now() { node -e "console.log(new Date().toISOString())"; }

# http METHOD PATH TOKEN [BODYFILE] -> body in $WORK/body, status in $CODE
http() {
  local args=(-s -o "$WORK/body" -w "%{http_code}" -m 15 -X "$1" "$BASE$2" -H "accept: application/json")
  [ -n "$3" ] && args+=(-H "Authorization: Bearer $3")
  [ -n "${4:-}" ] && args+=(-H "content-type: application/json" --data-binary "@$4")
  CODE=$(curl "${args[@]}") || CODE=000
}

# event TYPE PAYLOAD_JSON [EXTRA_ENVELOPE_JSON] -> writes a one-message MessageBatch to $WORK/batch, id in $MSG_ID
event() {
  MSG_ID=$(ulid)
  local extra="${3:-}"
  [ -n "$extra" ] || extra='{}'
  node -e "const [id,type,space,at,payload,extra]=process.argv.slice(1);require('fs').writeFileSync(process.argv[7],JSON.stringify({messages:[{id,kind:'event',type,space,source:{app:'homemind',app_version:'0.0.1'},occurred_at:at,payload:JSON.parse(payload),...JSON.parse(extra)}]}))" \
    "$MSG_ID" "$1" "$SPACE" "$(now)" "$2" "$extra" "$WORK/batch"
}

# stream LAST_EVENT_ID -> SSE text in $WORK/sse, status in $CODE. Reads for 5 s, then disconnects.
stream() {
  local args=(-s -N -m 5 -o "$WORK/sse" -w "%{http_code}" "$BASE/v0/spaces/$SPACE/stream?app=homemind" -H "Authorization: Bearer $APP_TOKEN")
  [ -n "$1" ] && args+=(-H "Last-Event-ID: $1")
  rm -f "$WORK/sse"  # curl writes no file when nothing arrives
  CODE=$(curl "${args[@]}")
  touch "$WORK/sse"
}

command -v curl >/dev/null || { echo "FAIL: curl not found"; exit 1; }
command -v node >/dev/null || { echo "FAIL: node not found"; exit 1; }

# ---------------------------------------------------------------- server
if [ "$MODE" = start ]; then
  PPMA_DIR="${PPMA_DIR:-$HERE/../../ppma}"
  PORT="${PPMA_SMOKE_PORT:-18765}"
  BASE="http://127.0.0.1:$PORT"
  [ -f "$PPMA_DIR/pyproject.toml" ] || { echo "FAIL: no PPMA clone at $PPMA_DIR (set PPMA_DIR)"; exit 1; }
  command -v uv >/dev/null || { echo "FAIL: uv not found"; exit 1; }
  if curl -s -m 2 -o /dev/null "$BASE/"; then echo "FAIL: port $PORT is in use (set PPMA_SMOKE_PORT)"; exit 1; fi
  OWNER_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
  echo "Starting fake PPMA from $PPMA_DIR on port $PORT (strict auth, throwaway owner token)"
  ( cd "$PPMA_DIR" && PPMA_OWNER_TOKEN="$OWNER_TOKEN" exec uv run ppma serve --profile fake --auth strict --port "$PORT" ) >"$WORK/ppma.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 90); do
    curl -s -m 2 -o /dev/null "$BASE/" && break
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 1
  done
else
  BASE="${PPMA_URL:-http://127.0.0.1:8765}"
  if [ -n "${PPMA_OWNER_TOKEN:-}" ]; then
    OWNER_TOKEN="$PPMA_OWNER_TOKEN"
  else
    TOKEN_FILE="${PPMA_OWNER_TOKEN_FILE:-$HOME/.config/ppma/setup-token}"
    [ -r "$TOKEN_FILE" ] || { echo "FAIL: set PPMA_OWNER_TOKEN, or PPMA_OWNER_TOKEN_FILE ($TOKEN_FILE not readable)"; exit 1; }
    OWNER_TOKEN=$(tr -d '\r\n' <"$TOKEN_FILE")
  fi
  echo "Checking PPMA at $BASE, space $SPACE"
fi

echo
echo "Auth"
http GET "/v0/spaces/$SPACE/memory/views" ""
[ "$CODE" = 401 ] && pass "no token -> 401" || die "no token -> 401" "got $CODE (is PPMA running at $BASE?)"
http GET "/v0/spaces/$SPACE/memory/views" "not-a-real-token-not-a-real-token-x"
if [ "$CODE" = 401 ]; then STRICT=1; pass "unknown token -> 401 (strict auth)"
else STRICT=0; echo "  NOTE  unknown token accepted ($CODE): dev auth, the permission checks below are skipped"; fi

echo
echo "Register (PUT /v0/apps/homemind/manifest, POST /v0/apps/homemind/token)"
# Draft Homemind manifest from docs/PLAN.md section 3. No tool sends or orders anything.
cat >"$WORK/manifest.json" <<'EOF'
{
  "app": "homemind", "version": "0.0.1", "display_name": "Homemind",
  "emits": [
    {"type": "homemind.item_changed", "description": "A family board item was created, changed, assigned or completed.", "payload_schema": {"type": "object"}, "sensitivity": "personal"},
    {"type": "homemind.preference_stated", "description": "A family member stated a preference, with an optional reason and scope.", "payload_schema": {"type": "object"}, "sensitivity": "personal"},
    {"type": "homemind.member_unavailable", "description": "A family member is unavailable for a period.", "payload_schema": {"type": "object"}, "sensitivity": "personal"},
    {"type": "homemind.reminder_outcome", "description": "How a reminder ended: done, taken, handed off, snoozed or unanswered.", "payload_schema": {"type": "object"}, "sensitivity": "personal"},
    {"type": "homemind.message_received", "description": "A message from a family source, such as a kindergarten group.", "payload_schema": {"type": "object"}, "sensitivity": "personal", "responds_to_ppma": false}
  ],
  "tools": [
    {"name": "homemind.get_board", "description": "Read the family board.", "input_schema": {"type": "object", "properties": {}}, "effect": "none", "reversible": true, "requires_confirmation": false},
    {"name": "homemind.propose_item", "description": "Propose an event or task. It lands as a proposed item a parent approves.", "input_schema": {"type": "object", "properties": {"title": {"type": "string", "x-ppma-carries": "title"}, "start": {"type": "string", "x-ppma-carries": "time"}, "notes": {"type": "string"}}, "required": ["title"]}, "effect": "create", "reversible": true, "requires_confirmation": false},
    {"name": "homemind.propose_preparation", "description": "Propose a preparation under an existing event.", "input_schema": {"type": "object", "properties": {"event_id": {"type": "string"}, "title": {"type": "string", "x-ppma-carries": "title"}, "due": {"type": "string", "x-ppma-carries": "time"}}, "required": ["event_id", "title"]}, "effect": "create", "reversible": true, "requires_confirmation": false},
    {"name": "homemind.add_to_shopping", "description": "Add an item to the family shopping list. Nothing is bought.", "input_schema": {"type": "object", "properties": {"title": {"type": "string", "x-ppma-carries": "title"}}, "required": ["title"]}, "effect": "create", "reversible": true, "requires_confirmation": false}
  ]
}
EOF
http PUT /v0/apps/homemind/manifest "$OWNER_TOKEN" "$WORK/manifest.json"
if [ "$CODE" = 200 ] && [ "$(j "$WORK/body" d.app)" = homemind ] && [ -n "$(j "$WORK/body" d.registered_at)" ]; then
  pass "manifest -> 200 ManifestReceipt{app, version, registered_at}"
else die "manifest -> 200" "got $CODE: $(head -c 300 "$WORK/body")"; fi
echo '{"revoke_previous": false}' >"$WORK/tokreq.json"
http POST /v0/apps/homemind/token "$OWNER_TOKEN" "$WORK/tokreq.json"
APP_TOKEN=$(j "$WORK/body" "d.token||''" 2>/dev/null)
if [ "$CODE" = 200 ] && [ -n "$APP_TOKEN" ] && [ "$(j "$WORK/body" d.app)" = homemind ]; then
  pass "token -> 200 AppToken{app, token, issued_at} (token not shown)"
else die "token -> 200" "got $CODE: $(j "$WORK/body" "d.error+': '+d.detail" 2>/dev/null)"; fi

echo
echo "Post (POST /v0/spaces/$SPACE/messages)"
event homemind.item_changed '{"item_id":"smoke-1","change":"created","title":"Kindergarten party on Thursday, bring cut fruit","member_id":"mom"}'
FIRST_ID=$MSG_ID
if [ "$STRICT" = 1 ]; then
  http POST "/v0/spaces/$SPACE/messages" "$OWNER_TOKEN" "$WORK/batch"
  [ "$CODE" = 403 ] && pass "owner token posting -> 403 (only app tokens post)" || fail "owner token posting -> 403" "got $CODE"
fi
http POST "/v0/spaces/$SPACE/messages" "$APP_TOKEN" "$WORK/batch"
[ "$CODE" = 202 ] && [ "$(j "$WORK/body" "d.accepted.includes('$FIRST_ID')")" = true ] \
  && pass "event -> 202 IngestResult.accepted has the id" || fail "event -> 202 accepted" "got $CODE: $(head -c 300 "$WORK/body")"
http POST "/v0/spaces/$SPACE/messages" "$APP_TOKEN" "$WORK/batch"
[ "$CODE" = 202 ] && [ "$(j "$WORK/body" "d.duplicates.includes('$FIRST_ID')")" = true ] \
  && pass "same id again -> 202 IngestResult.duplicates has the id" || fail "same id again -> duplicates" "got $CODE: $(head -c 300 "$WORK/body")"
event command.outcome '{"status":"executed","path":"auto"}'
http POST "/v0/spaces/$SPACE/messages" "$APP_TOKEN" "$WORK/batch"
[ "$CODE" = 422 ] && [ "$(j "$WORK/body" d.error)" = validation_error ] \
  && pass "command.outcome without causation_id -> 422 validation_error" || fail "command.outcome without causation_id -> 422" "got $CODE"

echo
echo "Memory (GET /v0/spaces/$SPACE/memory/views[/about_me])"
STATEMENT_ID=""
for _ in $(seq 1 "$WAIT"); do
  http GET "/v0/spaces/$SPACE/memory/views/about_me" "$OWNER_TOKEN"
  if [ "$CODE" = 200 ]; then
    STATEMENT_ID=$(j "$WORK/body" "(d.statements.find(s=>s.origin!=='user')||{}).id")
    [ -n "$STATEMENT_ID" ] && break
  fi
  sleep 1
done
if [ -n "$STATEMENT_ID" ]; then
  FIELDS=$(j "$WORK/body" "Object.keys(d.statements[0]).sort().join(',')")
  pass "about_me has a statement after the event (fields: $FIELDS)"
else fail "about_me has a statement within ${WAIT}s" "last status $CODE"; fi
http GET "/v0/spaces/$SPACE/memory/views" "$OWNER_TOKEN"
[ "$CODE" = 200 ] && [ "$(j "$WORK/body" "d.views.some(v=>v.view==='about_me')")" = true ] \
  && pass "views list has about_me: $(j "$WORK/body" "d.views.map(v=>v.view+'@'+v.version).join(' ')")" || fail "views list has about_me" "got $CODE"
if [ "$STRICT" = 1 ]; then
  http GET "/v0/spaces/$SPACE/memory/views" "$APP_TOKEN"
  [ "$CODE" = 403 ] && pass "app token reading memory -> 403 (owner only)" || fail "app token reading memory -> 403" "got $CODE"
fi

echo
echo "Stream (GET /v0/spaces/$SPACE/stream?app=homemind)"
stream ""
LAST_ID=$(grep -E '^id: ' "$WORK/sse" | tail -n 1 | cut -c5- | tr -d '\r')
if [ "$CODE" = 200 ] && [ -n "$LAST_ID" ]; then
  pass "stream from start -> $(grep -c '^id: ' "$WORK/sse") events, last id $LAST_ID, types: $(grep -o '"type":"[a-z_.]*"' "$WORK/sse" | sort -u | cut -d'"' -f4 | tr '\n' ' ')"
else fail "stream returns events" "status $CODE, $(head -c 200 "$WORK/sse")"; fi
if grep -q '"source":{"app":"homemind"' "$WORK/sse"; then fail "stream carries only PPMA-originated messages"; else pass "stream carries only PPMA-originated messages"; fi
if [ -n "$LAST_ID" ]; then
  stream "$LAST_ID"
  OLD=$(grep -E '^id: ' "$WORK/sse" | cut -c5- | tr -d '\r' | awk -v last="$LAST_ID" '$1 <= last' | head -n 1)
  [ "$CODE" = 200 ] && [ -z "$OLD" ] && pass "resume with Last-Event-ID $LAST_ID -> nothing at or before it" \
    || fail "resume with Last-Event-ID" "status $CODE, replayed id $OLD"
fi
stream "not-a-cursor"
[ "$CODE" = 422 ] && pass "bad Last-Event-ID -> 422" || fail "bad Last-Event-ID -> 422" "got $CODE"

echo
echo "Correct (user.correction on /messages)"
CORRECTION="Smoke check: the party is on Friday, not Thursday ($(ulid))"
if [ -n "$STATEMENT_ID" ]; then
  event user.correction "{\"text\":\"$CORRECTION\",\"statement_id\":\"$STATEMENT_ID\",\"action\":\"replace\"}"
  http POST "/v0/spaces/$SPACE/messages" "$APP_TOKEN" "$WORK/batch"
  [ "$CODE" = 202 ] && pass "user.correction {text, statement_id, action: replace} -> 202" || fail "user.correction -> 202" "got $CODE: $(head -c 300 "$WORK/body")"
  SEEN=""
  for _ in $(seq 1 "$WAIT"); do
    http GET "/v0/spaces/$SPACE/memory/views/about_me" "$OWNER_TOKEN"
    SEEN=$(j "$WORK/body" "(d.statements||[]).some(s=>s.text===process.argv[3]&&s.origin==='user')" "$CORRECTION" 2>/dev/null)
    [ "$SEEN" = true ] && break
    sleep 1
  done
  [ "$SEEN" = true ] && pass "corrected text appears in about_me with origin: user" || fail "corrected text appears with origin: user within ${WAIT}s"
else fail "user.correction" "skipped: no statement to correct"; fi

echo
echo "Explain (GET /v0/spaces/$SPACE/decisions/{id}/explain)"
http GET "/v0/spaces/$SPACE/decisions/$(ulid)/explain" "$OWNER_TOKEN"
[ "$CODE" = 404 ] && [ "$(j "$WORK/body" d.error)" = not_found ] && pass "unknown decision -> 404 not_found" || fail "unknown decision -> 404" "got $CODE"
# Commands carry decision_id; the fake agent issues none, so take one from the local ledger
# (/_local is outside the contract, loopback and owner only).
DECISION=$(grep -o '"decision_id":"[0-9A-Z]\{26\}"' "$WORK/sse" | head -n 1 | cut -d'"' -f4)
if [ -z "$DECISION" ]; then
  http GET "/_local/ledger?space=$SPACE&after=0&limit=500" "$OWNER_TOKEN"
  [ "$CODE" = 200 ] && DECISION=$(j "$WORK/body" "(d.entries.find(e=>e.kind==='decision')||{}).decision_id")
fi
if [ -n "$DECISION" ]; then
  http GET "/v0/spaces/$SPACE/decisions/$DECISION/explain" "$OWNER_TOKEN"
  [ "$CODE" = 200 ] && [ "$(j "$WORK/body" "d.decision_id&&d.rationale&&d.basis.length>0")" = true ] \
    && pass "explain -> 200 Explanation{decision_id, rationale, basis[$(j "$WORK/body" "d.basis.map(b=>b.kind).join(',')")]}" \
    || fail "explain -> 200 Explanation" "got $CODE"
else echo "  NOTE  no decision id found (no command, /_local/ledger unavailable): explain not checked"; fi

if [ "$MODE" = start ]; then
  echo
  echo "Revoke (DELETE /v0/apps/homemind/token, throwaway server only)"
  http DELETE /v0/apps/homemind/token "$OWNER_TOKEN"
  [ "$CODE" = 200 ] && pass "revoke -> 200, revoked $(j "$WORK/body" d.revoked)" || fail "revoke -> 200" "got $CODE"
  event homemind.item_changed '{"item_id":"smoke-2","change":"created"}'
  http POST "/v0/spaces/$SPACE/messages" "$APP_TOKEN" "$WORK/batch"
  [ "$CODE" = 401 ] && pass "revoked token posting -> 401" || fail "revoked token posting -> 401" "got $CODE"
fi

finish
