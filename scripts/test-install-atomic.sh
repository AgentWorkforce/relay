#!/bin/bash
#
# Tests for the atomic, checksum-verified install path in install.sh.
# Everything runs in temp dirs with HOME pointed at a temp dir; the network is
# replaced by a `curl` shell function serving local fixtures.
#
# Usage:
#   scripts/test-install-atomic.sh
#   AGENT_RELAY_TEST_BROKER=/path/to/real/broker scripts/test-install-atomic.sh
#       additionally runs the real-binary cases against a pristine published
#       broker: smoke test pass/fail with and without telemetry opt-out, the
#       macOS signature check and scenarios A-D (macOS arm64 only for the latter).
#
# Compatible with bash 3.2 (macOS) and newer.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/relay-install-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

export HOME="$WORK/home"
mkdir -p "$HOME"
unset GITHUB_TOKEN AGENT_RELAY_TELEMETRY_DISABLED DO_NOT_TRACK
export AGENT_RELAY_INSTALL_SOURCE_ONLY=1
export AGENT_RELAY_SMOKE_SECONDS=1

# shellcheck source=../install.sh
. "$ROOT/install.sh"
set +e
# shellcheck disable=SC2034  # read by the sourced installer functions
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
# shellcheck disable=SC2034
PLATFORM="test-test"
# shellcheck disable=SC2034
VERSION="1.2.3"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "[PASS] $1"; }
fail() { FAIL=$((FAIL + 1)); echo "[FAIL] $1"; [ -n "${2:-}" ] && echo "       $2"; }
check() { # check <description> <command...>
    local desc="$1"; shift
    if "$@"; then pass "$desc"; else fail "$desc"; fi
}
contains() { case "$1" in *"$2"*) return 0 ;; esac; return 1; }
newdir() { local d; d="$(mktemp -d "$WORK/case.XXXXXX")"; echo "$d"; }

# Pretend `warn`/`info` write to a log we can assert on (also keeps output tidy)
LOG="$WORK/log"
warn() { echo "[warn] $1" >> "$LOG"; }
info() { echo "[info] $1" >> "$LOG"; }

# --- fixtures ---------------------------------------------------------------
FIX="$WORK/fixtures"
mkdir -p "$FIX"

make_fake_broker() { # make_fake_broker <path> <mode: ok|crash|env> [label]
    local path="$1" mode="$2" label="${3:-new}"
    {
        echo '#!/bin/bash'
        echo "# $label"
        cat <<'BODY'
case "$1" in
  --help|--version) echo "fake broker"; exit 0 ;;
  init)
BODY
        case "$mode" in
            ok)    echo '    exec sleep 30 ;;' ;;
            crash) echo '    kill -ILL $$ ;;' ;;
            env)   echo '    if env | grep -q "secret"; then exit 3; fi; exec sleep 30 ;;' ;;
        esac
        echo '  *) exit 2 ;;'
        echo 'esac'
        # pad to 64 KiB so there is a "page" to damage
        i=0
        while [ "$i" -lt 1000 ]; do
            echo "# padding padding padding padding padding padding padding padding $i"
            i=$((i + 1))
        done
    } > "$path"
    chmod +x "$path"
}

zero_page() { dd if=/dev/zero of="$1" bs=1 seek=8192 count=4096 conv=notrunc 2>/dev/null; }

# Release API JSON (pretty printed, with nested objects and a null digest)
make_release_json() { # make_release_json <out> <asset> <digest-or-empty>
    local out="$1" asset="$2" digest="$3"
    {
        echo '{'
        echo '  "tag_name": "v1.2.3",'
        echo '  "name": "v1.2.3",'
        echo '  "assets": ['
        echo '    {'
        echo '      "name": "other-asset",'
        echo '      "uploader": { "login": "x", "id": 1 },'
        echo '      "digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111",'
        echo '      "size": 1'
        echo '    },'
        echo '    {'
        echo '      "name": "unlisted-asset",'
        echo '      "digest": null,'
        echo '      "size": 2'
        echo '    },'
        echo '    {'
        echo "      \"name\": \"$asset\","
        echo '      "uploader": { "login": "x", "id": 1 },'
        echo '      "content_type": "application/octet-stream",'
        if [ -n "$digest" ]; then
            echo "      \"digest\": \"sha256:$digest\","
        else
            echo '      "digest": null,'
        fi
        echo '      "size": 3'
        echo '    }'
        echo '  ]'
        echo '}'
    } > "$out"
}

# curl stub: release API -> $FIX/release.json (or fail), asset URLs -> $FIX/asset/<name>
curl() {
    local url="" out="" prev=""
    local a
    for a in "$@"; do
        [ "$prev" = "-o" ] && out="$a"
        case "$a" in http*) url="$a" ;; esac
        prev="$a"
    done
    case "$url" in
        https://api.github.com/*)
            [ -f "$FIX/release.json" ] || return 22
            cat "$FIX/release.json"
            ;;
        */releases/download/*)
            local f="$FIX/asset/${url##*/}"
            [ -f "$f" ] || return 22
            if [ -n "$out" ]; then cp "$f" "$out"; else cat "$f"; fi
            ;;
        *) return 6 ;;
    esac
}

reset_release() { RELEASE_JSON=""; RELEASE_JSON_STATE=""; : > "$LOG"; rm -rf "$FIX/asset" "$FIX/release.json"; mkdir -p "$FIX/asset"; }
leftovers() { find "$1" -maxdepth 1 -name '.*.*' -type f 2>/dev/null; }

# ---------------------------------------------------------------------------
echo "== sha256_of / digest parsing =="

printf 'hello' > "$WORK/hello"
HELLO=2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
check "sha256_of file" test "$(sha256_of "$WORK/hello")" = "$HELLO"
check "sha256_of stdin" test "$(printf 'hello' | sha256_of)" = "$HELLO"

for tool in shasum sha256sum openssl; do
    real="$(command -v "$tool" 2>/dev/null)" || { echo "[skip] $tool not installed"; continue; }
    bindir="$(newdir)"
    ln -s "$real" "$bindir/$tool"
    for t in awk tr; do ln -s "$(command -v $t)" "$bindir/$t"; done
    got="$(PATH="$bindir" sha256_of "$WORK/hello")"
    check "sha256_of falls back to $tool only" test "$got" = "$HELLO"
