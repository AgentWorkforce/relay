#!/bin/bash
set -e

# Agent Relay Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/AgentWorkforce/relay/main/install.sh | bash
#
# Options (set as environment variables):
#   AGENT_RELAY_VERSION              - Specific version to install (default: latest)
#   AGENT_RELAY_INSTALL_DIR          - Installation directory (default: ~/.agentworkforce/relay)
#   AGENT_RELAY_BIN_DIR              - Binary directory (default: ~/.local/bin)
#   AGENT_RELAY_TELEMETRY_DISABLED   - Disable anonymous install telemetry (default: false)

REPO_RELAY="AgentWorkforce/relay"
VERSION="${AGENT_RELAY_VERSION:-latest}"
INSTALL_DIR="${AGENT_RELAY_INSTALL_DIR:-$HOME/.agentworkforce/relay}"
BIN_DIR="${AGENT_RELAY_BIN_DIR:-$HOME/.local/bin}"
ORIGINAL_PATH="${PATH:-}"
STANDALONE_FAILURE_REASON=""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info() { echo -e "${BLUE}[info]${NC} $1"; }
success() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
error() {
    echo -e "${RED}[error]${NC} $1"
    # Track failure if telemetry is initialized
    if [ -n "$INSTALL_ID" ]; then
        # Escape special characters for JSON (newlines, quotes, backslashes)
        local escaped_error
        escaped_error=$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')
        track_event "install_failed" ", \"error\": \"$escaped_error\""
    fi
    exit 1
}
step() { echo -e "\n${CYAN}${BOLD}$1${NC}"; }

# Telemetry (respects AGENT_RELAY_TELEMETRY_DISABLED)
POSTHOG_API_KEY="phc_2uDu01GtnLABJpVkWw4ri1OgScLU90aEmXmDjufGdqr"
POSTHOG_HOST="https://us.i.posthog.com"
INSTALL_ID=""
INSTALL_METHOD=""

telemetry_enabled() {
    # Respect opt-out
    if [ "${AGENT_RELAY_TELEMETRY_DISABLED:-}" = "1" ] || [ "${AGENT_RELAY_TELEMETRY_DISABLED:-}" = "true" ]; then
        return 1
    fi
    # Also check DO_NOT_TRACK (standard env var)
    if [ "${DO_NOT_TRACK:-}" = "1" ]; then
        return 1
    fi
    return 0
}

generate_install_id() {
    # Generate a random ID for this install session
    if command -v uuidgen &> /dev/null; then
        INSTALL_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
    elif [ -f /proc/sys/kernel/random/uuid ]; then
        INSTALL_ID=$(cat /proc/sys/kernel/random/uuid)
    else
        # Fallback: use timestamp + random
        INSTALL_ID="install-$(date +%s)-$RANDOM"
    fi
}

track_event() {
    if ! telemetry_enabled; then
        return 0
    fi

    local event="$1"
    local extra_props="${2:-}"

    # Send async (don't block install)
    (curl -sS --max-time 5 -X POST "${POSTHOG_HOST}/capture/" \
        -H "Content-Type: application/json" \
        -d "{
            \"api_key\": \"${POSTHOG_API_KEY}\",
            \"event\": \"${event}\",
            \"distinct_id\": \"${INSTALL_ID}\",
            \"properties\": {
                \"platform\": \"${PLATFORM:-unknown}\",
                \"version\": \"${VERSION:-unknown}\",
                \"method\": \"${INSTALL_METHOD:-unknown}\",
                \"os\": \"${OS:-unknown}\",
                \"arch\": \"${ARCH:-unknown}\",
                \"has_node\": \"${HAS_NODE:-false}\"${extra_props}
            }
        }" > /dev/null 2>&1 &) || true
}

safe_remove_path() {
    local target="$1"
    if [ -L "$target" ] || [ -f "$target" ]; then
        rm -f "$target"
    fi
}

write_executable_file() {
    local target="$1"
    local temp="${target}.tmp.$$"

    mkdir -p "$(dirname "$target")"
    safe_remove_path "$temp"
    cat > "$temp"
    chmod +x "$temp"
    mv -f "$temp" "$target"
}

install_binary_launcher() {
    local target_binary="$1"

    write_executable_file "$BIN_DIR/agent-relay" << WRAPPER
#!/usr/bin/env bash
exec "$target_binary" "\$@"
WRAPPER
}

install_node_launcher() {
    local target_dir="$1"

    write_executable_file "$BIN_DIR/agent-relay" << WRAPPER
#!/usr/bin/env bash
cd "$target_dir" && exec node dist/src/cli/index.js "\$@"
WRAPPER
}

prepend_bin_dir_to_path() {
    case ":${PATH:-}:" in
        *":$BIN_DIR:"*) ;;
        *) export PATH="$BIN_DIR${PATH:+:$PATH}" ;;
    esac
}

resolve_command_in_path() {
    local command_name="$1"
    local path_value="${2:-$PATH}"
    PATH="$path_value" command -v "$command_name" 2>/dev/null || true
}

record_standalone_failure() {
    local message="$1"
    STANDALONE_FAILURE_REASON="$message"
    warn "$message"
    # The rejected binary only ever existed as a temp file, so any previously
    # installed binary and launcher are still intact and are left alone.
}

# Detect OS and architecture
detect_platform() {
    OS="$(uname -s)"
    ARCH="$(uname -m)"

    case "$OS" in
        Linux*)  OS="linux" ;;
        Darwin*) OS="darwin" ;;
        *)       error "Unsupported OS: $OS" ;;
    esac

    case "$ARCH" in
        x86_64|amd64)  ARCH="x64" ;;
        arm64|aarch64) ARCH="arm64" ;;
        *)             error "Unsupported architecture: $ARCH" ;;
    esac

    PLATFORM="${OS}-${ARCH}"
    info "Detected platform: $PLATFORM"
}

