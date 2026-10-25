#!/usr/bin/env bash
# Publish the app's signed helper as a standalone headless macOS probe.
#
# The archive path agent_relay/helpers/agent-relay-probe is a published download
# contract shared with package-linux-probe.sh; agentrelay.com
# web/public/connect/install.sh extracts it. Changing it is a breaking release.
set -euo pipefail

usage() {
  echo "Usage: $0 --app PATH --out FILE.tar.gz" >&2
  exit 2
}

app=""
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --app) app="${2:-}"; shift 2 ;;
    --out) out="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done
if [ -z "$app" ] || [ -z "$out" ]; then
  usage
fi
helper="$app/Contents/Helpers/Agent Relay Helper"
[ -f "$helper" ] || {
  echo "Signed probe missing from $app" >&2
  exit 1
}
for name in APPLE_API_KEY_BASE64 APPLE_API_KEY_ID APPLE_API_ISSUER; do
  [ -n "${!name:-}" ] || { echo "Missing $name" >&2; exit 1; }
done

requirement='anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "QUJ7SA6X8X"'
tmp="$(mktemp -d "${TMPDIR:-/tmp}/package-macos-probe.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/agent_relay/helpers" "$(dirname "$out")"
ditto "$helper" "$tmp/agent_relay/helpers/agent-relay-probe"
probe="$tmp/agent_relay/helpers/agent-relay-probe"
codesign --verify --strict "-R=$requirement" "$probe"

key="$tmp/AuthKey.p8"
: > "$key"
chmod 600 "$key"
if ! printf '%s' "$APPLE_API_KEY_BASE64" | base64 --decode > "$key" 2>/dev/null; then
  printf '%s' "$APPLE_API_KEY_BASE64" | base64 -D > "$key"
fi
[ -s "$key" ] || { echo "Apple API key did not decode" >&2; exit 1; }

# A ticket cannot be stapled to a bare Mach-O. Submit the exact signed helper
# in a ZIP to Apple's notary service, then publish those same bytes in a tarball.
ditto -c -k --keepParent "$probe" "$tmp/probe-notary.zip"
xcrun notarytool submit "$tmp/probe-notary.zip" \
  --key "$key" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" \
  --wait --output-format json > "$tmp/notary-result.json"
python3 - "$tmp/notary-result.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as result:
    status = json.load(result).get("status")
if status != "Accepted":
    raise SystemExit(f"Probe notarization was not accepted: {status}")
PY
install -m 0644 "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/LICENSE" "$tmp/agent_relay/LICENSE"
tar -czf "$out" -C "$tmp" agent_relay
echo "Wrote $out"
