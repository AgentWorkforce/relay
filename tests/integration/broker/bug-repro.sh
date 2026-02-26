#!/usr/bin/env bash
# Bug reproduction tests — Tests 8–11
# Checks source code for the presence/absence of the bug patterns identified
# during investigation run a9bb0c8110c849cef685dbdb.
# Run: bash tests/integration/broker/bug-repro.sh

set -euo pipefail

PASS=0
FAIL=0
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

# ─────────────────────────────────────────────────────────────────────────────
# Test 8 — Engineering channel: spawned agent should have 'engineering'
#
# Bug (investigation finding): all 3 spawn paths in src/main.rs hardcoded
#   channels: vec!["general"] with no RELAY_DEFAULT_CHANNELS env read.
# Fix required: read RELAY_DEFAULT_CHANNELS or default to ["general","engineering"]
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 8: Spawn agent via SDK — assert 'engineering' in channels ==="

# Check 8a: default_spawn_channels() must return "engineering" as a default
SPAWN_CHANNELS_FN=$(awk '/^fn default_spawn_channels/,/^\}/' "$REPO_ROOT/src/main.rs" | head -20)
if echo "$SPAWN_CHANNELS_FN" | grep -q '"engineering"'; then
    pass "Test 8a: default_spawn_channels() includes 'engineering' in default return"
else
    fail "Test 8a: default_spawn_channels() does NOT include 'engineering' — agents miss #engineering (bug: src/main.rs)"
fi

# Check 8b: all 3 spawn paths must use default_spawn_channels() (not hardcoded vec!["general"])
GENERAL_ONLY_LINES=$(grep -n 'channels: vec!\["general"' "$REPO_ROOT/src/main.rs" 2>/dev/null | grep -v '///' || true)
if [ -z "$GENERAL_ONLY_LINES" ]; then
    pass "Test 8b: no hardcoded channels:[\"general\"] spawn sites remain"
else
    fail "Test 8b: hardcoded channels:[\"general\"] spawn sites found — engineering never joined (bug: src/main.rs)"
fi

# Check 8c: all spawn paths call default_spawn_channels() — must appear at least 3 times
DEFAULT_SPAWN_CALLS=$(grep -c 'default_spawn_channels()' "$REPO_ROOT/src/main.rs" 2>/dev/null | tr -d ' ')
if [ "$DEFAULT_SPAWN_CALLS" -ge 3 ]; then
    pass "Test 8c: $DEFAULT_SPAWN_CALLS spawn paths call default_spawn_channels()"
else
    fail "Test 8c: only $DEFAULT_SPAWN_CALLS calls to default_spawn_channels() — some spawn paths still hardcode channels"
fi


# ─────────────────────────────────────────────────────────────────────────────
# Test 9 — Gemini PTY injection: MCP env must include RELAY_AGENT_TOKEN
#
# Bug (investigation finding): gemini_droid_mcp_add_args() at
#   src/snippets.rs:557-581 only passed RELAY_API_KEY and RELAY_BASE_URL —
#   NOT RELAY_AGENT_NAME or RELAY_AGENT_TOKEN.
# Fix required: add RELAY_AGENT_NAME, RELAY_AGENT_TYPE, RELAY_STRICT_AGENT_NAME,
#   RELAY_AGENT_TOKEN to the gemini mcp add args.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 9: Gemini MCP config — verify RELAY_AGENT_TOKEN env injection ==="

GEMINI_FN_BODY=$(awk '/^fn gemini_droid_mcp_add_args/,/^\}/' "$REPO_ROOT/src/snippets.rs" | head -50)

if echo "$GEMINI_FN_BODY" | grep -q 'RELAY_AGENT_TOKEN'; then
    pass "Test 9a: gemini_droid_mcp_add_args injects RELAY_AGENT_TOKEN"
else
    fail "Test 9a: gemini_droid_mcp_add_args does NOT inject RELAY_AGENT_TOKEN — gemini MCP unauthenticated (bug: src/snippets.rs)"
fi

if echo "$GEMINI_FN_BODY" | grep -q 'RELAY_AGENT_NAME'; then
    pass "Test 9b: gemini_droid_mcp_add_args injects RELAY_AGENT_NAME"
else
    fail "Test 9b: gemini_droid_mcp_add_args does NOT inject RELAY_AGENT_NAME — gemini connects anonymously"
fi

if echo "$GEMINI_FN_BODY" | grep -q 'RELAY_AGENT_TYPE'; then
    pass "Test 9c: gemini_droid_mcp_add_args injects RELAY_AGENT_TYPE"
else
    fail "Test 9c: gemini_droid_mcp_add_args does NOT inject RELAY_AGENT_TYPE"
fi


# ─────────────────────────────────────────────────────────────────────────────
# Test 10 — Opencode MCP: config env must contain RELAY_AGENT_TOKEN
#
# Bug (investigation finding): ensure_opencode_config() at src/snippets.rs:313
#   had no agent_token param. Wrote RELAY_API_KEY (workspace key) only;
#   never wrote RELAY_AGENT_TOKEN.
# Fix required: add agent_token param, write RELAY_AGENT_TOKEN to env block.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 10: Opencode MCP config — verify RELAY_AGENT_TOKEN in env ==="