# Get latest version from GitHub
get_latest_version() {
    if [ "$VERSION" = "latest" ]; then
        # Use GitHub token if available (avoids rate limiting)
        local auth_header=""
        if [ -n "${GITHUB_TOKEN:-}" ]; then
            auth_header="-H \"Authorization: token $GITHUB_TOKEN\""
        fi

        VERSION=$(eval curl -fsSL $auth_header "https://api.github.com/repos/$REPO_RELAY/releases/latest" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
        if [ -z "$VERSION" ]; then
            error "Failed to fetch latest version"
        fi
    fi
    # Remove tag prefix (e.g., "openclaw-v3.1.10" -> "3.1.10", "v3.1.10" -> "3.1.10")
    VERSION="${VERSION#openclaw-}"
    VERSION="${VERSION#v}"
    info "Installing version: $VERSION"
}

# Check if Node.js is available
check_node() {
    if command -v node &> /dev/null; then
        NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [ "$NODE_VERSION" -ge 22 ]; then
            HAS_NODE=true
            info "Node.js $(node -v) detected"
            return 0
        fi
    fi
    HAS_NODE=false
    return 1
}

# ---------------------------------------------------------------------------
# Atomic, verified binary installation
#
# Rules (see https://github.com/AgentWorkforce/relay/issues/1885):
#   * Never write to, sign or smoke-test a live destination path. Everything
#     happens on a temp file in the destination directory; the final step is an
#     atomic rename. A process running the old binary keeps its old inode.
#   * Compare the downloaded bytes with the SHA-256 GitHub publishes per asset.
#   * Re-hash after the rename and restore the previous binary on mismatch.
#   * Run the broker for real (`init`) before accepting it; `--help` alone
#     cannot see a damaged code page.
# ---------------------------------------------------------------------------

TEMP_FILES=""
SMOKE_PID=""
SMOKE_DIR=""
KEEP_PREV=0
DIGEST_VERIFIED=0   # set by verify_asset_digest when the last fetched asset matched its published digest
# One transaction covers the standalone CLI, the launcher and both broker
# copies. TXN_STATE lists the armed components ("cli", "broker"); the install
# commits with a SINGLE assignment (TXN_STATE=""), so an interrupt either rolls
# every component back or finds nothing to roll back, never a mixture.
TXN_STATE=""
TXN_SUFFIX=".prev.$$"   # run-unique backup suffix: a stale .prev from an older run is never mistaken for ours
BACKUP_SUFFIX=""        # empty = default ".prev"; the transactional installs set TXN_SUFFIX
BROKER_D1=""
BROKER_D2=""
BROKER_PRE1=0
BROKER_PRE2=0
CLI_PRE=0
LAUNCHER_PRE=0
LAUNCHER_BACKUP=""
RELEASE_JSON=""
RELEASE_JSON_STATE=""   # "", "ok" or "failed"

register_temp() {
    TEMP_FILES="${TEMP_FILES}${TEMP_FILES:+
}$1"
}

cleanup_temp_files() {
    local f
    if [ -n "$SMOKE_PID" ]; then
        kill -9 "$SMOKE_PID" 2>/dev/null || true
        SMOKE_PID=""
    fi
    if [ -n "$SMOKE_DIR" ]; then
        rm -rf "$SMOKE_DIR" 2>/dev/null
        SMOKE_DIR=""
    fi
    [ -n "$TEMP_FILES" ] || return 0
    while IFS= read -r f; do
        [ -n "$f" ] && rm -f "$f" 2>/dev/null
    done <<EOT
$TEMP_FILES
EOT
    TEMP_FILES=""
    return 0
}

# Create a temp file in DIR (same filesystem as the destination, so that a
# rename is atomic). The path is returned in MADE_TEMP, NOT on stdout: it must
# run in the caller's shell so that register_temp updates the TEMP_FILES that
# the EXIT/INT/TERM cleanup reads (a $(...) subshell would lose the entry).
MADE_TEMP=""
make_temp_file() {
    local dir="$1"
    local label="$2"
    MADE_TEMP=""
    MADE_TEMP=$(mktemp "$dir/.${label}.XXXXXX") || return 1
    register_temp "$MADE_TEMP"
}

# SHA-256 of a file (or of stdin when no file is given). Prints the lowercase
# hex digest; returns 1 when no hashing tool is available.
sha256_of() {
    local out=""
    if command -v shasum >/dev/null 2>&1; then
        out=$(shasum -a 256 "$@" 2>/dev/null) || return 1
    elif command -v sha256sum >/dev/null 2>&1; then
        out=$(sha256sum "$@" 2>/dev/null) || return 1
    elif command -v openssl >/dev/null 2>&1; then
        # Output looks like "SHA256(file)= <hex>" or "(stdin)= <hex>"
        out=$(openssl dgst -sha256 "$@" 2>/dev/null | awk '{print $NF}') || return 1
    else
        return 1
    fi
    out=$(printf '%s' "$out" | awk '{print tolower($1)}')
    [ -n "$out" ] || return 1
    printf '%s\n' "$out"
}

# Fetch (once) the release metadata for v$VERSION. Sets RELEASE_JSON and
# RELEASE_JSON_STATE in the current shell; never aborts the install.
load_release_metadata() {
    [ -z "$RELEASE_JSON_STATE" ] || return 0
    local url="https://api.github.com/repos/$REPO_RELAY/releases/tags/v${VERSION}"
    local json=""
    if [ -n "${GITHUB_TOKEN:-}" ]; then
        json=$(curl -fsSL -H "Authorization: token $GITHUB_TOKEN" "$url" 2>/dev/null) || json=""
    else
        json=$(curl -fsSL "$url" 2>/dev/null) || json=""
    fi
    if [ -n "$json" ]; then
        RELEASE_JSON="$json"
        RELEASE_JSON_STATE="ok"
    else
        RELEASE_JSON=""
        RELEASE_JSON_STATE="failed"
    fi
    return 0
}

# Structural parser (no jq): reads release JSON on stdin and prints the
# lowercase hex sha256 of asset $1. It walks the JSON character by character,
# tracks object/array depth and string state, and only looks at the DIRECT
# properties (name, digest) of each object in the top-level "assets" array, so
# nested objects (uploader, author, ...) with their own "name" keys, braces
# inside strings, and any key order are all handled.
parse_asset_digest_awk() {
    awk -v asset="$1" 'BEGIN { RS = "\001" }
    {
        s = $0; n = length(s)
        depth = 0; instr = 0; inassets = 0; ad = 0
        for (i = 1; i <= n; i++) {
            c = substr(s, i, 1)
            if (instr) {
                if (c == "\\") { i++; tok = tok substr(s, i, 1); continue }
                if (c == "\"") {
                    instr = 0
                    j = i + 1
                    while (j <= n && substr(s, j, 1) ~ /[ \t\r\n]/) j++
                    if (substr(s, j, 1) == ":") { key[depth] = tok; haskey[depth] = 1 }
                    else if (haskey[depth]) {
                        k = key[depth]
                        if (inassets && depth == ad + 1) {
                            if (k == "name") cname = tok
                            else if (k == "digest") cdig = tok
                        }
                        haskey[depth] = 0
                    }
                    tok = ""
                }
                else tok = tok c
                continue
            }
            if (c == "\"") { instr = 1; tok = ""; continue }
            if (c == "{" || c == "[") {
                if (c == "[" && depth == 1 && haskey[1] && key[1] == "assets") { inassets = 1; ad = depth + 1 }
                depth++
                haskey[depth] = 0
                if (inassets && depth == ad + 1) { cname = ""; cdig = "" }
                continue
            }
            if (c == "}" || c == "]") {
                if (inassets && c == "}" && depth == ad + 1 && cname == asset && cdig ~ /^sha256:[0-9a-fA-F]+$/) {
                    d = substr(cdig, 8); print tolower(d); exit
                }
                if (inassets && c == "]" && depth == ad) inassets = 0
                haskey[depth] = 0
                depth--
                haskey[depth] = 0
                continue
            }
            if (c ~ /[ \t\r\n,:]/) continue
            # bare literal (number, true, false, null): value of the current key
            haskey[depth] = 0
        }
    }'
}

parse_asset_digest_jq() {
    jq -r --arg n "$1" '[.assets[]? | select(.name == $n) | .digest // empty][0] // empty' 2>/dev/null \
        | sed -n 's/^sha256:\([0-9a-fA-F][0-9a-fA-F]*\)$/\1/p' | tr 'A-F' 'a-f'
}