done
check "sha256_of fails with no hasher" bash -c "PATH=/nonexistent; . '$ROOT/install.sh' >/dev/null 2>&1; ! sha256_of '$WORK/hello' >/dev/null 2>&1"

reset_release
make_release_json "$FIX/release.json" "agent-relay-broker-test-test" "ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
check "expected digest parsed from release JSON (lowercased, right asset)" \
    test "$(fetch_asset_expected_sha256 agent-relay-broker-test-test)" = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"
check "null digest yields nothing" test -z "$(fetch_asset_expected_sha256 unlisted-asset)"
check "unknown asset yields nothing" test -z "$(fetch_asset_expected_sha256 nope)"
check "other asset digest not confused" \
    test "$(fetch_asset_expected_sha256 other-asset)" = "1111111111111111111111111111111111111111111111111111111111111111"

echo "== digest parsing: real GitHub release shape and nested names =="

# parse_with <jq|nojq> <asset>: run fetch_asset_expected_sha256 with or without jq
parse_with() {
    local mode="$1" asset="$2"
    if [ "$mode" = nojq ]; then
        eval 'has_command() { [ "$1" != jq ] && command -v "$1" >/dev/null 2>&1; }'
    fi
    fetch_asset_expected_sha256 "$asset"
    eval 'has_command() { command -v "$1" >/dev/null 2>&1; }'
}
REAL_FIXTURE="$ROOT/scripts/fixtures/release-v12.4.0.json"
for mode in jq nojq; do
    [ "$mode" = jq ] && ! command -v jq >/dev/null 2>&1 && { echo "[skip] jq not installed"; continue; }
    RELEASE_JSON="$(cat "$REAL_FIXTURE")"; RELEASE_JSON_STATE=ok
    ok=1; count=0
    while IFS=' ' read -r name digest; do
        count=$((count + 1))
        [ "$(parse_with "$mode" "$name")" = "$digest" ] || { ok=0; echo "       mismatch for $name"; }
    done <<EOT
$(sed -n 's/^      "name": "\([^"]*\)",$/\1/p;s/^      "digest": "sha256:\([0-9a-f]*\)".*/\1/p' "$REAL_FIXTURE" | paste -d' ' - -)
EOT
    check "real v12.4.0 release JSON: every asset digest parsed ($mode, $count assets)" test "$ok" -eq 1 -a "$count" -ge 4
    check "real release JSON: unknown asset yields nothing ($mode)" test -z "$(parse_with "$mode" nope)"

    # nested "name" keys before the digest (uploader/author/license-like objects), digest before name, tricky strings
    RELEASE_JSON='{"name":"v9","author":{"name":"Release Bot","login":"x"},"assets":[
      {"name":"asset-a","label":"name","uploader":{"login":"u","name":"Builder"},"labels":[{"name":"x"}],"digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":1},
      {"digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","uploader":{"name":"asset-a"},"name":"asset-b"},
      {"name":"asset-c","note":"has \"quote\" and }","digest":null}
    ],"zipball_url":"x","digest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}'
    RELEASE_JSON_STATE=ok
    check "nested name before digest still finds the digest ($mode)" \
        test "$(parse_with "$mode" asset-a)" = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    check "digest listed before name is found ($mode)" \
        test "$(parse_with "$mode" asset-b)" = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    check "null digest and nested value do not leak into another asset ($mode)" test -z "$(parse_with "$mode" asset-c)"
    check "top-level digest-looking keys are not an asset digest ($mode)" test -z "$(parse_with "$mode" v9)"
done

# ---------------------------------------------------------------------------
echo "== (a) good file installs; previous kept as .prev until verified =="

reset_release
D="$(newdir)"; DEST="$D/agent-relay-broker"
make_fake_broker "$DEST" ok old
OLD_HASH="$(sha256_of "$DEST")"
make_fake_broker "$FIX/asset/agent-relay-broker-test-test" ok new
GOOD="$(sha256_of "$FIX/asset/agent-relay-broker-test-test")"
make_release_json "$FIX/release.json" "agent-relay-broker-test-test" "$GOOD"

eval "$(declare -f sha256_of | sed '1s/sha256_of/real_sha256_of/')"
sha256_of() {
    # the read-back hash of the destination: .prev must still hold the old binary
    if [ "$1" = "$DEST" ] && [ -f "$DEST.prev" ] && [ "$(real_sha256_of "$DEST.prev")" = "$OLD_HASH" ]; then
        echo seen > "$WORK/prev-seen"
    fi
    real_sha256_of "$@"
}
rm -f "$WORK/prev-seen"
fetch_release_asset agent-relay-broker-test-test "$D" raw; rc=$?
check "fetch verified the digest" test "$rc" -eq 0
check "fetch logged the verification" contains "$(cat "$LOG")" "Verified SHA-256"
install_binary_atomic "$FETCHED_TMP" "$DEST" check_broker_binary; rc=$?
check "install succeeded" test "$rc" -eq 0
check "destination is the new binary" test "$(real_sha256_of "$DEST")" = "$GOOD"
check ".prev held the old binary at read-back time" test -f "$WORK/prev-seen"
check ".prev removed once verified" test ! -e "$DEST.prev"
check "no temp files left behind" test -z "$(leftovers "$D")"
check "smoke test noted in output" contains "$(cat "$LOG")" "smoke test passed"
sha256_of() { real_sha256_of "$@"; }

echo "== read-back mismatch restores the previous binary =="
reset_release
D="$(newdir)"; DEST="$D/agent-relay-broker"
make_fake_broker "$DEST" ok old
OLD_HASH="$(real_sha256_of "$DEST")"
make_fake_broker "$D/new" ok new
sha256_of() { if [ "$1" = "$DEST" ]; then echo deadbeef; else real_sha256_of "$@"; fi; }
install_binary_atomic "$D/new" "$DEST" true; rc=$?
sha256_of() { real_sha256_of "$@"; }
check "install reports failure" test "$rc" -ne 0
check "previous binary restored" test "$(real_sha256_of "$DEST")" = "$OLD_HASH"
check "restore explained" contains "$(cat "$LOG")" "restoring the previous binary"
check ".prev consumed by the restore" test ! -e "$DEST.prev"

