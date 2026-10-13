#!/usr/bin/env bash
# Verifies that a Claude Code PLUGIN can declare the episodic-memory MCP server as
# {"type":"http","url":...,"headersHelper":...} and reach it with a bearer token.
#
# Usage: scripts/claude-plugin-http-probe.sh [--live] [--strict] [--negative-only|--positive-only]
#   default      temp service on a free port (isolated fixture index, scratch token),
#                runs a positive case and a negative control (helper prints a wrong token).
#   --live       no temp service: http://127.0.0.1:8734/mcp and the installed helper
#                $HOME/.local/share/mcp-fleet/episodic-memory/headers-helper.sh (positive case only).
#   --strict     add --strict-mcp-config. Finding (Claude Code 2.1.296): this HIDES plugin MCP servers
#                (helper never invoked, tool absent), so it is off by default.
# The token is only ever read from a 0600 file by the helper; never put in argv/env of claude, never printed.
set -euo pipefail

LIVE=0; STRICT=0; RUN_POS=1; RUN_NEG=1
for a in "$@"; do
  case "$a" in
    --live) LIVE=1; RUN_NEG=0 ;;
    --strict) STRICT=1 ;;
    --negative-only) RUN_POS=0 ;;
    --positive-only) RUN_NEG=0 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done

if [ "$((RUN_POS + RUN_NEG))" -eq 0 ]; then echo "usage error: flag combination runs zero cases" >&2; exit 2; fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.local/share/episodic-memory/runtime/node-v24.21.0-darwin-arm64/bin:$PATH"
PLUGIN=em-http-probe
TOOL="mcp__plugin_${PLUGIN}_episodic-memory__search"
TMP="$(mktemp -d)"; chmod 700 "$TMP"
SVC_PID=""
cleanup() { [ -n "$SVC_PID" ] && kill "$SVC_PID" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

echo "claude version: $(claude --version)"
PASS_POS=0; PASS_NEG=0; FAIL=0

write_plugin() { # $1=url $2=helper
  mkdir -p "$TMP/$PLUGIN/.claude-plugin"
  node -e '
    const [,url,helper,out]=process.argv;
    require("fs").writeFileSync(out, JSON.stringify({name:"em-http-probe",version:"0.0.1",
      mcpServers:{"episodic-memory":{type:"http",url,headersHelper:helper}}},null,2));
  ' "$1" "$2" "$TMP/$PLUGIN/.claude-plugin/plugin.json"
}

write_helper() { # $1=token file to read, $2=invocation log
  cat > "$TMP/helper.sh" <<HELPER
#!/usr/bin/env bash
echo "invoked \$(date +%s)" >> "$2"
printf '{"Authorization":"Bearer %s"}' "\$(cat "$1")"
HELPER
  chmod 700 "$TMP/helper.sh"
}

run_claude() { # $1=label ; prints JSON to $TMP/$1.json, returns claude exit code
  local args=(-p "--plugin-dir=$TMP/$PLUGIN" --output-format json --no-session-persistence "--allowedTools=$TOOL")
  [ "$STRICT" = 1 ] && args+=(--strict-mcp-config)
  local prompt="Call the tool $TOOL exactly once with query \"zebra widget cache\" and response_format \"json\". Reply with only the number of results returned (the count), nothing else. If the tool is unavailable or errors, reply with exactly: TOOL_UNAVAILABLE_OR_ERROR followed by the error text."
  local rc=0
  (cd "$TMP" && claude "${args[@]}" "$prompt" > "$TMP/$1.json" 2> "$TMP/$1.err") || rc=$?
  return $rc
}

summarise() { # $1=label ; prints result text, num_turns, is_error
  node -e '
    const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    console.log(JSON.stringify({is_error:j.is_error,num_turns:j.num_turns,result:String(j.result).slice(0,300),permission_denials:(j.permission_denials||[]).length}));
  ' "$TMP/$1.json"
}

if [ "$LIVE" = 1 ]; then
  URL="http://127.0.0.1:8734/mcp"
  HELPER="$HOME/.local/share/mcp-fleet/episodic-memory/headers-helper.sh"
  [ -x "$HELPER" ] || { echo "FAIL: live helper $HELPER missing or not executable"; exit 1; }
else
  # Isolated fixture index + temp service
  ROOT="$TMP/svc"; mkdir -p "$ROOT"/{home,archive,config,projects/baseline-project}
  cp "$REPO/test/fixtures/mcp-baseline/conversation.jsonl" "$ROOT/projects/baseline-project/session.jsonl"
  TOKEN_FILE="$TMP/token"; ( umask 077; openssl rand -hex 24 > "$TOKEN_FILE" ); chmod 600 "$TOKEN_FILE"
  BAD_FILE="$TMP/token-wrong"; ( umask 077; openssl rand -hex 24 > "$BAD_FILE" ); chmod 600 "$BAD_FILE"
  PORT="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
  SENV=(env -u VITEST -u EPISODIC_MEMORY_DB_PATH TZ=UTC LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
    "HOME=$ROOT/home" "USERPROFILE=$ROOT/home" "XDG_CONFIG_HOME=$ROOT/xdg-config" "XDG_DATA_HOME=$ROOT/xdg-data"
    "EPISODIC_MEMORY_CONFIG_DIR=$ROOT/config" "TEST_DB_PATH=$ROOT/db.sqlite" "TEST_ARCHIVE_DIR=$ROOT/archive" "TEST_PROJECTS_DIR=$ROOT/projects")
  "${SENV[@]}" node "$REPO/dist/index-cli.js" index-all --no-summaries > "$TMP/index.log" 2>&1 \
    || { echo "FAIL: indexing failed"; tail -5 "$TMP/index.log"; exit 1; }
  "${SENV[@]}" "EPISODIC_MEMORY_HTTP_TOKEN_FILE=$TOKEN_FILE" "EPISODIC_MEMORY_HTTP_PORT=$PORT" \
    node "$REPO/dist/mcp-server.js" --http > "$TMP/svc.out" 2> "$TMP/svc.err" &
  SVC_PID=$!
  for _ in $(seq 1 120); do grep -q 'HTTP ready' "$TMP/svc.err" 2>/dev/null && break; kill -0 "$SVC_PID" 2>/dev/null || break; sleep 0.5; done
  grep -q 'HTTP ready' "$TMP/svc.err" || { echo "FAIL: service did not start"; tail -5 "$TMP/svc.err"; exit 1; }
  echo "service: $(grep 'HTTP ready' "$TMP/svc.err" | head -1)"
  URL="http://127.0.0.1:$PORT/mcp"
fi

positive() {
  local log="$TMP/helper-pos.log"; : > "$log"
  if [ "$LIVE" = 1 ]; then HELPER="$HELPER"; else write_helper "$TOKEN_FILE" "$log"; HELPER="$TMP/helper.sh"; fi
  write_plugin "$URL" "$HELPER"
  local rc=0; run_claude pos || rc=$?
  echo "positive: claude exit=$rc"; [ -s "$TMP/pos.json" ] && summarise pos || { echo "stderr: $(head -c 400 "$TMP/pos.err")"; return 1; }
  local calls=0
  [ "$LIVE" = 1 ] || calls=$(wc -l < "$log" | tr -d ' ')
  echo "positive: helper invocations=$([ "$LIVE" = 1 ] && echo n/a || echo "$calls")"
  # Non-live: helper must have run (auth was attempted) AND the count must equal the fixture's 3.
  if [ "$LIVE" != 1 ] && [ "$calls" -lt 1 ]; then echo "positive: helper never invoked"; return 1; fi
  local want=3; [ "$LIVE" = 1 ] && want=any
  node -e '
    const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    const want=process.argv[2], r=String(j.result).trim();
    const ok=!j.is_error && /^\d+$/.test(r) && j.num_turns>=2 && (want==="any" ? Number(r)>=1 : Number(r)===Number(want));
    process.exit(ok?0:1);
  ' "$TMP/pos.json" "$want"
}

negative() {
  local log="$TMP/helper-neg.log"; : > "$log"
  write_helper "$BAD_FILE" "$log"
  write_plugin "$URL" "$TMP/helper.sh"
  local rc=0; run_claude neg || rc=$?
  echo "negative: claude exit=$rc"; [ -s "$TMP/neg.json" ] && summarise neg || echo "stderr: $(head -c 400 "$TMP/neg.err")"
  echo "negative: helper invocations=$(wc -l < "$log" | tr -d ' ')"
  local calls; calls=$(wc -l < "$log" | tr -d ' ')
  [ "$calls" -ge 1 ] || { echo "negative: helper never invoked"; return 1; }
  # Pass = Claude reported the auth rejection (not a crash/timeout/refusal).
  node -e '
    let t=""; try{ t=String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).result); }catch{}
    process.exit(/HEADERS_HELPER_AUTH_REJECTED|\b401\b/.test(t) ? 0 : 1);
  ' "$TMP/neg.json"
}

if [ "$RUN_POS" = 1 ]; then positive && PASS_POS=1 || FAIL=$((FAIL+1)); fi
if [ "$RUN_NEG" = 1 ]; then negative && PASS_NEG=1 || FAIL=$((FAIL+1)); fi

STATUS=PASS; [ "$FAIL" -gt 0 ] && STATUS=FAIL
echo "$STATUS positive_pass=$PASS_POS negative_control_pass=$PASS_NEG failures=$FAIL strict=$STRICT live=$LIVE"
[ "$STATUS" = PASS ]