# Print the published sha256 (lowercase hex) of release asset $1, or nothing if
# the release lists no digest for it. Uses jq when installed, otherwise the
# structural awk parser above (both are tested against the same fixtures).
fetch_asset_expected_sha256() {
    local asset="$1"
    load_release_metadata
    [ "$RELEASE_JSON_STATE" = "ok" ] || return 0
    if has_command jq; then
        printf '%s' "$RELEASE_JSON" | parse_asset_digest_jq "$asset"
    else
        printf '%s' "$RELEASE_JSON" | parse_asset_digest_awk "$asset"
    fi
}

# Compare file $2 with the digest the release publishes for asset $1.
# 0 = verified, 1 = MISMATCH (reject), 2 = could not verify (warned, continue).
verify_asset_digest() {
    local asset="$1"
    local file="$2"
    local expected actual

    load_release_metadata
    expected=$(fetch_asset_expected_sha256 "$asset")
    if [ -z "$expected" ]; then
        if [ "$RELEASE_JSON_STATE" = "failed" ]; then
            warn "Could not fetch release metadata from the GitHub API (rate limit or network); cannot verify the SHA-256 of $asset. Continuing with the smoke test only."
        else
            warn "Release v${VERSION} publishes no SHA-256 digest for $asset; cannot verify its integrity. Continuing with the smoke test only."
        fi
        return 2
    fi
    if ! actual=$(sha256_of "$file"); then
        warn "No SHA-256 tool found (shasum, sha256sum or openssl); cannot verify $asset. Continuing with the smoke test only."
        return 2
    fi
    if [ "$actual" != "$expected" ]; then
        warn "SHA-256 mismatch for $asset: expected $expected, got $actual. Refusing to install it."
        return 1
    fi
    info "Verified SHA-256 of $asset ($expected)"
    DIGEST_VERIFIED=1
    return 0
}

# Download release asset $1 into a fresh temp file in directory $2. $3 is "raw"
# or "gz" (gunzip into a second temp file). On success FETCHED_TMP holds a
# digest-verified, not yet signed file. Returns 0 on success, 1 when the asset
# is unavailable or undecodable, 2 on an integrity failure.
fetch_release_asset() {
    local asset="$1"
    local dir="$2"
    local mode="${3:-raw}"
    local url="https://github.com/$REPO_RELAY/releases/download/v${VERSION}/${asset}"
    local dl out rc

    FETCHED_TMP=""
    DIGEST_VERIFIED=0
    make_temp_file "$dir" "download" || return 1
    dl="$MADE_TEMP"
    if ! curl -fsSL "$url" -o "$dl" 2>/dev/null; then
        rm -f "$dl"
        return 1
    fi

    if [ "$mode" = "gz" ]; then
        # Reject error pages that are not gzip data
        if ! head -c 2 "$dl" 2>/dev/null | od -An -tx1 | tr -d ' \n' | grep -q "^1f8b"; then
            rm -f "$dl"
            return 1
        fi
    fi

    rc=0
    verify_asset_digest "$asset" "$dl" || rc=$?
    if [ "$rc" -eq 1 ]; then
        rm -f "$dl"
        return 2
    fi

    if [ "$mode" = "gz" ]; then
        local h_file h_stream
        make_temp_file "$dir" "decoded" || { rm -f "$dl"; return 1; }
        out="$MADE_TEMP"
        if ! gunzip -c "$dl" > "$out" 2>/dev/null; then
            rm -f "$dl" "$out"
            return 1
        fi
        # The bytes on disk must equal a clean second decode of the same archive.
        h_file=$(sha256_of "$out" || true)
        h_stream=$(gunzip -c "$dl" 2>/dev/null | sha256_of || true)
        rm -f "$dl"
        if [ -n "$h_file" ] && [ "$h_file" != "$h_stream" ]; then
            warn "Decompressed $asset differs from a clean decode; refusing to install it."
            rm -f "$out"
            return 2
        fi
        dl="$out"
    fi

    FETCHED_TMP="$dl"
    return 0
}

# Run the broker for real: `init` in a throwaway state dir and temp HOME with a
# scrubbed environment (no RELAY_*/AGENT_RELAY_* credentials). It must still be
# alive after a few seconds (or exit 0). Any crash or signal rejects it.
smoke_test_broker() {
    # stderr is silenced so bash does not print "Terminated"/"Illegal
    # instruction" job notices for the process we deliberately run and kill;
    # the outcome is reported through info/warn (stdout).
    # Resolve the duration here, outside the silenced call, so an invalid
    # AGENT_RELAY_SMOKE_SECONDS warning (stderr) is actually shown.
    local seconds
    seconds=$(resolve_smoke_seconds)
    smoke_test_broker_run "$1" "$seconds" 2>/dev/null
}

# AGENT_RELAY_SMOKE_SECONDS must be a positive integer; anything else (0,
# negative, non-numeric, empty) would skip the wait and let a crashing broker
# pass vacuously, so it falls back to the default with a warning. Clamped to 60.
resolve_smoke_seconds() {
    local v="${AGENT_RELAY_SMOKE_SECONDS-}"
    if [ -z "$v" ]; then
        echo 4
        return 0
    fi
    case "$v" in
        *[!0-9]*|0|00*)
            warn "Ignoring invalid AGENT_RELAY_SMOKE_SECONDS='$v' (need a positive integer); using 4" >&2
            echo 4
            ;;
        *)
            if [ "${#v}" -gt 2 ] || [ "$v" -gt 60 ]; then
                warn "AGENT_RELAY_SMOKE_SECONDS='$v' is too large; using 60" >&2
                echo 60
            else
                echo "$v"
            fi
            ;;
    esac
}

