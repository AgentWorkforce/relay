#!/usr/bin/env bash
# Publish the Linux probe as a standalone headless asset: the same bytes the
# packages bundle, refused if its hard glibc floor is newer than --glibc.
#
# The archive path agent_relay/helpers/agent-relay-probe is a published download
# contract, independent of where the app installs the probe. Readers:
# agentrelay.com web/public/connect/install.sh and cloud
# packages/core/src/bootstrap/lib/relayflow-v2-history-flush.ts. Both
# package-*-probe.sh scripts share it; changing it is a breaking release.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "Usage: $0 --probe PATH --glibc VERSION --out FILE.tar.gz" >&2
  exit 2
}

probe=""
glibc=""
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --probe) probe="${2:-}"; shift 2 ;;
    --glibc) glibc="${2:-}"; shift 2 ;;
    --out) out="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done
if [ -z "$probe" ] || [ -z "$glibc" ] || [ -z "$out" ]; then
  usage
fi
[ -f "$probe" ] || { echo "Probe missing: $probe" >&2; exit 1; }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/package-linux-probe.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/agent_relay/helpers" "$(dirname "$out")"
install -m 0755 "$probe" "$tmp/agent_relay/helpers/agent-relay-probe"
install -m 0644 "$SCRIPT_DIR/../LICENSE" "$tmp/agent_relay/LICENSE"
bash "$SCRIPT_DIR/check-glibc-floor.sh" "$tmp/agent_relay/helpers/agent-relay-probe" --max "$glibc"
tar -czf "$out" -C "$tmp" --owner=0 --group=0 --numeric-owner agent_relay
echo "Wrote $out"
