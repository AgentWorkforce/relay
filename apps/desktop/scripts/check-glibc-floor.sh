#!/usr/bin/env bash
#
# check-glibc-floor.sh -- refuse a Linux binary that needs a newer glibc than
# the oldest one the release supports.
#
# The floor is the newest GLIBC_x.y in the binary's version needs
# (.gnu.version_r) that is not flagged WEAK: the loader refuses to start the
# binary on a glibc that lacks any such version ("version `GLIBC_2.39' not
# found"). That holds even when every symbol bound to the version is itself a
# weak reference, which is how Rust's std links pidfd_spawnp/pidfd_getpid; a
# check of symbol binding alone passes such a binary. Only a version need the
# linker flagged WEAK may be missing at run time.
#
# `readelf` reads any ELF architecture, so an aarch64 probe can be checked on
# an x64 host.
#
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
die() { printf '%s: error: %s\n' "$SCRIPT_NAME" "$*" >&2; exit 1; }

usage() {
  cat <<USAGE
Usage:
  ${SCRIPT_NAME} BINARY [--max VERSION]

Options:
  --max VERSION  The newest glibc the binary may require. Default 2.34.
USAGE
}

BINARY=""
MAX="2.34"
while [ $# -gt 0 ]; do
  case "$1" in
    --max) MAX="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) usage >&2; die "unknown argument: $1" ;;
    *) [ -z "$BINARY" ] || die "one binary at a time"; BINARY="$1"; shift ;;
  esac
done
[ -n "$BINARY" ] || { usage >&2; die "a binary is required"; }
[ -f "$BINARY" ] || die "no such file: $BINARY"
[[ "$MAX" =~ ^[0-9]+\.[0-9]+$ ]] || die "--max must look like 2.34"
command -v readelf >/dev/null 2>&1 || die "readelf is required (binutils)"

newer_than_max() { [ "$(printf '%s\n%s\n' "$1" "$MAX" | sort -V | tail -n 1)" != "$MAX" ]; }

# Version-need lines look like
#   0x0090:   Name: GLIBC_2.39  Flags: none  Version: 10
# (`Flags: WEAK` for a need the loader may leave unmet).
NEEDS_RAW="$(readelf --version-info --wide "$BINARY" | sed -n '/\.gnu\.version_r/,$p' | awk '
  { name = ""; flags = ""; index_ = "" }
  { for (i = 1; i <= NF; i++) {
      if ($i == "Name:") name = $(i + 1)
      if ($i == "Flags:") flags = $(i + 1)
      if ($i == "Version:") index_ = $(i + 1)
  } }
  name ~ /^GLIBC_/ { print name, flags, index_ }')"
[ -n "$NEEDS_RAW" ] || die "$BINARY needs no versioned glibc; is it a glibc binary?"
UNKNOWN="$(printf '%s\n' "$NEEDS_RAW" | awk '$1 !~ /^GLIBC_[0-9]+([.][0-9]+)+$/ { print $1 }')"
if [ -n "$UNKNOWN" ]; then
  printf '%s: error: %s has unrecognised glibc version need(s):\n' "$SCRIPT_NAME" "$BINARY" >&2
  while IFS= read -r need; do
    printf '  %s\n' "$need" >&2
  done <<< "$UNKNOWN"
  exit 1
fi
NEEDS="$(printf '%s\n' "$NEEDS_RAW" | awk '{ print substr($1, 7), $2, $3 }')"
HARD="$(printf '%s\n' "$NEEDS" | awk '$2 !~ /WEAK/')"
[ -n "$HARD" ] || die "$BINARY has no hard glibc version need"
FLOOR="$(printf '%s\n' "$HARD" | awk '{ print $1 }' | sort -u -V | tail -n 1)"

if newer_than_max "$FLOOR"; then
  printf '%s: %s requires glibc %s, newer than the supported %s.\n' \
    "$SCRIPT_NAME" "$BINARY" "$FLOOR" "$MAX" >&2
  SYMBOLS="$(readelf --dyn-syms --wide "$BINARY")"
  printf '%s\n' "$HARD" | while read -r version _ index_; do
    newer_than_max "$version" || continue
    printf '  GLIBC_%s (hard version need), required by:\n' "$version" >&2
    printf '%s\n' "$SYMBOLS" | awk -v v="@GLIBC_$version" -v idx="($index_)" '
      $7 == "UND" && index($8, v) && ($9 == idx || $9 == "") { printf "    %s %s\n", $5, $8 }' >&2
  done
  exit 1
fi
printf '%s: %s requires glibc %s (supported floor %s)\n' "$SCRIPT_NAME" "$BINARY" "$FLOOR" "$MAX"