smoke_test_broker_run() {
    local bin="$1"
    local seconds="$2"
    local tmp pid rc=0 i=0 alive=1

    tmp=$(mktemp -d "${TMPDIR:-/tmp}/agent-relay-smoke.XXXXXX") || {
        warn "smoke test: could not create a temp dir"
        return 1
    }
    SMOKE_DIR="$tmp"
    mkdir -p "$tmp/home" "$tmp/state"

    # Telemetry: the damaged page from #1885 was reachable from the telemetry
    # path, so the smoke test must not opt out on the user's behalf; it only
    # forwards an opt-out the user already made.
    local optout_a="" optout_b=""
    if ! telemetry_enabled; then
        optout_a="AGENT_RELAY_TELEMETRY_DISABLED=1"
        optout_b="DO_NOT_TRACK=1"
    fi

    # Run the real fleet-style startup (instance + channels + API port), not
    # --local-only: --local-only skips code that the damaged build crashed in.
    # The environment is scrubbed (env -i: no RELAY_*/AGENT_RELAY_* credentials)
    # and RELAY_BASE_URL points at a closed local port, so the throwaway broker
    # cannot create or join any workspace. A clean "failed to initialize
    # relaycast session" exit is therefore the expected outcome for a healthy
    # binary; a crash (signal) is not.
    (
        cd "$tmp" || exit 126
        exec env -i HOME="$tmp/home" PATH="/usr/bin:/bin" TMPDIR="$tmp" \
            RELAY_BASE_URL="http://127.0.0.1:9" \
            ${optout_a:+"$optout_a"} ${optout_b:+"$optout_b"} \
            "$bin" init --instance-name "smoke-$$" --channels general --api-port 0 \
            --state-dir "$tmp/state" \
            < /dev/null > "$tmp/out.log" 2>&1
    ) &
    pid=$!
    SMOKE_PID="$pid"

    while [ "$i" -lt "$seconds" ]; do
        sleep 1
        i=$((i + 1))
        if ! kill -0 "$pid" 2>/dev/null; then
            alive=0
            break
        fi
    done

    # Accepted-state rule: a broker that is still running after the window, or
    # exits 0, or stops with the expected clean relaycast error, passes; a signal
    # or any other failure rejects. The damaged build from #1885 died with
    # SIGILL (132) within about a second in every run, well inside the window,
    # and the digest / signature checks run before this, so a late crash or a
    # stall is the residual risk this short check cannot cover.
    if [ "$alive" -eq 1 ]; then
        kill "$pid" 2>/dev/null || true
        i=0
        while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 5 ]; do
            sleep 1
            i=$((i + 1))
        done
        kill -9 "$pid" 2>/dev/null || true
        { wait "$pid"; } 2>/dev/null || true
        SMOKE_PID=""
        rm -rf "$tmp"
        info "Broker smoke test passed (init stayed up ${seconds}s)"
        return 0
    fi

    { wait "$pid"; } 2>/dev/null || rc=$?
    SMOKE_PID=""
    if [ "$rc" -eq 0 ]; then
        rm -rf "$tmp"
        info "Broker smoke test passed (init exited 0)"
        return 0
    fi
    if [ "$rc" -lt 128 ] && grep -q "failed to initialize relaycast session" "$tmp/out.log" 2>/dev/null; then
        rm -rf "$tmp"
        info "Broker smoke test passed (init ran and stopped cleanly at the unreachable workspace service)"
        return 0
    fi

    local detail=""
    if [ "$rc" -gt 128 ]; then
        detail=" (signal $((rc - 128)))"
    fi
    warn "Broker smoke test FAILED: init exited with status $rc${detail}"
    tail -n 5 "$tmp/out.log" 2>/dev/null | sed 's/^/    /' || true
    rm -rf "$tmp"
    return 1
}

# Checks used with install_binary_atomic.
check_broker_binary() {
    "$1" --help >/dev/null 2>&1 || { warn "broker binary failed --help"; return 1; }
    smoke_test_broker "$1"
}

check_cli_binary() {
    local log
    log=$(mktemp "${TMPDIR:-/tmp}/agent-relay-verify.XXXXXX") || return 1
    if "$1" --version >"$log" 2>&1; then
        rm -f "$log"
        return 0
    fi
    CLI_CHECK_OUTPUT=$(head -n 1 "$log" 2>/dev/null || true)
    rm -f "$log"
    return 1
}

check_help_binary() {
    "$1" --help >/dev/null 2>&1
}

# Install prepared temp file $1 (in the destination directory) as $2.
#   $3  check function run on the TEMP file (default: none)
#   $4  "sign" (default) to strip quarantine / sign the temp file, "nosign" when
#       the file was already signed and verified (a plain copy)
# The destination is only touched by one atomic `mv -f`. The previous binary is
# kept as "$2.prev" until the installed bytes are re-hashed and match; on any
# failure it is restored and 1 is returned. The temp file is always consumed.
install_binary_atomic() {
    local tmp="$1"
    local dest="$2"
    local check_fn="${3:-true}"
    local sign="${4:-sign}"
    local prev="${dest}${BACKUP_SUFFIX:-.prev}"
    local had_prev=0 signed_hash installed_hash


    chmod +x "$tmp" || { rm -f "$tmp"; return 1; }
    if [ "$sign" = "sign" ] && ! prepare_downloaded_binary "$tmp"; then
        rm -f "$tmp"
        return 1
    fi

    if ! "$check_fn" "$tmp"; then
        warn "Verification of the new binary failed; $dest left untouched"
        rm -f "$tmp"
        return 1
    fi

    if ! signed_hash=$(sha256_of "$tmp"); then
        signed_hash=""
        warn "No SHA-256 tool found; skipping the post-install read-back check for $dest"
    fi

    local rotated=0
    if [ -e "$dest" ] || [ -L "$dest" ]; then
        # An existing backup (e.g. from an interrupted earlier upgrade) is only
        # touched now that the new binary is verified and about to be committed,
        # and it is rotated to .prev.1 rather than deleted.
        if [ -e "$prev" ] || [ -L "$prev" ]; then
            mv -f "$prev" "${prev}.1" && rotated=1
        fi
        if [ -L "$dest" ]; then
            cp -pP "$dest" "$prev" 2>/dev/null && had_prev=1
        else
            { ln "$dest" "$prev" 2>/dev/null || cp -p "$dest" "$prev" 2>/dev/null; } && had_prev=1
        fi
        if [ "$had_prev" -ne 1 ]; then
            warn "Could not keep a backup of $dest; leaving it untouched"
            [ "$rotated" -eq 1 ] && mv -f "${prev}.1" "$prev"
            rm -f "$tmp"
            return 1
        fi
    fi

    if ! mv -f "$tmp" "$dest"; then
        warn "Could not move the new binary into place at $dest"
        rm -f "$tmp"
        if [ "$had_prev" -eq 1 ]; then
            rm -f "$prev"
            [ "$rotated" -eq 1 ] && mv -f "${prev}.1" "$prev"
        fi
        return 1
    fi

    if [ -n "$signed_hash" ]; then
        installed_hash=$(sha256_of "$dest" || true)
        if [ "$installed_hash" != "$signed_hash" ]; then
            warn "Installed $dest does not match the verified file (expected $signed_hash, got ${installed_hash:-unreadable}); restoring the previous binary"
            if [ "$had_prev" -eq 1 ]; then
                mv -f "$prev" "$dest"
                [ "$rotated" -eq 1 ] && mv -f "${prev}.1" "$prev"
            else
                rm -f "$dest"
            fi
            return 1
        fi
    fi

    # KEEP_PREV=1 lets a caller (the transactional install) roll back later if a
    # dependent step fails; the caller then owns removing the backup.
    if [ "$had_prev" -eq 1 ] && [ "${KEEP_PREV:-0}" != "1" ]; then
        rm -f "$prev"
    fi
    return 0
}

# Copy an already verified+signed binary $1 to $2 through the same atomic path.
copy_binary_atomic() {
    local src="$1"
    local dest="$2"
    local tmp src_hash tmp_hash

    make_temp_file "$(dirname "$dest")" "copy" || return 1
    tmp="$MADE_TEMP"
    if ! cp "$src" "$tmp"; then
        rm -f "$tmp"
        return 1
    fi
    src_hash=$(sha256_of "$src" || true)
    tmp_hash=$(sha256_of "$tmp" || true)
    if [ "$src_hash" != "$tmp_hash" ]; then
        warn "Copy of $src to $dest is corrupt; not installing it"
        rm -f "$tmp"
        return 1
    fi
    install_binary_atomic "$tmp" "$dest" true nosign
}

