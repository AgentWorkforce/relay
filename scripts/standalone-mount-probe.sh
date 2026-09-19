#!/usr/bin/env bash
#
# Does the standalone binary actually mount file/flows/sessions?
#
# The bug this exists for (#1795) is invisible to every other check: the npm
# distribution works, so unit tests, typechecks and a normal install all pass
# while the compiled binary cannot mount anything.
#
# Two properties make this a real probe rather than a restatement of the build:
#
#   1. It runs the COMPILED binary, not dist/cli/index.js. The failure is a
#      property of the single-file distribution — no node_modules to import
#      from — so an entry point that has one cannot show it.
#   2. It runs with no node_modules reachable and an isolated HOME. A stray
#      tree anywhere above the cwd silently satisfies the import and the probe
#      passes for the wrong reason. The isolated HOME also means the binary
#      provisions its SDKs from scratch here, so the first run installs them
#      and takes minutes — which is the path being tested.
#
# And it does not stop at `--help`. Help renders from the surface's declared
# command tree, which is JavaScript; the implementations are a Go binary and a
# dlopened addon. A help-only gate passes while every real command fails —
# exactly how #1796 looked correct and was not.
set -euo pipefail

MODE="${1:---expect-working}"
# Where scripts/build-standalone.sh actually writes the compiled binary.
BIN="${STANDALONE_BIN:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bin/agent-relay-standalone}"

if [ ! -x "$BIN" ]; then
  echo "PROBE: no compiled binary at $BIN (run scripts/build-standalone.sh)" >&2
  exit 2
fi

# /tmp so no ancestor directory carries a node_modules the import could find.
SANDBOX="$(mktemp -d /tmp/standalone-mount-probe.XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT
export HOME="$SANDBOX/home"
mkdir -p "$HOME"
cd "$SANDBOX"

if find "$SANDBOX" -maxdepth 3 -name node_modules -print -quit | grep -q .; then
  echo "PROBE: sandbox is contaminated with node_modules" >&2
  exit 2
fi

# Each command exercises the product's real implementation, not its help text.
#   file integration available -> spawns the relayfile Go binary
#   sessions stats             -> loads the ai-hist native addon
#   flows check                -> compiles a flow through the flows SDK
printf 'export default { }\n' > probe.flow.ts
# Not GROUPS: bash keeps a special array of that name holding the
# caller's group IDs, and `declare -a GROUPS=(...)` silently does not replace
# it — the loop then iterates GIDs.
declare -a SURFACE_GROUPS=(file flows sessions)
# One real command per group, as newline-separated argv rather than a single
# string. A string has to be word-split at the call site, and an unquoted
# expansion breaks on a $BIN path containing whitespace — the shell's own error
# then matches none of the payload patterns below, so the probe would report
# that the product was reached when nothing ran.
declare -a REAL=(
  $'integration\navailable'
  $'check\nprobe.flow.ts'
  $'stats'
)

broken=0
for i in "${!SURFACE_GROUPS[@]}"; do
  group="${SURFACE_GROUPS[$i]}"
  if ! out="$("$BIN" "$group" --help 2>&1)"; then
    broken=1
    echo "  $group --help: FAILED — $(printf '%s' "$out" | head -1)"
    continue
  fi
  if ! printf '%s\n' "$out" | grep -q "^Usage: agent-relay $group"; then
    broken=1
    echo "  $group --help: rendered no mounted tree"
    continue
  fi

  # A real command may legitimately fail: no credentials, an invalid flow, an
  # empty database. What it must not do is fail because the product's own
  # payload is absent.
  #
  # So this matches the payload by name rather than any module error. A
  # structured refusal that names the user's input is the surface working —
  # an earlier version of this check called `REFUSED [invalid_spec] … Cannot
  # find module '@relayflows/surface/runtime'` a mount failure, when it was
  # the probe's own throwaway flow file that could not resolve.
  # Split on newlines only, so an argument may contain spaces and the binary
  # path is never word-split.
  local_ifs="$IFS"
  IFS=$'\n' read -r -d '' -a real_args < <(printf '%s\0' "${REAL[$i]}")
  IFS="$local_ifs"
  real="$group ${real_args[*]}"
  real_out="$("$BIN" "$group" "${real_args[@]}" 2>&1 || true)"
  if printf '%s\n' "$real_out" | grep -qE "needs @?[a-z/-]+, which is not installed|could not be prepared|installed but incomplete|@relayfile/cli-|ai-hist-native|relayfile binary not found|command-spec\.json"; then
    broken=1
    echo "  $group: help renders but \`$real\` cannot reach its implementation"
    echo "    $(printf '%s' "$real_out" | head -1)"
    continue
  fi
  echo "  $group: mounted, and \`$real\` reached the product"
done

case "$MODE" in
  --expect-broken)
    if [ "$broken" -eq 1 ]; then
      echo "PROBE: mount is broken"
      exit 1
    fi
    echo "PROBE: expected a broken mount and found a working one" >&2
    exit 2
    ;;
  --expect-working)
    if [ "$broken" -eq 1 ]; then
      echo "PROBE: mount is broken" >&2
      exit 1
    fi
    echo "PROBE: all groups mounted"
    ;;
  *)
    echo "usage: standalone-mount-probe.sh [--expect-broken|--expect-working]" >&2
    exit 2
    ;;
esac
