#!/usr/bin/env bash
# Validate the relay core and the uploader commands it runs, without reading
# installs, credentials or session data.
set -euo pipefail
PROBE_BINARY="${1:?Usage: check-probe-bridge.sh /path/to/agent-relay-probe [arm64|x64]}"
# Execute target probes only on a matching host, as in the CI build matrix.
if [ -n "${2:-}" ]; then
  case "$2" in
    arm64) target_machine=arm64 ;;
    x64) target_machine=x86_64 ;;
    *) printf 'Unsupported probe architecture: %s\n' "$2" >&2; exit 1 ;;
  esac
  if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != "$target_machine" ]; then
    printf 'Skipping probe bridge smoke test: target macOS/%s, host %s/%s\n' "$2" "$(uname -s)" "$(uname -m)"
    exit 0
  fi
fi

for command in installs start status pause resume disconnect 'sessions list' 'sessions preview' 'sessions include' 'sessions exclude' 'sessions reset' 'sharing set' 'sharing status'; do
  read -r -a args <<< "$command"
  help_text="$("$PROBE_BINARY" "${args[@]}" --help)"
  if [[ "$help_text" != *"--json"* ]]; then
    printf 'Probe lacks desktop bridge v1 (%s --json). Rebuild probe/ before packaging.\n' "$command" >&2
    exit 1
  fi
done
install_help="$("$PROBE_BINARY" cloud install --help)"
if [[ "$install_help" != *"--selected-sessions-only"* ]]; then
  printf 'Probe lacks selected-session setup. Rebuild probe/ before packaging.\n' >&2
  exit 1
fi
serve_help="$("$PROBE_BINARY" relay serve --help)"
if [[ "$serve_help" != *"--app-data-dir"* ]]; then
  printf 'Probe lacks the relay core (relay serve). Rebuild probe/ before packaging.\n' >&2
  exit 1
fi

reset_help="$("$PROBE_BINARY" sessions reset --help)"
if [[ "$reset_help" != *"--confirmation"* ]]; then
  printf 'Probe lacks typed session reset confirmation. Rebuild probe/ before packaging.\n' >&2
  exit 1
fi