# ---------------------------------------------------------------------------
echo "== (b) zero-filled page injected after download =="

reset_release
D="$(newdir)"; DEST="$D/agent-relay-broker"
make_fake_broker "$DEST" ok old
OLD_HASH="$(sha256_of "$DEST")"
make_fake_broker "$FIX/asset/pristine" ok pristine
PRISTINE="$(sha256_of "$FIX/asset/pristine")"
cp "$FIX/asset/pristine" "$FIX/asset/agent-relay-broker-test-test"
zero_page "$FIX/asset/agent-relay-broker-test-test"
check "fixture really differs from pristine" test "$(sha256_of "$FIX/asset/agent-relay-broker-test-test")" != "$PRISTINE"
make_release_json "$FIX/release.json" "agent-relay-broker-test-test" "$PRISTINE"
fetch_release_asset agent-relay-broker-test-test "$D" raw; rc=$?
check "damaged download rejected (rc 2)" test "$rc" -eq 2
check "mismatch reported" contains "$(cat "$LOG")" "SHA-256 mismatch"
check "destination untouched" test "$(sha256_of "$DEST")" = "$OLD_HASH"
check "no temp files left behind" test -z "$(leftovers "$D")"

echo "== (b2) no digest, but the binary crashes on init (SIGILL) =="
reset_release
D="$(newdir)"; DEST="$D/agent-relay-broker"
make_fake_broker "$DEST" ok old
OLD_HASH="$(sha256_of "$DEST")"
make_fake_broker "$FIX/asset/agent-relay-broker-test-test" crash
make_release_json "$FIX/release.json" "agent-relay-broker-test-test" ""
fetch_release_asset agent-relay-broker-test-test "$D" raw; rc=$?
check "fetch continues without a digest" test "$rc" -eq 0
install_binary_atomic "$FETCHED_TMP" "$DEST" check_broker_binary; rc=$?
check "crashing broker rejected" test "$rc" -ne 0
check "smoke failure names the signal" contains "$(cat "$LOG")" "init exited with status 132"
check "destination untouched" test "$(sha256_of "$DEST")" = "$OLD_HASH"
check "no .prev or temp files left" test "$(find "$D" -type f | wc -l | tr -d ' ')" = "1"

echo "== smoke test: telemetry opt-out is not applied on the user's behalf =="
reset_release
cat > "$WORK/telbroker" <<'TEL'
#!/bin/bash
case "$1" in --help) exit 0 ;; esac
# crash unless the user opted out (stands in for the telemetry code path)
if [ -z "$AGENT_RELAY_TELEMETRY_DISABLED$DO_NOT_TRACK" ]; then kill -ILL $$; fi
exec sleep 30
TEL
chmod +x "$WORK/telbroker"
smoke_test_broker "$WORK/telbroker"; rc=$?
check "telemetry path is exercised by default" test "$rc" -ne 0
AGENT_RELAY_TELEMETRY_DISABLED=1 smoke_test_broker "$WORK/telbroker"; rc=$?
check "user's own opt-out is forwarded" test "$rc" -eq 0

echo "== smoke test: scrubbed environment =="
reset_release
export AGENT_RELAY_API_KEY=secret RELAY_API_KEY=secret
make_fake_broker "$WORK/envbroker" env
smoke_test_broker "$WORK/envbroker"; rc=$?
unset AGENT_RELAY_API_KEY RELAY_API_KEY
check "RELAY_*/AGENT_RELAY_* not visible to the broker under test" test "$rc" -eq 0

# ---------------------------------------------------------------------------
echo "== (c) replacing a binary a running process holds open =="

reset_release
D="$(newdir)"; DEST="$D/agent-relay-broker"
# Prefer a NATIVE executable as the running process: a shell script keeps
# running its already parsed loop even if the file is overwritten in place, so
# it could never tell an in-place overwrite from an atomic rename. If a copy of
# a native binary will not run here, fall back to a script and rely on the
# inode/open-fd assertions below, which do not depend on the fixture type.
FIXTURE_KIND=native
cp "$(command -v sleep)" "$DEST" 2>/dev/null && chmod +x "$DEST"
# a copied Apple platform binary is killed unless re-signed
[ "$(uname -s)" = Darwin ] && codesign --force --sign - "$DEST" >/dev/null 2>&1
"$DEST" 300 &
RUNNING=$!
sleep 1
if ! kill -0 "$RUNNING" 2>/dev/null; then
    FIXTURE_KIND=script
    { echo '#!/bin/bash'; echo '# old'; echo 'while :; do sleep 1; done'; } > "$DEST"; chmod +x "$DEST"
    "$DEST" &
    RUNNING=$!
    sleep 1
fi
echo "       (running-process fixture: $FIXTURE_KIND)"
OLD_INODE="$(ls -i "$DEST" | awk '{print $1}')"
exec 9< "$DEST"                 # hold the old inode open; in-place writes would show through this fd
OLD_CONTENT_HASH="$(real_sha256_of "$DEST")"
make_fake_broker "$FIX/asset/agent-relay-broker-test-test" ok new
NEW="$(sha256_of "$FIX/asset/agent-relay-broker-test-test")"
make_release_json "$FIX/release.json" "agent-relay-broker-test-test" "$NEW"
fetch_release_asset agent-relay-broker-test-test "$D" raw
install_binary_atomic "$FETCHED_TMP" "$DEST" check_broker_binary; rc=$?
check "install over a running binary succeeded" test "$rc" -eq 0
sleep 1
check "running process still alive" kill -0 "$RUNNING"
check "destination now has the NEW content" test "$(sha256_of "$DEST")" = "$NEW"
check "destination is a different inode (atomic rename, not in-place write)" test "$(ls -i "$DEST" | awk '{print $1}')" != "$OLD_INODE"
check "the old inode, still open, still has the OLD content" test "$(cat <&9 | real_sha256_of)" = "$OLD_CONTENT_HASH"
exec 9<&-
# detector self-test: an in-place overwrite WOULD be caught by the fd check
cp "$D/agent-relay-broker" "$D/inplace"
exec 8< "$D/inplace"
before="$(real_sha256_of "$D/inplace")"
cat "$FIX/asset/pristine" > "$D/inplace" 2>/dev/null || make_fake_broker "$D/inplace" crash inplace
check "detector self-test: the open-fd check notices an in-place overwrite" test "$(cat <&8 | real_sha256_of)" != "$before"
exec 8<&-
kill "$RUNNING" 2>/dev/null; { wait "$RUNNING"; } 2>/dev/null

