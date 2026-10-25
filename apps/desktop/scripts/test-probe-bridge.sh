#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT
export PROBE_CALLS="$TEST_DIR/calls"
export HOST_OS=Darwin HOST_ARCH=arm64 PROBE_VALID=yes PROBE_RESET=yes
cat > "$TEST_DIR/uname" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  -s) echo "$HOST_OS" ;;
  -m) echo "$HOST_ARCH" ;;
esac
STUB
cat > "$TEST_DIR/probe" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$PROBE_CALLS"
if [ "$1 $2" = "sessions reset" ] && [ "$PROBE_RESET" = no ]; then exit 1; fi
if [ "$PROBE_VALID" = yes ]; then echo '--json --selected-sessions-only --app-data-dir --confirmation'; fi
STUB
chmod +x "$TEST_DIR/uname" "$TEST_DIR/probe"
export PATH="$TEST_DIR:$PATH"
check() { bash "$SCRIPT_DIR/check-probe-bridge.sh" "$TEST_DIR/probe" "$@"; }
for arch in arm64 x64; do
  if [ "$arch" = arm64 ]; then HOST_ARCH=arm64; else HOST_ARCH=x86_64; fi
  rm -f "$PROBE_CALLS"
  check "$arch"
  [ "$(wc -l < "$PROBE_CALLS" | tr -d ' ')" = 16 ]
  PROBE_RESET=no
  if check "$arch" > /dev/null 2>&1; then
    echo 'A helper lacking reset must be rejected before packaging' >&2
    exit 1
  fi
  PROBE_RESET=yes
  PROBE_VALID=no
  if check "$arch" > /dev/null 2>&1; then
    echo 'A native probe without the bridge must be rejected' >&2
    exit 1
  fi
  rm -f "$PROBE_CALLS"
  if [ "$arch" = arm64 ]; then HOST_ARCH=x86_64; else HOST_ARCH=arm64; fi
  check "$arch"
  [ ! -e "$PROBE_CALLS" ]
  PROBE_VALID=yes
done
HOST_OS=Linux
HOST_ARCH=arm64
check arm64
[ ! -e "$PROBE_CALLS" ]
# Without a target argument, existing callers still validate the binary.
check
[ -s "$PROBE_CALLS" ]
echo 'Probe bridge validation tests passed'