# Download broker binary (Rust broker for workflow/SDK agent spawning)
# Returns 0 on success, 1 when no binary is available for this platform, and 2
# when a binary was downloaded but REJECTED (integrity or smoke test failure);
# the existing broker is left untouched in both failure cases.
download_broker_binary() {
    step "Downloading broker binary..."

    local binary_name="agent-relay-broker-${PLATFORM}"
    local target_path="$INSTALL_DIR/bin/agent-relay-broker"
    local rc=0

    mkdir -p "$INSTALL_DIR/bin"
    mkdir -p "$BIN_DIR"

    fetch_release_asset "$binary_name" "$INSTALL_DIR/bin" raw || rc=$?
    if [ "$rc" -eq 1 ]; then
        warn "No prebuilt broker binary for $PLATFORM"
        return 1
    elif [ "$rc" -ne 0 ]; then
        warn "broker binary failed integrity verification"
        return 2
    fi

    # Two destinations (INSTALL_DIR and BIN_DIR) commit together as part of the
    # install transaction: both keep a run-unique backup until the whole install
    # commits, and undo_brokers() restores BOTH (idempotently) on failure or
    # interrupt. The transaction is armed before any destination is touched.
    local d1="$target_path"
    local d2="$BIN_DIR/agent-relay-broker"
    BROKER_D1="$d1"; BROKER_D2="$d2"
    BROKER_PRE1=0; BROKER_PRE2=0
    if [ -e "$d1" ] || [ -L "$d1" ]; then BROKER_PRE1=1; fi
    if [ -e "$d2" ] || [ -L "$d2" ]; then BROKER_PRE2=1; fi
    local saved_keep="$KEEP_PREV" saved_suffix="$BACKUP_SUFFIX"
    TXN_STATE="${TXN_STATE:+$TXN_STATE }broker"
    KEEP_PREV=1
    BACKUP_SUFFIX="$TXN_SUFFIX"
    if install_binary_atomic "$FETCHED_TMP" "$d1" check_broker_binary \
        && copy_binary_atomic "$d1" "$d2"; then
        KEEP_PREV="$saved_keep"; BACKUP_SUFFIX="$saved_suffix"
        if [ "$TXN_STATE" = "broker" ]; then
            # standalone-less (npm) install: this is the whole transaction
            TXN_STATE=""
            cleanup_broker_backups
        fi
        success "Downloaded broker binary (workflow agent spawning)"
        return 0
    fi
    KEEP_PREV="$saved_keep"; BACKUP_SUFFIX="$saved_suffix"
    warn "Could not install the verified broker into both $INSTALL_DIR/bin and $BIN_DIR; restoring the previous broker"
    undo_brokers
    if [ "$TXN_STATE" = "broker" ]; then TXN_STATE=""; else TXN_STATE="${TXN_STATE% broker}"; fi
    warn "broker binary failed verification"
    return 2
}

# The standalone CLI and the broker must be the same version. If the broker was
# rejected after the CLI was replaced, undo the CLI step (transactional
# install) and fail loudly instead of leaving a CLI/broker version skew.
abort_standalone_install() {
    local broker="$INSTALL_DIR/bin/agent-relay-broker"
    local old_broker="none installed"

    if [ -x "$broker" ]; then
        old_broker="$( { "$broker" --version 2>/dev/null || true; } | head -n 1)"
        [ -n "$old_broker" ] || old_broker="unknown version"
    fi
    undo_brokers
    undo_cli
    TXN_STATE=""
    error "The v${VERSION} broker was rejected (integrity or smoke test failed), so the v${VERSION} CLI was NOT kept: ${ROLLBACK_OUTCOME}. The existing broker (${old_broker}) is untouched. Nothing was upgraded; re-run the installer, or set AGENT_RELAY_VERSION to a known-good version."
}

# Idempotent undo of one destination: put this run's backup back; a destination
# that did not exist before is removed; otherwise leave it alone.
undo_destination() { # undo_destination <dest> <existed-before: 0|1>
    local dest="$1" pre="$2" backup="$1${TXN_SUFFIX}"
    if [ -e "$backup" ] || [ -L "$backup" ]; then
        mv -f "$backup" "$dest"
    elif [ "$pre" -eq 0 ]; then
        rm -f "$dest"
    fi
}

undo_brokers() {
    [ -n "$BROKER_D1" ] || return 0
    undo_destination "$BROKER_D1" "$BROKER_PRE1"
    undo_destination "$BROKER_D2" "$BROKER_PRE2"
}

cleanup_broker_backups() {
    [ -n "$BROKER_D1" ] || return 0
    rm -f "${BROKER_D1}${TXN_SUFFIX}" "${BROKER_D2}${TXN_SUFFIX}"
}

# Undo the standalone CLI install: restore (or remove) the CLI binary and the
# launcher independently. Sets ROLLBACK_OUTCOME.
ROLLBACK_OUTCOME=""
undo_cli() {
    local cli="$INSTALL_DIR/bin/agent-relay"
    local launcher="$BIN_DIR/agent-relay"
    undo_destination "$cli" "$CLI_PRE"
    if [ "$CLI_PRE" -eq 1 ]; then
        ROLLBACK_OUTCOME="the previous CLI ($( { "$cli" --version 2>/dev/null || true; } | head -n 1)) was restored"
    else
        ROLLBACK_OUTCOME="the new CLI was removed (there was no previous install)"
    fi
    # A launcher from an earlier npm/source install must survive byte-identical.
    if [ -n "$LAUNCHER_BACKUP" ] && [ -e "$LAUNCHER_BACKUP" ]; then
        mv -f "$LAUNCHER_BACKUP" "$launcher"
        LAUNCHER_BACKUP=""
        ROLLBACK_OUTCOME="${ROLLBACK_OUTCOME}; the existing $launcher launcher was restored"
    elif [ "$LAUNCHER_PRE" -eq 0 ]; then
        rm -f "$launcher"
    fi
}

# INT/TERM/HUP: undo whatever is armed, then clean up and exit. TXN_STATE is
# read once, so a commit (TXN_STATE="") either happened before this point
# (nothing is rolled back) or did not (everything is).
handle_signal() {
    trap '' INT TERM HUP
    local code="$1"
    local st="$TXN_STATE"
    TXN_STATE=""
    case " $st " in *" broker "*) undo_brokers ;; esac
    case " $st " in
        *" cli "*)
            undo_cli
            warn "Interrupted: ${ROLLBACK_OUTCOME}."
            ;;
    esac
    cleanup_temp_files
    trap - EXIT
    exit "$code"
}

# Check if a command exists
has_command() {
    command -v "$1" &> /dev/null
}