# ---------------------------------------------------------------------------
echo "== (d) missing digest warns instead of silently passing =="

reset_release
D="$(newdir)"
make_fake_broker "$FIX/asset/agent-relay-broker-test-test" ok new
make_release_json "$FIX/release.json" "agent-relay-broker-test-test" ""
fetch_release_asset agent-relay-broker-test-test "$D" raw; rc=$?
check "continues (rc 0)" test "$rc" -eq 0
check "warns about the missing digest" contains "$(cat "$LOG")" "publishes no SHA-256 digest"
rm -f "$FETCHED_TMP"

reset_release   # no release.json at all: API unavailable / rate limited
D="$(newdir)"
make_fake_broker "$FIX/asset/agent-relay-broker-test-test" ok new
fetch_release_asset agent-relay-broker-test-test "$D" raw; rc=$?
check "API failure continues (rc 0)" test "$rc" -eq 0
check "API failure warns" contains "$(cat "$LOG")" "Could not fetch release metadata"
rm -f "$FETCHED_TMP"

# ---------------------------------------------------------------------------
echo "== (e) checksum mismatch fails =="

reset_release
D="$(newdir)"
make_fake_broker "$FIX/asset/agent-relay-broker-test-test" ok new
make_release_json "$FIX/release.json" "agent-relay-broker-test-test" "0000000000000000000000000000000000000000000000000000000000000000"
fetch_release_asset agent-relay-broker-test-test "$D" raw; rc=$?
check "mismatch returns 2" test "$rc" -eq 2
check "mismatch warns with both digests" contains "$(cat "$LOG")" "expected 0000"
check "nothing left in the install dir" test -z "$(ls -A "$D")"

# ---------------------------------------------------------------------------
echo "== gz assets: digest of the archive, clean-decode cross-check =="

reset_release
D="$(newdir)"
make_fake_broker "$WORK/plain" ok gz
gzip -c "$WORK/plain" > "$FIX/asset/agent-relay-test-test.gz"
GZ="$(sha256_of "$FIX/asset/agent-relay-test-test.gz")"
make_release_json "$FIX/release.json" "agent-relay-test-test.gz" "$GZ"
fetch_release_asset agent-relay-test-test.gz "$D" gz; rc=$?
check "gz fetch ok" test "$rc" -eq 0
check "decoded bytes identical to the original" cmp -s "$FETCHED_TMP" "$WORK/plain"
check "only the decoded temp file remains" test "$(ls -A "$D" | wc -l | tr -d ' ')" = "1"
rm -f "$FETCHED_TMP"
make_release_json "$FIX/release.json" "agent-relay-test-test.gz" "1111111111111111111111111111111111111111111111111111111111111111"
# shellcheck disable=SC2034
RELEASE_JSON=""
# shellcheck disable=SC2034
RELEASE_JSON_STATE=""
fetch_release_asset agent-relay-test-test.gz "$D" gz; rc=$?
check "gz digest mismatch rejected" test "$rc" -eq 2

# ---------------------------------------------------------------------------
echo "== transactional standalone install (CLI + broker) =="

detect_platform >/dev/null 2>&1
REAL_PLATFORM="$PLATFORM"
make_fake_cli() { # make_fake_cli <path> <version>
    printf '#!/bin/bash\n[ "$1" = "--version" ] && { echo "%s"; exit 0; }\nexit 0\n' "$2" > "$1"; chmod +x "$1"
}
e2e_setup() { # e2e_setup <broker-mode> <digests: yes|no> [old-cli: yes|no]
    reset_release
    INSTALL_DIR="$(newdir)"; BIN_DIR="$(newdir)"; mkdir -p "$INSTALL_DIR/bin"
    make_fake_broker "$INSTALL_DIR/bin/agent-relay-broker" ok oldbroker
    make_fake_cli "$FIX/cli-new" "9.9.9"
    gzip -c "$FIX/cli-new" > "$FIX/asset/agent-relay-$REAL_PLATFORM.gz"
    make_fake_broker "$FIX/asset/agent-relay-broker-$REAL_PLATFORM" "$1" newbroker
    if [ "${3:-yes}" = yes ]; then make_fake_cli "$INSTALL_DIR/bin/agent-relay" "1.0.0"; fi
    {
        echo '{"assets": ['
        if [ "$2" = yes ]; then
            echo "{\"name\": \"agent-relay-$REAL_PLATFORM.gz\", \"digest\": \"sha256:$(sha256_of "$FIX/asset/agent-relay-$REAL_PLATFORM.gz")\"},"
            echo "{\"name\": \"agent-relay-broker-$REAL_PLATFORM\", \"digest\": \"sha256:$(sha256_of "$FIX/asset/agent-relay-broker-$REAL_PLATFORM")\"}"
        else
            echo '{"name": "unrelated", "digest": null}'
        fi
        echo ']}'
    } > "$FIX/release.json"
    OLD_BROKER_HASH="$(sha256_of "$INSTALL_DIR/bin/agent-relay-broker")"
}
run_main() { ( export AGENT_RELAY_TELEMETRY_DISABLED=1; main ) > "$WORK/main.out" 2>&1; }

e2e_setup ok yes
run_main; rc=$?
check "all good: installer exits 0" test "$rc" -eq 0
check "all good: CLI upgraded" test "$("$INSTALL_DIR/bin/agent-relay" --version)" = "9.9.9"
check "all good: no .prev left" test ! -e "$INSTALL_DIR/bin/agent-relay.prev"

