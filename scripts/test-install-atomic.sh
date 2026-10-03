#!/bin/bash
#
# Tests for the atomic, checksum-verified install path in install.sh.
# Everything runs in temp dirs with HOME pointed at a temp dir; the network is
# replaced by a `curl` shell function serving local fixtures.
#
# Usage:
#   scripts/test-install-atomic.sh
#   AGENT_RELAY_TEST_BROKER=/path/to/real/broker scripts/test-install-atomic.sh
#       additionally runs the real-binary cases (pristine passes the smoke
#       test, one with a zeroed page is rejected). Also set
#       AGENT_RELAY_TEST_CORRUPT_BROKER=/path/to/damaged/broker for the full
#       download_broker_binary flow with a real damaged build (macOS arm64).
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
            ok)    echo '    sleep 30; exit 0 ;;' ;;
            crash) echo '    kill -ILL $$ ;;' ;;
            env)   echo '    if env | grep -q "secret"; then exit 3; fi; sleep 30 ;;' ;;
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
sleep 30
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
{ echo '#!/bin/bash'; echo '# old'; echo 'while :; do sleep 1; done'; } > "$DEST"; chmod +x "$DEST"
"$DEST" &
RUNNING=$!
sleep 1
make_fake_broker "$FIX/asset/agent-relay-broker-test-test" ok new
NEW="$(sha256_of "$FIX/asset/agent-relay-broker-test-test")"
make_release_json "$FIX/release.json" "agent-relay-broker-test-test" "$NEW"
fetch_release_asset agent-relay-broker-test-test "$D" raw
install_binary_atomic "$FETCHED_TMP" "$DEST" check_broker_binary; rc=$?
check "install over a running binary succeeded" test "$rc" -eq 0
sleep 1
check "running process still alive" kill -0 "$RUNNING"
check "destination is the new binary" test "$(sha256_of "$DEST")" = "$NEW"
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
if [ -n "${AGENT_RELAY_TEST_BROKER:-}" ]; then
    echo "== real broker binary =="
    AGENT_RELAY_SMOKE_SECONDS=4
    reset_release
    D="$(newdir)"
    cp "$AGENT_RELAY_TEST_BROKER" "$D/pristine"; chmod +x "$D/pristine"
    smoke_test_broker "$D/pristine"; rc=$?
    check "pristine broker passes the init smoke test" test "$rc" -eq 0
    cp "$AGENT_RELAY_TEST_BROKER" "$D/damaged"
    # zero the 16 KiB page at file offset 0x900000 (the #1885 damage), re-sign
    dd if=/dev/zero of="$D/damaged" bs=16384 seek=576 count=1 conv=notrunc 2>/dev/null
    [ "$(uname -s)" = Darwin ] && codesign --force --sign - "$D/damaged" >/dev/null 2>&1
    check "damaged copy differs" test "$(sha256_of "$D/damaged")" != "$(sha256_of "$D/pristine")"
    DEST="$D/live"; cp "$D/pristine" "$DEST"; LIVE="$(sha256_of "$DEST")"
    install_binary_atomic "$D/damaged" "$DEST" check_broker_binary; rc=$?
    check "damaged (re-signed) broker rejected by smoke test" test "$rc" -ne 0
    check "live broker untouched" test "$(sha256_of "$DEST")" = "$LIVE"
fi

if [ -n "${AGENT_RELAY_TEST_BROKER:-}" ] && [ -n "${AGENT_RELAY_TEST_CORRUPT_BROKER:-}" ]; then
    echo "== real broker: full download_broker_binary flow =="
    reset_release
    PLATFORM="darwin-arm64"
    INSTALL_DIR="$(newdir)"; BIN_DIR="$(newdir)"
    mkdir -p "$INSTALL_DIR/bin"
    A="agent-relay-broker-$PLATFORM"
    cp "$AGENT_RELAY_TEST_BROKER" "$FIX/asset/$A"
    make_release_json "$FIX/release.json" "$A" "$(sha256_of "$AGENT_RELAY_TEST_BROKER")"
    download_broker_binary >/dev/null; rc=$?
    check "pristine published broker installs" test "$rc" -eq 0
    check "both copies were installed and smoke tested" \
        test -x "$INSTALL_DIR/bin/agent-relay-broker" -a -x "$BIN_DIR/agent-relay-broker"
    GOODSIG="$(sha256_of "$BIN_DIR/agent-relay-broker")"
    # Same published digest, but the bytes served are the corrupt build: rejected on digest
    reset_release
    cp "$AGENT_RELAY_TEST_CORRUPT_BROKER" "$FIX/asset/$A"
    make_release_json "$FIX/release.json" "$A" "$(sha256_of "$AGENT_RELAY_TEST_BROKER")"
    download_broker_binary >/dev/null; rc=$?
    check "corrupt bytes rejected by digest" test "$rc" -ne 0
    # No digest published: the corrupt build must still be rejected by the init smoke test
    reset_release
    cp "$AGENT_RELAY_TEST_CORRUPT_BROKER" "$FIX/asset/$A"
    make_release_json "$FIX/release.json" "$A" ""
    AGENT_RELAY_SMOKE_SECONDS=4 download_broker_binary >/dev/null; rc=$?
    check "corrupt bytes with no digest rejected by smoke test" test "$rc" -ne 0
    check "smoke failure reported (status 132)" contains "$(cat "$LOG")" "init exited with status 132"
    check "installed broker untouched by the failed installs" \
        test "$(sha256_of "$BIN_DIR/agent-relay-broker")" = "$GOODSIG" -a -z "$(find "$INSTALL_DIR" "$BIN_DIR" -name '.*.*' -type f)"
fi

echo
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