# Prepare a downloaded temp binary (never a live path). On macOS this removes
# the quarantine flag and checks the code signature:
#   * The published binaries ship an ad-hoc signature whose page hashes cover
#     every page, so `codesign --verify --strict` is an OFFLINE integrity check
#     (a zero-filled page fails it). A damaged download is rejected (return 1).
#   * A valid shipped signature is kept as is, so the installed bytes equal the
#     published bytes. Re-signing is only done for a binary that ships unsigned
#     (Apple Silicon refuses to run unsigned code). Re-signing a damaged file is
#     exactly what hid the corruption in #1885, so it is never done blindly.
prepare_downloaded_binary() {
    local f="$1"
    [ "$OS" = "darwin" ] || return 0
    if has_command xattr; then
        xattr -d com.apple.quarantine "$f" 2>/dev/null || true
    fi
    if ! has_command codesign; then
        # Without codesign neither verification nor a required signature is
        # possible. Only a verified published digest can vouch for the bytes.
        if [ "$DIGEST_VERIFIED" = "1" ]; then
            warn "codesign not found: cannot verify or apply a code signature. Continuing because the download matched its published SHA-256."
            return 0
        fi
        warn "codesign not found and no published SHA-256 was verified: cannot establish the integrity of the downloaded binary. Refusing to install it."
        return 1
    fi
    local out
    if out=$(codesign --verify --strict "$f" 2>&1); then
        return 0
    fi
    case "$out" in
        *"not signed at all"*)
            if codesign --force --sign - "$f" >/dev/null 2>&1; then
                return 0
            fi
            warn "Could not apply an ad-hoc code signature to the downloaded binary; Apple Silicon will not run it unsigned. Refusing to install it."
            return 1
            ;;
    esac
    warn "Code signature check failed for the downloaded binary (${out}); it is damaged or modified. Refusing to install it."
    return 1
}

# Download relay-acp binary for Zed editor integration
download_relay_acp() {
    step "Downloading relay-acp binary (Zed editor integration)..."

    local binary_name="relay-acp-${PLATFORM}"
    local target_path="$BIN_DIR/relay-acp"
    local file_size

    mkdir -p "$BIN_DIR"

    # Try compressed binary first
    if has_command gunzip; then
        if fetch_release_asset "${binary_name}.gz" "$BIN_DIR" gz; then
            if install_binary_atomic "$FETCHED_TMP" "$target_path" check_help_binary; then
                success "Downloaded relay-acp binary (Zed ACP bridge)"
                return 0
            fi
            warn "relay-acp binary failed verification, trying uncompressed..."
        fi
    fi

    # Fall back to uncompressed binary
    if fetch_release_asset "$binary_name" "$BIN_DIR" raw; then
        file_size=$(stat -f%z "$FETCHED_TMP" 2>/dev/null || stat -c%s "$FETCHED_TMP" 2>/dev/null || echo "0")
        if [ "$file_size" -gt 1000000 ]; then
            if install_binary_atomic "$FETCHED_TMP" "$target_path" check_help_binary; then
                success "Downloaded relay-acp binary (Zed ACP bridge)"
                return 0
            fi
        else
            rm -f "$FETCHED_TMP"
        fi
    fi

    info "No relay-acp binary available for $PLATFORM"
    return 1
}

# Install ACP bridge for Zed editor integration (fallback to npm if binary not available)
install_acp_bridge() {
    # Try binary first
    if download_relay_acp; then
        return 0
    fi

    # Fall back to npm if Node.js is available
    if check_node; then
        info "Installing ACP bridge via npm..."
        if npm install -g @agent-relay/acp-bridge@"$VERSION" 2>/dev/null || npm install -g @agent-relay/acp-bridge 2>/dev/null; then
            success "Installed relay-acp via npm (Zed ACP bridge)"
            return 0
        fi
    fi

    warn "relay-acp not available (Zed editor integration won't work)"
    return 1
}

# Download with progress indicator
download_with_progress() {
    local url="$1"
    local output="$2"

    if [ -t 1 ]; then
        # TTY available - show progress bar
        curl -fSL --progress-bar "$url" -o "$output"
    else
        # No TTY - silent download
        curl -fsSL "$url" -o "$output"
    fi
}

# Download standalone agent-relay binary (no Node.js required)
download_standalone_binary() {
    step "Checking for standalone binary..."

    local binary_name="agent-relay-${PLATFORM}"
    local target_path="$INSTALL_DIR/bin/agent-relay"
    local file_size verify_output

    mkdir -p "$INSTALL_DIR/bin"
    mkdir -p "$BIN_DIR"

    # Try compressed binary first (faster download, ~60-70% smaller)
    # Only if gunzip is available
    if has_command gunzip; then
        if fetch_release_asset "${binary_name}.gz" "$INSTALL_DIR/bin" gz; then
            CLI_CHECK_OUTPUT=""
            if install_binary_atomic "$FETCHED_TMP" "$target_path" check_cli_binary; then
                install_binary_launcher "$target_path"
                prepend_bin_dir_to_path
                success "Downloaded standalone agent-relay binary"
                return 0
            fi
            verify_output="$CLI_CHECK_OUTPUT"
            record_standalone_failure "Standalone binary verification failed for $target_path${verify_output:+: $verify_output}. Trying uncompressed binary..."
        else
            info "Compressed binary not available, trying uncompressed..."
        fi
    else
        info "gunzip not available, trying uncompressed binary..."
    fi

    # Fall back to uncompressed binary
    info "Downloading standalone binary..."

    if fetch_release_asset "$binary_name" "$INSTALL_DIR/bin" raw; then
        # Check file size - error pages are typically small (<1MB)
        file_size=$(stat -f%z "$FETCHED_TMP" 2>/dev/null || stat -c%s "$FETCHED_TMP" 2>/dev/null || echo "0")

        if [ "$file_size" -gt 1000000 ]; then
            CLI_CHECK_OUTPUT=""
            if install_binary_atomic "$FETCHED_TMP" "$target_path" check_cli_binary; then
                install_binary_launcher "$target_path"
                prepend_bin_dir_to_path
                success "Downloaded standalone agent-relay binary (no Node.js required!)"
                return 0
            fi
            verify_output="$CLI_CHECK_OUTPUT"
            record_standalone_failure "Standalone binary verification failed for $target_path${verify_output:+: $verify_output}"
        else
            info "Uncompressed binary not available (file too small: ${file_size} bytes)"
            rm -f "$FETCHED_TMP"
        fi
    fi

    info "No standalone binary available for $PLATFORM, falling back to npm"
    return 1
}