e2e_setup crash no
run_main; rc=$?
check "broker rejected: installer exits NON-zero" test "$rc" -ne 0
check "broker rejected: previous CLI restored" test "$("$INSTALL_DIR/bin/agent-relay" --version)" = "1.0.0"
check "broker rejected: old broker untouched" test "$(sha256_of "$INSTALL_DIR/bin/agent-relay-broker")" = "$OLD_BROKER_HASH"
check "broker rejected: message says CLI was not kept" contains "$(cat "$WORK/main.out")" "CLI was NOT kept"
check "broker rejected: no success message" test -z "$(grep -i 'installed successfully' "$WORK/main.out")"
check "broker rejected: no .prev/temp files" test "$(find "$INSTALL_DIR" "$BIN_DIR" -name '.*' -type f | wc -l | tr -d ' ')" = "0" -a ! -e "$INSTALL_DIR/bin/agent-relay.prev"

e2e_setup crash no no
run_main; rc=$?
check "fresh install + rejected broker: exits non-zero" test "$rc" -ne 0
check "fresh install + rejected broker: new CLI removed" test ! -e "$INSTALL_DIR/bin/agent-relay" -a ! -e "$BIN_DIR/agent-relay"

echo "== an existing .prev survives until the new binary is verified =="
reset_release
D="$(newdir)"; DEST="$D/tool"
make_fake_broker "$DEST" ok current
make_fake_broker "$D/tool.prev" ok oldest
OLDEST="$(sha256_of "$D/tool.prev")"
make_fake_broker "$D/new" crash broken
install_binary_atomic "$D/new" "$DEST" check_broker_binary; rc=$?
check "failed verification: install rejected" test "$rc" -ne 0
check "failed verification: existing .prev intact" test "$(sha256_of "$D/tool.prev")" = "$OLDEST"
make_fake_broker "$D/new2" ok newer
install_binary_atomic "$D/new2" "$DEST" check_broker_binary; rc=$?
check "successful install over an existing .prev" test "$rc" -eq 0
check "the older .prev is rotated to .prev.1, not lost" test "$(sha256_of "$D/tool.prev.1")" = "$OLDEST"

echo "== a stale CLI .prev is not mistaken for this run's backup =="
e2e_setup crash no no
make_fake_cli "$INSTALL_DIR/bin/agent-relay.prev" "0.0.1"
run_main; rc=$?
check "stale .prev: installer exits non-zero" test "$rc" -ne 0
check "stale .prev: not resurrected as the CLI" test ! -e "$INSTALL_DIR/bin/agent-relay"
check "stale .prev: left untouched" test -e "$INSTALL_DIR/bin/agent-relay.prev"

echo "== broker copy into BIN_DIR fails after the INSTALL_DIR install committed =="
e2e_setup ok yes
orig_copy="$(declare -f copy_binary_atomic)"
copy_binary_atomic() { echo "[test] simulated full/unwritable BIN_DIR" >> "$LOG"; return 1; }
run_main; rc=$?
eval "$orig_copy"
check "second-destination failure: exits non-zero" test "$rc" -ne 0
check "second-destination failure: INSTALL_DIR broker is the OLD one again (no skew)" \
    test "$(sha256_of "$INSTALL_DIR/bin/agent-relay-broker")" = "$OLD_BROKER_HASH"
check "second-destination failure: CLI restored" test "$("$INSTALL_DIR/bin/agent-relay" --version)" = "1.0.0"
check "second-destination failure: no .prev/temp files" \
    test -z "$(find "$INSTALL_DIR" "$BIN_DIR" -name '*.prev*' -o -name '.*.??????' | head -1)"

e2e_setup ok yes no
orig_copy="$(declare -f copy_binary_atomic)"
copy_binary_atomic() { return 1; }
run_main; rc=$?
eval "$orig_copy"
check "fresh install, second copy fails: exits non-zero and leaves no new broker" test "$rc" -ne 0 -a ! -e "$INSTALL_DIR/bin/agent-relay-broker.prev"

echo "== a pre-existing launcher survives a rejected broker =="
e2e_setup crash no no
rm -f "$INSTALL_DIR/bin/agent-relay-broker"
printf '#!/bin/bash\n# npm launcher\nexec node /somewhere "$@"\n' > "$BIN_DIR/agent-relay"; chmod +x "$BIN_DIR/agent-relay"
cp -p "$BIN_DIR/agent-relay" "$WORK/launcher.orig"
run_main; rc=$?
check "launcher case: exits non-zero" test "$rc" -ne 0
check "launcher case: pre-existing launcher byte-identical" cmp -s "$BIN_DIR/agent-relay" "$WORK/launcher.orig"
check "launcher case: no new standalone CLI left" test ! -e "$INSTALL_DIR/bin/agent-relay"
check "launcher case: no backup/temp files left" test -z "$(find "$BIN_DIR" "$INSTALL_DIR" -name '.*.??????' -o -name '*.prev*' | head -1)"

e2e_setup crash no yes
printf '#!/bin/bash\n# older launcher\nexec "%s/bin/agent-relay" "$@"\n' "$INSTALL_DIR" > "$BIN_DIR/agent-relay"; chmod +x "$BIN_DIR/agent-relay"
cp -p "$BIN_DIR/agent-relay" "$WORK/launcher.orig"
run_main; rc=$?
check "launcher + previous CLI: launcher byte-identical after rollback" cmp -s "$BIN_DIR/agent-relay" "$WORK/launcher.orig"

echo "== interrupted install cleans its temp files =="
for sig in INT TERM; do
    reset_release
    I="$(newdir)"; B="$(newdir)"; SHIM="$(newdir)"
    cat > "$SHIM/curl" <<'SHIMEOF'
#!/bin/bash
# fail the release API; for an asset download write a partial file, then signal the installer
out=""; url=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; case "$a" in http*) url="$a" ;; esac; prev="$a"; done
case "$url" in
  https://api.github.com/*) exit 22 ;;
  *) [ -n "$out" ] && echo partial > "$out"; kill -$SHIM_SIGNAL "$PPID"; sleep 1; exit 0 ;;
