#!/usr/bin/env bash
# Exercise check-glibc-floor.sh against readelf output recorded from real
# probes, through a stub readelf, so the rule is pinned without a binary.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/test-glibc-floor.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
cat > "$tmp/bin/readelf" <<'STUB'
#!/usr/bin/env bash
case " $* " in
  *" --version-info "*) cat "$FIXTURE.versions" ;;
  *" --dyn-syms "*) cat "$FIXTURE.symbols" ;;
  *) exit 2 ;;
esac
STUB
chmod +x "$tmp/bin/readelf"
: > "$tmp/probe"

# The v2026.10.6 arm64 probe: std's weak pidfd references, yet an unflagged
# GLIBC_2.39 version need the loader enforces.
cat > "$tmp/arm64.versions" <<'OUT'
Version needs section '.gnu.version_r' contains 2 entries:
  000000: Version: 1  File: libm.so.6  Cnt: 1
  0x0010:   Name: GLIBC_2.29  Flags: none  Version: 5
  0x0020: Version: 1  File: libc.so.6  Cnt: 3
  0x0030:   Name: GLIBC_2.39  Flags: none  Version: 10
  0x0040:   Name: GLIBC_2.34  Flags: none  Version: 6
  0x0050:   Name: GLIBC_2.17  Flags: none  Version: 2
OUT
cat > "$tmp/arm64.symbols" <<'OUT'
    92: 0000000000000000     0 FUNC    WEAK   DEFAULT  UND pidfd_spawnp@GLIBC_2.39 (10)
   189: 0000000000000000     0 FUNC    WEAK   DEFAULT  UND pidfd_getpid@GLIBC_2.39 (10)
   200: 0000000000000000     0 FUNC    GLOBAL DEFAULT  UND __libc_start_main@GLIBC_2.34 (6)
OUT

# The v2026.10.6 x64 probe: the same references, with the need flagged WEAK.
sed 's/GLIBC_2.39  Flags: none/GLIBC_2.39  Flags: WEAK/' "$tmp/arm64.versions" > "$tmp/x64.versions"
cp "$tmp/arm64.symbols" "$tmp/x64.symbols"

# A named glibc ABI need does not have an ordered release version. It must
# fail closed instead of being skipped and accidentally lowering the floor.
cp "$tmp/x64.versions" "$tmp/unknown.versions"
cat >> "$tmp/unknown.versions" <<'OUT'
  0x0060:   Name: GLIBC_ABI_DT_RELR  Flags: none  Version: 11
OUT
cp "$tmp/x64.symbols" "$tmp/unknown.symbols"

check() { PATH="$tmp/bin:$PATH" FIXTURE="$tmp/$1" bash "$SCRIPT_DIR/check-glibc-floor.sh" "$tmp/probe" "${@:2}"; }

if output="$(check arm64 2>&1)"; then
  echo "FAIL: an unflagged GLIBC_2.39 need passed: $output" >&2; exit 1
fi
grep -q 'requires glibc 2.39' <<<"$output" || { echo "FAIL: $output" >&2; exit 1; }
grep -q 'WEAK pidfd_spawnp@GLIBC_2.39' <<<"$output" || { echo "FAIL: culprit not named: $output" >&2; exit 1; }
check arm64 --max 2.39 > /dev/null || { echo "FAIL: 2.39 within --max 2.39" >&2; exit 1; }
output="$(check x64)" || { echo "FAIL: a WEAK-flagged need raised the floor" >&2; exit 1; }
grep -q 'requires glibc 2.34' <<<"$output" || { echo "FAIL: $output" >&2; exit 1; }
if check x64 --max 2.17 > /dev/null 2>&1; then
  echo "FAIL: 2.34 passed --max 2.17" >&2; exit 1
fi
if output="$(check unknown 2>&1)"; then
  echo "FAIL: an unrecognised GLIBC_* need passed: $output" >&2; exit 1
fi
grep -q 'unrecognised glibc version need' <<<"$output" || { echo "FAIL: $output" >&2; exit 1; }
grep -q 'GLIBC_ABI_DT_RELR' <<<"$output" || { echo "FAIL: $output" >&2; exit 1; }
echo "check-glibc-floor: ok"