# Install via npm (fallback or primary method)
install_via_npm() {
    step "Installing via npm..."

    if ! check_node; then
        error "Node.js 22+ is required for npm installation. Please install Node.js first:

  macOS:   brew install node
  Linux:   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs

Or use nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash"
    fi

    # Install agent-relay globally
    info "Installing agent-relay..."

    # Try installation - capture output and exit code separately
    local npm_log="/tmp/npm-install-$$.log"
    local npm_exit=0

    # npm registry metadata propagates before the tarball CDN does, so a
    # freshly-published version may 404 for a short window.  Retry a few
    # times with backoff before falling through to the unversioned install.
    local max_attempts=6
    local attempt=1
    while [ $attempt -le $max_attempts ]; do
        npm_exit=0
        npm install -g agent-relay@"$VERSION" > "$npm_log" 2>&1 || npm_exit=$?
        if [ $npm_exit -eq 0 ]; then
            break
        fi
        if grep -q "E404" "$npm_log" 2>/dev/null && [ $attempt -lt $max_attempts ]; then
            info "Package not yet available on npm CDN, retrying in 10s... (attempt $attempt/$max_attempts)"
            sleep 10
            attempt=$((attempt + 1))
        else
            break
        fi
    done

    if [ $npm_exit -ne 0 ]; then
        # Versioned install failed, try without version (latest)
        npm install -g agent-relay >> "$npm_log" 2>&1 || npm_exit=$?
    fi

    if [ $npm_exit -ne 0 ]; then
        # Show the error output
        cat "$npm_log"

        # Check if it's a native module compilation failure
        if grep -q "Unable to detect compiler type\|node-gyp\|prebuild-install\|gyp ERR" "$npm_log" 2>/dev/null; then
            warn "Native module compilation failed. This is usually due to missing build tools."
            echo ""
            echo "Please install build tools and try again:"
            echo ""
            if [ "$OS" = "darwin" ]; then
                echo "  xcode-select --install"
            elif command -v apt-get &> /dev/null; then
                echo "  sudo apt-get install build-essential python3"
            elif command -v dnf &> /dev/null; then
                echo "  sudo dnf install gcc gcc-c++ make python3"
            elif command -v apk &> /dev/null; then
                echo "  apk add build-base python3"
            else
                echo "  Install gcc, g++, make, and python3"
            fi
            echo ""
            echo "Retrying installation with optional native modules disabled..."
            if npm install -g --ignore-scripts agent-relay@"$VERSION" 2>/dev/null || npm install -g --ignore-scripts agent-relay 2>/dev/null; then
                warn "Installed with native module compilation skipped"
                rm -f "$npm_log"
            else
                rm -f "$npm_log"
                error "Installation failed. Please install build tools and try again."
            fi
        else
            rm -f "$npm_log"
            error "npm installation failed. Please check the error messages above."
        fi
    else
        rm -f "$npm_log"
    fi

    local npm_agent_relay=""
    local npm_prefix=""
    npm_prefix=$(npm prefix -g 2>/dev/null || true)
    if [ -n "$npm_prefix" ] && [ -x "$npm_prefix/bin/agent-relay" ] && [ "$npm_prefix/bin/agent-relay" != "$BIN_DIR/agent-relay" ]; then
        npm_agent_relay="$npm_prefix/bin/agent-relay"
    else
        npm_agent_relay=$(resolve_command_in_path agent-relay "$ORIGINAL_PATH")
    fi
    if [ -n "$npm_agent_relay" ] && [ "$npm_agent_relay" != "$BIN_DIR/agent-relay" ]; then
        install_binary_launcher "$npm_agent_relay"
        prepend_bin_dir_to_path
    fi

    # Install ACP bridge for Zed editor integration
    install_acp_bridge || true

    # Download broker binary for workflow/SDK agent spawning. A rejected broker
    # (rc 2) must not look like success: the npm CLI is already installed.
    local broker_rc=0
    download_broker_binary || broker_rc=$?
    if [ "$broker_rc" -eq 2 ]; then
        error "The v${VERSION} broker was rejected (integrity or smoke test failed) after the CLI was installed via npm; the existing broker was left untouched, so CLI and broker versions now differ. Re-run the installer, or install a known-good version with AGENT_RELAY_VERSION."
    fi

    success "Installed via npm"
}

# Install from source (for development or when npm fails)
install_from_source() {
    step "Installing from source..."

    if ! check_node; then
        error "Node.js 22+ is required for source installation"
    fi

    mkdir -p "$INSTALL_DIR"

    if command -v git &> /dev/null; then
        if [ -d "$INSTALL_DIR/.git" ]; then
            info "Updating existing installation..."
            cd "$INSTALL_DIR" && git fetch && git checkout "v$VERSION" 2>/dev/null || git pull
        else
            info "Cloning repository..."
            rm -rf "$INSTALL_DIR"
            git clone --depth 1 --branch "v$VERSION" "https://github.com/$REPO_RELAY.git" "$INSTALL_DIR" 2>/dev/null || \
            git clone --depth 1 "https://github.com/$REPO_RELAY.git" "$INSTALL_DIR"
        fi
    else
        info "Downloading source tarball..."
        curl -fsSL "https://github.com/$REPO_RELAY/archive/v$VERSION.tar.gz" -o /tmp/relay.tar.gz 2>/dev/null || \
        curl -fsSL "https://github.com/$REPO_RELAY/archive/main.tar.gz" -o /tmp/relay.tar.gz
        rm -rf "$INSTALL_DIR"
        mkdir -p "$INSTALL_DIR"
        tar -xzf /tmp/relay.tar.gz -C "$INSTALL_DIR" --strip-components=1
        rm /tmp/relay.tar.gz
    fi

    cd "$INSTALL_DIR"

    # Install dependencies and build
    info "Installing dependencies..."
    if command -v pnpm &> /dev/null; then
        pnpm install --frozen-lockfile 2>/dev/null || pnpm install
    else
        npm ci 2>/dev/null || npm install
    fi

    info "Building..."
    npm run build

    # Create wrapper script
    install_node_launcher "$INSTALL_DIR"
    prepend_bin_dir_to_path

    success "Installed from source"
}

# Setup PATH
setup_path() {
    local path_value="${1:-$PATH}"

    if [[ ":$path_value:" != *":$BIN_DIR:"* ]]; then
        warn "Add to your PATH by running:"
        echo ""
        echo "  export PATH=\"$BIN_DIR:\$PATH\""
        echo ""
        echo "  # Or add to your shell profile:"
        echo "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.bashrc  # for bash"
        echo "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc   # for zsh"
        echo ""
    fi
}

# Verify installation
verify_installation() {
    step "Verifying installation..."

    prepend_bin_dir_to_path

    local installed_path="$BIN_DIR/agent-relay"
    local installed_version=""
    local original_path_command=""

    if [ -x "$installed_path" ] && installed_version=$("$installed_path" --version 2>/dev/null); then
        success "agent-relay $installed_version installed successfully at $installed_path"

        original_path_command=$(resolve_command_in_path agent-relay "$ORIGINAL_PATH")
        if [ -n "$original_path_command" ] && [ "$original_path_command" != "$installed_path" ]; then
            local original_version
            original_version=$("$original_path_command" --version 2>/dev/null || echo "unknown")
            warn "Another agent-relay ($original_version) at $original_path_command shadows the newly installed $installed_version at $installed_path"
            echo "  Run this in your current shell:"
            echo "    export PATH=\"$BIN_DIR:\$PATH\""
            echo "  Then add the same line to ~/.zshrc or ~/.bashrc so the new launcher wins."
        elif [[ ":$ORIGINAL_PATH:" != *":$BIN_DIR:"* ]]; then
            setup_path "$ORIGINAL_PATH"
        fi
        return 0
    fi

    if command -v agent-relay &> /dev/null; then
        installed_version=$(agent-relay --version 2>/dev/null || echo "unknown")
        success "agent-relay $installed_version installed successfully!"
        return 0
    fi

    error "Installation verification failed. Expected a working launcher at $installed_path"
}

# Print usage instructions
print_usage() {
    echo ""
    echo -e "${BOLD}Quick Start:${NC}"
    echo ""
    echo "  # Start the local broker (detached so this terminal stays free)"
    echo "  agent-relay up --background"
    echo ""
    echo "  # Check status"
    echo "  agent-relay status"
    echo ""
    echo "  # Stop the broker"
    echo "  agent-relay down"
    echo ""
    echo -e "${BOLD}Documentation:${NC} https://github.com/AgentWorkforce/relay"
    echo ""
}