esac
SHIMEOF
    chmod +x "$SHIM/curl"
    ( cd "$ROOT" && env -u AGENT_RELAY_INSTALL_SOURCE_ONLY PATH="$SHIM:$PATH" SHIM_SIGNAL="$sig" HOME="$HOME" AGENT_RELAY_VERSION=1.2.3 \
        AGENT_RELAY_INSTALL_DIR="$I" AGENT_RELAY_BIN_DIR="$B" AGENT_RELAY_TELEMETRY_DISABLED=1 \
        bash install.sh ) > "$WORK/int.out" 2>&1; rc=$?
    check "$sig during download: installer stopped" test "$rc" -ne 0
    check "$sig during download: no .download/.decoded/.copy temp files left" \
        test -z "$(find "$I" "$B" -type f -name '.*.??????' | head -1)"
done

echo "== a signal during the broker step rolls the whole transaction back =="

# run the real installer with a curl shim that serves the fixtures
run_installer_shim() { # run_installer_shim <signal-on-broker-download: TERM|INT|HUP|none>
    local shim; shim="$(newdir)"
    cat > "$shim/curl" <<'SHIMEOF'
#!/bin/bash
out=""; url=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; case "$a" in http*) url="$a" ;; esac; prev="$a"; done
case "$url" in
  https://api.github.com/*) exit 22 ;;
  *agent-relay-broker-*)
      if [ "$SHIM_SIGNAL" != none ]; then [ -n "$out" ] && echo partial > "$out"; kill -"$SHIM_SIGNAL" "$PPID"; sleep 1; exit 0; fi
      cp "$SHIM_FIX/asset/${url##*/}" "$out" ;;
  *) f="$SHIM_FIX/asset/${url##*/}"; [ -f "$f" ] || exit 22; cp "$f" "$out" ;;
esac
SHIMEOF
    chmod +x "$shim/curl"
    ( cd "$ROOT" && env -u AGENT_RELAY_INSTALL_SOURCE_ONLY ${INSTALLER_SHELLOPTS:+SHELLOPTS="$INSTALLER_SHELLOPTS"} PATH="$shim:$PATH" SHIM_SIGNAL="$1" SHIM_FIX="$FIX" HOME="$HOME" \
        AGENT_RELAY_VERSION=1.2.3 AGENT_RELAY_INSTALL_DIR="$INSTALL_DIR" AGENT_RELAY_BIN_DIR="$BIN_DIR" \
        AGENT_RELAY_TELEMETRY_DISABLED=1 AGENT_RELAY_SMOKE_SECONDS=2 bash install.sh ) > "$WORK/sig.out" 2>&1
}
sig_setup() { # previous CLI 1.0.0, old broker, an existing launcher
    e2e_setup "${1:-ok}" no yes
    printf '#!/bin/bash\n# existing launcher\nexec "%s/bin/agent-relay" "$@"\n' "$INSTALL_DIR" > "$BIN_DIR/agent-relay"
    chmod +x "$BIN_DIR/agent-relay"; cp -p "$BIN_DIR/agent-relay" "$WORK/launcher.orig"
}
sig_assert() { # sig_assert <label>
    check "$1: installer stopped" test "$rc" -ne 0
    check "$1: previous CLI restored" test "$("$INSTALL_DIR/bin/agent-relay" --version)" = "1.0.0"
    check "$1: old broker untouched" test "$(sha256_of "$INSTALL_DIR/bin/agent-relay-broker")" = "$OLD_BROKER_HASH"
    check "$1: launcher byte-identical" cmp -s "$BIN_DIR/agent-relay" "$WORK/launcher.orig"
    check "$1: no .prev/temp files left" test -z "$(find "$INSTALL_DIR" "$BIN_DIR" -type f \( -name '.*.??????' -o -name '*.prev*' \) | head -1)"
}
for sig in TERM INT HUP; do
    sig_setup ok; run_installer_shim "$sig"; rc=$?
    sig_assert "$sig during broker download"
done

# signal while the broker smoke test is running (the fake broker signals its parent, the installer)
sig_setup sigsmoke
cat > "$FIX/asset/agent-relay-broker-$REAL_PLATFORM" <<'B'
#!/bin/bash
case "$1" in --help|--version) exit 0 ;; init) kill -TERM "$PPID"; exec sleep 30 ;; esac
B
chmod +x "$FIX/asset/agent-relay-broker-$REAL_PLATFORM"
run_installer_shim none; rc=$?
sig_assert "TERM during the broker smoke test"

# Signal windows around the two broker destinations. The transaction (CLI + launcher + both
# broker copies) either rolls back completely or is fully committed, never mixed.
old_bin_broker() { # an OLD broker also exists on PATH (BIN_DIR)
    cp -p "$INSTALL_DIR/bin/agent-relay-broker" "$BIN_DIR/agent-relay-broker"
}
sig_main_pid() { ( sh -c 'echo $PPID' > "$WORK/main.pid"; export AGENT_RELAY_TELEMETRY_DISABLED=1; main ) > "$WORK/main.out" 2>&1; }
both_brokers_old() {
    test "$(sha256_of "$INSTALL_DIR/bin/agent-relay-broker")" = "$OLD_BROKER_HASH" \
        -a "$(sha256_of "$BIN_DIR/agent-relay-broker")" = "$OLD_BROKER_HASH"
}

# (1) after the first copy, before the second
sig_setup ok; old_bin_broker
orig_copy="$(declare -f copy_binary_atomic)"
# (bash 3.2 has no $BASHPID: a child sh reports its parent, the subshell running main)
copy_binary_atomic() { kill -TERM "$(cat "$WORK/main.pid")"; sleep 1; return 0; }
sig_main_pid; rc=$?
eval "$orig_copy"
sig_assert "TERM between the two broker copies"
check "TERM between the two broker copies: BOTH broker locations are the old broker" both_brokers_old

# (2) after the second copy committed, before the install committed
sig_setup ok; old_bin_broker
orig_copy="$(declare -f copy_binary_atomic)"
eval "$(printf '%s\n' "$orig_copy" | sed '1s/copy_binary_atomic/real_copy_binary_atomic/')"
copy_binary_atomic() { real_copy_binary_atomic "$@" || return 1; kill -TERM "$(cat "$WORK/main.pid")"; sleep 1; return 0; }
sig_main_pid; rc=$?
eval "$orig_copy"
sig_assert "TERM right after the second copy committed"
check "TERM right after the second copy committed: BOTH broker locations are the old broker" both_brokers_old