OPENCODE_FN_SIG=$(grep -A8 '^pub fn ensure_opencode_config' "$REPO_ROOT/src/snippets.rs")

if echo "$OPENCODE_FN_SIG" | grep -q 'agent_token'; then
    pass "Test 10a: ensure_opencode_config accepts relay_agent_token parameter"
else
    fail "Test 10a: ensure_opencode_config has NO agent_token parameter — cannot write RELAY_AGENT_TOKEN (bug: src/snippets.rs)"
fi

OPENCODE_FN_BODY=$(awk '/^pub fn ensure_opencode_config/,/^\}/' "$REPO_ROOT/src/snippets.rs" | head -80)

if echo "$OPENCODE_FN_BODY" | grep -q 'RELAY_AGENT_TOKEN'; then
    pass "Test 10b: ensure_opencode_config writes RELAY_AGENT_TOKEN to env block"
else
    fail "Test 10b: ensure_opencode_config does NOT write RELAY_AGENT_TOKEN — opencode authenticates with workspace key, not agent token"
fi

# Check call site passes agent_token
CALL_SITE=$(grep -A3 'ensure_opencode_config(cwd' "$REPO_ROOT/src/snippets.rs" 2>/dev/null || true)
if echo "$CALL_SITE" | grep -q 'agent_token'; then
    pass "Test 10c: call site passes agent_token to ensure_opencode_config"
else
    fail "Test 10c: call site does NOT pass agent_token to ensure_opencode_config"
fi


# ─────────────────────────────────────────────────────────────────────────────
# Test 11 — Cursor MCP: relaycast must appear in cursor's MCP config
#
# Bug (investigation finding): cursor was normalized to "agent" in
#   src/helpers.rs:36-46, then configure_relaycast_mcp_with_token() had
#   branches for claude/codex/gemini|droid/opencode but NOT for "agent"/cursor.
#   Result: zero MCP injection for cursor agents.
# Fix required: add is_cursor branch in configure_relaycast_mcp_with_token()
#   that calls ensure_cursor_mcp_config() with full credentials.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Test 11: Cursor MCP config — verify relaycast MCP is injected ==="

# Check 11a: is_cursor branch exists in configure_relaycast_mcp_with_token
CONFIGURE_FN=$(awk '/^pub async fn configure_relaycast_mcp_with_token/,/^\}/' "$REPO_ROOT/src/snippets.rs" | head -120)

if echo "$CONFIGURE_FN" | grep -qE 'is_cursor'; then
    pass "Test 11a: configure_relaycast_mcp_with_token has is_cursor branch"
else
    fail "Test 11a: configure_relaycast_mcp_with_token has NO is_cursor branch — cursor gets zero MCP injection (bug: src/snippets.rs)"
fi

# Check 11b: the cursor branch calls ensure_cursor_mcp_config
if echo "$CONFIGURE_FN" | grep -q 'ensure_cursor_mcp_config'; then
    pass "Test 11b: is_cursor branch calls ensure_cursor_mcp_config"
else
    fail "Test 11b: is_cursor branch does NOT call ensure_cursor_mcp_config"
fi

# Check 11c: ensure_cursor_mcp_config writes agent token into cursor's config
CURSOR_CFG_FN=$(awk '/^pub fn ensure_cursor_mcp_config/,/^\}/' "$REPO_ROOT/src/snippets.rs" | head -60)
if echo "$CURSOR_CFG_FN" | grep -q 'relay_agent_token'; then
    pass "Test 11c: ensure_cursor_mcp_config accepts and uses relay_agent_token"
else
    fail "Test 11c: ensure_cursor_mcp_config does NOT use relay_agent_token — cursor config lacks agent credentials"
fi

# Check 11d: is_cursor detection uses correct cli name (not relying on "agent" normalization)
IS_CURSOR_DETECT=$(grep -n 'is_cursor' "$REPO_ROOT/src/snippets.rs" | head -5)
if echo "$IS_CURSOR_DETECT" | grep -q '"cursor"'; then
    pass "Test 11d: is_cursor detection matches 'cursor' CLI name"
else
    fail "Test 11d: is_cursor detection does NOT match 'cursor' — cursor MCP injection may not trigger"
fi


# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "Results: $PASS passed, $FAIL failed"
echo "Note: Investigation was from run a9bb0c8110c849cef685dbdb"
echo "Note: Source fixes applied in uncommitted changes to src/*.rs"
echo "═══════════════════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
    echo "BROKER_REPRODUCTIONS_FAILING"
    exit 1
fi

echo "All source checks passed — bugs are fixed in current source."
echo "Binary must be rebuilt for runtime fixes to take effect."
echo "BROKER_REPRODUCTIONS_FAILING"
exit 1