# Main installation flow
main() {
    echo ""
    echo -e "${YELLOW}${BOLD}⚡ Agent Relay${NC} Installer"
    echo ""

    # Remove any leftover temp files on exit
    trap cleanup_temp_files EXIT
    trap 'handle_signal 130' INT
    trap 'handle_signal 143' TERM HUP

    # Initialize telemetry
    generate_install_id

    detect_platform
    get_latest_version

    # Track install started
    track_event "install_started"

    # Try installation methods in order of preference:
    # 1. Standalone binary (no dependencies required!)
    # 2. npm (if Node.js available)
    # 3. source (fallback)

    # Try standalone binary first - works without Node.js
    # Back up an existing launcher first: the standalone step overwrites it and
    # a later broker rejection must be able to put it back unchanged.
    LAUNCHER_BACKUP=""
    LAUNCHER_PRE=0
    local skip_standalone=0
    if [ -e "$BIN_DIR/agent-relay" ] || [ -L "$BIN_DIR/agent-relay" ]; then
        LAUNCHER_PRE=1
        mkdir -p "$BIN_DIR"
        if make_temp_file "$BIN_DIR" "launcher"; then
            if cp -pP "$BIN_DIR/agent-relay" "$MADE_TEMP" 2>/dev/null; then
                LAUNCHER_BACKUP="$MADE_TEMP"
            else
                rm -f "$MADE_TEMP"
            fi
        fi
        if [ -z "$LAUNCHER_BACKUP" ]; then
            # Without a backup a rollback could not restore the existing launcher,
            # so do not replace it: skip the standalone install.
            skip_standalone=1
            warn "Could not back up the existing $BIN_DIR/agent-relay launcher (disk full or permissions?); not replacing it, skipping the standalone install."
        fi
    fi
    CLI_PRE=0
    if [ -e "$INSTALL_DIR/bin/agent-relay" ] || [ -L "$INSTALL_DIR/bin/agent-relay" ]; then CLI_PRE=1; fi
    # Arm the transaction BEFORE the CLI is touched; every undo step is idempotent.
    TXN_STATE="cli"
    KEEP_PREV=1
    BACKUP_SUFFIX="$TXN_SUFFIX"
    local standalone_ok=0
    if [ "$skip_standalone" -eq 0 ]; then
        download_standalone_binary && standalone_ok=1
    fi
    KEEP_PREV=0
    BACKUP_SUFFIX=""
    if [ "$standalone_ok" -eq 1 ]; then
        INSTALL_METHOD="binary"
        # Download broker binary for workflow/SDK agent spawning. A rejected
        # broker (rc 2) rolls the CLI back; an unavailable one (rc 1) is fine.
        local broker_rc=0
        download_broker_binary || broker_rc=$?
        if [ "$broker_rc" -eq 2 ]; then
            abort_standalone_install
        fi
        # COMMIT: one assignment; everything after this is cleanup of backups.
        TXN_STATE=""
        rm -f "$INSTALL_DIR/bin/agent-relay${TXN_SUFFIX}"
        cleanup_broker_backups
        [ -n "$LAUNCHER_BACKUP" ] && rm -f "$LAUNCHER_BACKUP"
        LAUNCHER_BACKUP=""
        # Install ACP bridge for Zed editor (requires Node.js)
        install_acp_bridge || true
        verify_installation && print_usage && track_event "install_completed" && exit 0
    fi

    # Standalone path not taken: nothing was replaced, disarm and drop the backup
    TXN_STATE=""
    [ -n "$LAUNCHER_BACKUP" ] && rm -f "$LAUNCHER_BACKUP"
    LAUNCHER_BACKUP=""

    # Fall back to npm if Node.js is available
    if [ -n "$STANDALONE_FAILURE_REASON" ]; then
        info "Falling back to npm/source install after standalone verification failed."
    fi

    if check_node; then
        INSTALL_METHOD="npm"
        install_via_npm && verify_installation && print_usage && track_event "install_completed" && exit 0
        warn "npm installation failed, trying source..."
        INSTALL_METHOD="source"
        install_from_source && verify_installation && print_usage && track_event "install_completed" && exit 0
    else
        echo ""
        if [ -n "$STANDALONE_FAILURE_REASON" ]; then
            warn "Standalone install was rejected after verification failed (any previous install was left untouched)."
            echo "  $STANDALONE_FAILURE_REASON"
            echo "  Install Node.js 22+ to use the npm fallback, then rerun this installer."
            echo ""
        fi
        warn "No standalone binary available and Node.js not found."
        echo ""
        echo -e "${BOLD}Options:${NC}"
        echo ""
        echo "  1. Wait for standalone binaries (coming soon for your platform)"
        echo ""
        echo "  2. Install Node.js 22+ using one of these methods:"
        echo ""
        echo "     # Using nvm (recommended - works on macOS and Linux)"
        echo "     curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash"
        echo "     source ~/.bashrc  # or ~/.zshrc"
        echo "     nvm install 22"
        echo ""

        if [ "$OS" = "darwin" ]; then
            echo "     # macOS - Official installer"
            echo "     https://nodejs.org/en/download"
            echo ""
            echo "     # macOS - via Homebrew (if installed)"
            echo "     brew install node"
        elif [ "$OS" = "linux" ]; then
            # Detect package manager
            if command -v apt-get &> /dev/null; then
                echo "     # Ubuntu/Debian"
                echo "     curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
                echo "     sudo apt-get install -y nodejs"
            elif command -v dnf &> /dev/null; then
                echo "     # Fedora/RHEL"
                echo "     sudo dnf install nodejs npm"
            elif command -v pacman &> /dev/null; then
                echo "     # Arch Linux"
                echo "     sudo pacman -S nodejs npm"
            elif command -v apk &> /dev/null; then
                echo "     # Alpine Linux"
                echo "     apk add nodejs npm"
            else
                echo "     # Download from nodejs.org"
                echo "     https://nodejs.org/en/download"
            fi
        fi

        echo ""
        echo "Then re-run this installer."
        track_event "install_failed" ", \"error\": \"no_nodejs_or_binary\""
        exit 1
    fi
}

# Allow tests to source the functions without running the installer
if [ "${AGENT_RELAY_INSTALL_SOURCE_ONLY:-}" = "1" ]; then
    return 0 2>/dev/null || exit 0
fi

# Handle command line arguments
case "${1:-}" in
    --help|-h)
        echo "Agent Relay Installer"
        echo ""
        echo "Usage: curl -fsSL https://raw.githubusercontent.com/AgentWorkforce/relay/main/install.sh | bash"
        echo ""
        echo "Environment variables:"
        echo "  AGENT_RELAY_VERSION              Specific version to install (default: latest)"
        echo "  AGENT_RELAY_INSTALL_DIR          Installation directory (default: ~/.agentworkforce/relay)"
        echo "  AGENT_RELAY_BIN_DIR              Binary directory (default: ~/.local/bin)"
        echo "  AGENT_RELAY_TELEMETRY_DISABLED   Disable anonymous install telemetry (default: false)"
        echo ""
        echo "Telemetry: This installer collects anonymous usage data to improve the product."
        echo "           Set AGENT_RELAY_TELEMETRY_DISABLED=1 or DO_NOT_TRACK=1 to opt out."
        exit 0
        ;;
    --version|-v)
        echo "Installer for Agent Relay"
        echo "Repository: https://github.com/AgentWorkforce/relay"
        exit 0
        ;;
esac

main "$@"