# (3) after the whole install committed (during the ACP bridge step): fully NEW, nothing rolled back
sig_setup ok; old_bin_broker
orig_acp="$(declare -f install_acp_bridge)"
install_acp_bridge() { kill -TERM "$(cat "$WORK/main.pid")"; sleep 1; return 0; }
sig_main_pid; rc=$?
eval "$orig_acp"
NEW_B="$(sha256_of "$FIX/asset/agent-relay-broker-$REAL_PLATFORM")"
check "TERM after commit: CLI is the new one (not rolled back)" test "$("$INSTALL_DIR/bin/agent-relay" --version)" = "9.9.9"
check "TERM after commit: BOTH broker locations are the new broker" \
    test "$(sha256_of "$INSTALL_DIR/bin/agent-relay-broker")" = "$NEW_B" -a "$(sha256_of "$BIN_DIR/agent-relay-broker")" = "$NEW_B"

echo "== version probes cannot abort a rollback under inherited pipefail =="
sig_setup crash
printf '#!/bin/bash\nexit 1\n' > "$INSTALL_DIR/bin/agent-relay"; chmod +x "$INSTALL_DIR/bin/agent-relay"   # old CLI whose --version fails
cp -p "$INSTALL_DIR/bin/agent-relay" "$WORK/oldcli.orig"
printf '#!/bin/bash\nexit 1\n' > "$INSTALL_DIR/bin/agent-relay-broker"; chmod +x "$INSTALL_DIR/bin/agent-relay-broker"
OLD_BROKER_HASH="$(sha256_of "$INSTALL_DIR/bin/agent-relay-broker")"
INSTALLER_SHELLOPTS=pipefail run_installer_shim none; rc=$?
INSTALLER_SHELLOPTS=
check "pipefail: installer stopped" test "$rc" -ne 0
check "pipefail: rejection reason is reported" contains "$(cat "$WORK/sig.out")" "was rejected"
check "pipefail: previous CLI restored" cmp -s "$INSTALL_DIR/bin/agent-relay" "$WORK/oldcli.orig"
check "pipefail: launcher byte-identical" cmp -s "$BIN_DIR/agent-relay" "$WORK/launcher.orig"
check "pipefail: old broker untouched" test "$(sha256_of "$INSTALL_DIR/bin/agent-relay-broker")" = "$OLD_BROKER_HASH"

echo "== codesign missing / failing on macOS fails closed =="
SAVED_OS="$OS"
OS=darwin
orig_has_command="$(declare -f has_command)"
cs_log="$WORK/codesign.log"
codesign() { echo "$*" >> "$cs_log"; case "$*" in
    --verify*) echo "$CS_VERIFY_MSG" >&2; return "${CS_VERIFY_RC:-1}" ;;
    --force*)  return "${CS_SIGN_RC:-0}" ;; esac; }
printf 'x' > "$WORK/bin1"

: > "$cs_log"; CS_VERIFY_MSG="code object is not signed at all"; CS_SIGN_RC=1
prepare_downloaded_binary "$WORK/bin1" >/dev/null 2>&1; rc=$?
check "unsigned binary whose ad-hoc signing FAILS is rejected" test "$rc" -ne 0
: > "$cs_log"; CS_SIGN_RC=0
prepare_downloaded_binary "$WORK/bin1" >/dev/null 2>&1; rc=$?
check "unsigned binary is signed once and accepted" test "$rc" -eq 0 -a "$(grep -c -- '--force' "$cs_log")" = "1"
: > "$cs_log"; CS_VERIFY_MSG="invalid signature (code or signature have been modified)"
prepare_downloaded_binary "$WORK/bin1" >/dev/null 2>&1; rc=$?
check "modified signature is rejected" test "$rc" -ne 0
check "modified signature is never signed over" test -z "$(grep -- '--force' "$cs_log")"
unset -f codesign

has_command() { [ "$1" != codesign ] && command -v "$1" >/dev/null 2>&1; }
# shellcheck disable=SC2034
DIGEST_VERIFIED=0
prepare_downloaded_binary "$WORK/bin1" > "$WORK/prep.out" 2>&1; rc=$?
check "no codesign and no verified digest: rejected" test "$rc" -ne 0
# shellcheck disable=SC2034
DIGEST_VERIFIED=1
: > "$LOG"
prepare_downloaded_binary "$WORK/bin1" >/dev/null 2>&1; rc=$?
check "no codesign but digest verified: accepted with a warning" test "$rc" -eq 0 -a -n "$(grep -i codesign "$LOG")"
# shellcheck disable=SC2034
DIGEST_VERIFIED=0
eval "$orig_has_command"
OS="$SAVED_OS"

echo "== AGENT_RELAY_SMOKE_SECONDS is validated =="
for v in 0 abc -1 "" 1.5 99999; do
    got="$(AGENT_RELAY_SMOKE_SECONDS="$v" resolve_smoke_seconds 2>/dev/null)"
    case "$v" in 99999) want=60 ;; *) want=4 ;; esac
    check "AGENT_RELAY_SMOKE_SECONDS='$v' resolves to $want" test "$got" = "$want"
done
check "a valid value is kept" test "$(AGENT_RELAY_SMOKE_SECONDS=7 resolve_smoke_seconds)" = "7"
cat > "$WORK/late-crash" <<'B'
#!/bin/bash
case "$1" in --help) exit 0 ;; init) sleep 2; kill -ILL $$ ;; esac
B
chmod +x "$WORK/late-crash"
AGENT_RELAY_SMOKE_SECONDS=0 smoke_test_broker "$WORK/late-crash"; rc=$?
check "SMOKE_SECONDS=0 cannot make a crashing broker pass vacuously" test "$rc" -ne 0
printf '#!/bin/bash\ncase "$1" in --help) exit 0 ;; init) kill -ILL $$ ;; esac\n' > "$WORK/fast-crash"; chmod +x "$WORK/fast-crash"
warn() { echo "[warn] $1"; }
out="$(AGENT_RELAY_SMOKE_SECONDS=abc smoke_test_broker "$WORK/fast-crash" 2>&1)"
warn() { echo "[warn] $1" >> "$LOG"; }
check "invalid AGENT_RELAY_SMOKE_SECONDS warning is visible through smoke_test_broker" contains "$out" "Ignoring invalid AGENT_RELAY_SMOKE_SECONDS"

