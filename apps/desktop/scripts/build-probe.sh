#!/usr/bin/env bash
#
# build-probe.sh -- build `agent-relay-probe` from probe/ for one target.
#
# Writes into --out:
#   agent-relay-probe          the binary, mode 0755
#   agent-relay-probe.sha256   `sha256sum` format line naming `agent-relay-probe`
#   probe-version.txt          the version the binary reports
#
# The binary reports --version, which build-app.sh and build-linux.sh bundle
# alongside it. A probe built for this host is also run through the bridge
# check before it is handed on.
#
# --glibc links a Linux probe against that glibc with cargo-zigbuild (zig and
# cargo-zigbuild on PATH) instead of the build host's, then refuses the binary
# if its hard glibc floor is newer (check-glibc-floor.sh). Without it a probe
# built on a current runner needs that runner's glibc: Rust's std versions its
# weak pidfd_spawnp reference at GLIBC_2.39 on aarch64.
#
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MANIFEST="$REPO_ROOT/probe/Cargo.toml"

usage() {
  cat <<EOF
Usage:
  ${SCRIPT_NAME} --target TRIPLE --version VERSION --out DIR [--glibc VERSION]

Options:
  --target TRIPLE    Rust target, for example aarch64-apple-darwin or
                     x86_64-unknown-linux-gnu. Required.
  --version VERSION  The desktop release version the probe reports. Required.
  --out DIR          Directory the probe, its .sha256 and probe-version.txt are
                     written to. Created when missing. Required.
  --glibc VERSION    Linux only: the oldest glibc the probe must run on, for
                     example 2.34. Builds with cargo-zigbuild and checks the
                     result.
EOF
}

die() { printf '%s: error: %s\n' "$SCRIPT_NAME" "$*" >&2; exit 1; }
note() { printf '%s: %s\n' "$SCRIPT_NAME" "$*"; }

TARGET=""
VERSION=""
OUT_DIR=""
GLIBC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --out) OUT_DIR="${2:-}"; shift 2 ;;
    --glibc) GLIBC="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done
[ -n "$TARGET" ] || die "--target is required"
[ -n "$VERSION" ] || die "--version is required"
[ -n "$OUT_DIR" ] || die "--out is required"
command -v cargo >/dev/null 2>&1 || die "cargo is required; install a Rust toolchain"
BUILD=(build)
CARGO_TARGET="$TARGET"
if [ -n "$GLIBC" ]; then
  case "$TARGET" in
    *-linux-gnu) ;;
    *) die "--glibc applies only to a *-linux-gnu target, not $TARGET" ;;
  esac
  [[ "$GLIBC" =~ ^[0-9]+\.[0-9]+$ ]] || die "--glibc must look like 2.34"
  command -v cargo-zigbuild >/dev/null 2>&1 || die "--glibc needs cargo-zigbuild on PATH"
  command -v zig >/dev/null 2>&1 || die "--glibc needs zig on PATH"
  BUILD=(zigbuild)
  # cargo-zigbuild reads the glibc version from the target suffix and still
  # writes the binary under the plain target's directory.
  CARGO_TARGET="$TARGET.$GLIBC"
fi

if command -v rustup >/dev/null 2>&1; then
  rustup target add "$TARGET" >/dev/null 2>&1 || \
    note "could not add the $TARGET target with rustup; assuming it is installed"
fi

note "building agent-relay-probe $VERSION for $CARGO_TARGET"
AGENT_RELAY_PROBE_VERSION="$VERSION" cargo "${BUILD[@]}" \
  --manifest-path "$MANIFEST" \
  --release \
  --locked \
  --bin agent-relay-probe \
  --target "$CARGO_TARGET"

TARGET_ROOT="${CARGO_TARGET_DIR:-$REPO_ROOT/probe/target}"
BUILT="$TARGET_ROOT/$TARGET/release/agent-relay-probe"
[ -f "$BUILT" ] || die "cargo reported success but no binary at $BUILT"
if [ -n "$GLIBC" ]; then
  bash "$SCRIPT_DIR/check-glibc-floor.sh" "$BUILT" --max "$GLIBC"
fi

mkdir -p "$OUT_DIR"
install -m 0755 "$BUILT" "$OUT_DIR/agent-relay-probe"
if command -v sha256sum >/dev/null 2>&1; then
  ( cd "$OUT_DIR" && sha256sum agent-relay-probe > agent-relay-probe.sha256 )
else
  ( cd "$OUT_DIR" && shasum -a 256 agent-relay-probe > agent-relay-probe.sha256 )
fi
chmod 0644 "$OUT_DIR/agent-relay-probe.sha256"
printf '%s\n' "$VERSION" > "$OUT_DIR/probe-version.txt"

HOST="$(rustc -vV | sed -n 's/^host: //p')"
if [ "$HOST" = "$TARGET" ]; then
  bash "$SCRIPT_DIR/check-probe-bridge.sh" "$OUT_DIR/agent-relay-probe"
else
  note "skipping the bridge check: built for $TARGET on $HOST"
fi
note "agent-relay-probe $VERSION ($TARGET) ready in $OUT_DIR"