# ---------------------------------------------------------------------------
if [ -n "${AGENT_RELAY_TEST_BROKER:-}" ]; then
    echo "== real broker binary (pristine published build) =="
    D="$(newdir)"
    PRISTINE_BIN="$D/pristine"
    cp "$AGENT_RELAY_TEST_BROKER" "$PRISTINE_BIN"; chmod +x "$PRISTINE_BIN"
    # ZEROED: published bytes with the 16 KiB page at 0x900000 zero-filled, signature untouched
    ZEROED="$D/zeroed"
    cp "$AGENT_RELAY_TEST_BROKER" "$ZEROED"
    dd if=/dev/zero of="$ZEROED" bs=16384 seek=576 count=1 conv=notrunc 2>/dev/null
    chmod +x "$ZEROED"
    # RESIGNED: what the old installer left behind (zeroed + locally re-signed)
    RESIGNED="$D/resigned"
    cp "$ZEROED" "$RESIGNED"
    if [ "$(uname -s)" = Darwin ]; then
        codesign --remove-signature "$RESIGNED" >/dev/null 2>&1
        codesign --force --sign - "$RESIGNED" >/dev/null 2>&1
    fi
    check "fixtures differ from pristine" test "$(sha256_of "$ZEROED")" != "$(sha256_of "$PRISTINE_BIN")"

    AGENT_RELAY_SMOKE_SECONDS=4
    for optout in none opt-out; do
        for which in pristine resigned; do
            bin="$D/$which"
            if [ "$optout" = none ]; then
                smoke_test_broker "$bin"; rc=$?
            else
                AGENT_RELAY_TELEMETRY_DISABLED=1 smoke_test_broker "$bin"; rc=$?
            fi
            if [ "$which" = pristine ]; then
                check "smoke: pristine PASSES ($optout)" test "$rc" -eq 0
            else
                check "smoke: corrupt re-signed FAILS ($optout)" test "$rc" -ne 0
            fi
        done
    done

    if [ "$(uname -s)" = Darwin ]; then
        echo "== macOS signature check (offline integrity) =="
        # shellcheck disable=SC2034
        OS=darwin
        cp "$PRISTINE_BIN" "$D/p2"; prepare_downloaded_binary "$D/p2"; rc=$?
        check "pristine passes codesign --verify --strict" test "$rc" -eq 0
        check "valid shipped signature is kept (not re-signed)" test "$(sha256_of "$D/p2")" = "$(sha256_of "$PRISTINE_BIN")"
        cp "$ZEROED" "$D/z2"; prepare_downloaded_binary "$D/z2"; rc=$?
        check "zero-filled page fails the signature check" test "$rc" -ne 0
        check "damaged file was not re-signed" test "$(sha256_of "$D/z2")" = "$(sha256_of "$ZEROED")"

        echo "== real broker: download_broker_binary, scenarios A-D =="
        PLATFORM="darwin-arm64"
        A="agent-relay-broker-$PLATFORM"
        scenario() { # scenario <name> <served-file> <digest-of: file or none>
            reset_release
            INSTALL_DIR="$(newdir)"; BIN_DIR="$(newdir)"; mkdir -p "$INSTALL_DIR/bin"
            cp "$PRISTINE_BIN" "$INSTALL_DIR/bin/agent-relay-broker"
            cp "$2" "$FIX/asset/$A"
            if [ "$3" = none ]; then make_release_json "$FIX/release.json" "$A" ""
            else make_release_json "$FIX/release.json" "$A" "$(sha256_of "$3")"; fi
            LIVE_BEFORE="$(sha256_of "$INSTALL_DIR/bin/agent-relay-broker")"
            download_broker_binary >/dev/null; SC_RC=$?
        }
        scenario A "$PRISTINE_BIN" "$PRISTINE_BIN"
        check "A clean+digest: installed" test "$SC_RC" -eq 0
        check "A: installed bytes == published bytes (signature kept)" test "$(sha256_of "$INSTALL_DIR/bin/agent-relay-broker")" = "$(sha256_of "$PRISTINE_BIN")" -a "$(sha256_of "$BIN_DIR/agent-relay-broker")" = "$(sha256_of "$PRISTINE_BIN")"
        scenario B "$ZEROED" "$PRISTINE_BIN"
        check "B corrupt+digest: rejected (rc 2)" test "$SC_RC" -eq 2
        check "B: digest mismatch reported" contains "$(cat "$LOG")" "SHA-256 mismatch"
        check "B: live broker untouched" test "$(sha256_of "$INSTALL_DIR/bin/agent-relay-broker")" = "$LIVE_BEFORE"
        scenario C "$PRISTINE_BIN" none
        check "C clean, no digest: installed" test "$SC_RC" -eq 0
        check "C: warned about the missing digest" contains "$(cat "$LOG")" "publishes no SHA-256 digest"
        scenario D "$ZEROED" none
        check "D corrupt, no digest: REJECTED (rc 2)" test "$SC_RC" -eq 2
        check "D: rejected by the signature check" contains "$(cat "$LOG")" "Code signature check failed"
        check "D: live broker untouched" test "$(sha256_of "$INSTALL_DIR/bin/agent-relay-broker")" = "$LIVE_BEFORE"
        # Even if the signature check were bypassed, the (re-signed) damage is caught by the smoke test
        prepare_downloaded_binary() { codesign --force --sign - "$1" >/dev/null 2>&1; return 0; }
        scenario D2 "$ZEROED" none
        check "D (signature check bypassed): smoke test still rejects it" test "$SC_RC" -eq 2
        check "D2: smoke failure reported (status 132)" contains "$(cat "$LOG")" "init exited with status 132"
        check "D2: live broker untouched" test "$(sha256_of "$INSTALL_DIR/bin/agent-relay-broker")" = "$LIVE_BEFORE"
    fi
fi

echo
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
