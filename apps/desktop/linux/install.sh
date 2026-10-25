#!/usr/bin/env bash
#
# install.sh -- install or update Agent Relay's headless core on Linux.
#
# One idempotent command for a server or a desktop without the app: it
# installs the GTK-free core (`agent-relay-probe`) for this user, runs it as
# the systemd user service `agent-relay.service`, and on later runs updates it
# in place. Run it again at any time; an up-to-date healthy install is left
# alone.
#
#   curl -fsSL <this script> | bash
#   bash install.sh [--version X.Y.Z] [--rollback] [--dry-run]
#
# What it does:
#   1. Finds what is installed: a per-user install from this script
#      (~/.local/lib/agent-relay/current), the in-app updater's per-user
#      layout, or the .deb package (which apt owns; this script then stops).
#   2. Resolves the release (latest, or --version) from the published
#      releases, downloads AgentRelay-<version>-Linux-<arch>-probe.tar.gz and
#      verifies it against the release's .sha256. The checksum proves the
#      download is the published file, not who published it: Linux releases
#      carry no signature yet.
#   3. Unpacks into versions/<version>, checks the binary reports that
#      version, and points `current` at it atomically. The previous version
#      stays for rollback; older ones beyond KEEP are removed.
#   4. Writes the user unit (only when it is missing or names another
#      binary), reloads systemd, and restarts the service (or enables and
#      starts it on a first install). Agents the core spawned run in scopes of
#      their own and keep running through the restart.
#   5. Waits for the new core to answer with the new version; if it does not,
#      points `current` back at the previous version and restarts again.
#
# Never touched: settings, sign-in and agent registrations, which live in the
# core's data directory ($XDG_DATA_HOME/com.agentrelay.desktop), not here.
# Never done: anything needing root (the .deb), enabling lingering, or
# changing credentials; it says what to run instead.
set -euo pipefail

SCRIPT_NAME="agent-relay install"
RELEASES_API="${AGENT_RELAY_RELEASES_API:-https://api.github.com/repos/AgentWorkforce/relay-desktop-releases/releases}"
DOWNLOAD_BASE="${AGENT_RELAY_DOWNLOAD_BASE:-https://github.com/AgentWorkforce/relay-desktop-releases/releases/download}"
PREFIX="${AGENT_RELAY_PREFIX:-$HOME/.local/lib/agent-relay}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="agent-relay.service"
KEEP=3
HEALTH_TIMEOUT="${AGENT_RELAY_HEALTH_TIMEOUT:-60}"

VERSION=""
DRY_RUN=0
ROLLBACK=0

usage() {
  cat <<EOF
Usage: install.sh [--version X.Y.Z] [--rollback] [--dry-run]

  --version X.Y.Z  Install this release instead of the latest.
  --rollback       Switch back to the previously installed version.
  --dry-run        Say what would change and change nothing.
EOF
}

note() { printf '%s: %s\n' "$SCRIPT_NAME" "$*"; }
die() { printf '%s: error: %s\n' "$SCRIPT_NAME" "$*" >&2; exit 1; }
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '%s: would run: %s\n' "$SCRIPT_NAME" "$*"
  else
    "$@"
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || die "--version needs a value"; VERSION="${2#v}"; shift 2 ;;
    --rollback) ROLLBACK=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

[ "$(uname -s)" = Linux ] || die "this installs the Linux core; on macOS use the Agent Relay app"
[ -n "${HOME:-}" ] || die "HOME is not set"
[ "$(id -u)" != 0 ] || die "run this as the user the agents belong to, not root"

case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac

valid_version() { printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$'; }
[ -z "$VERSION" ] || valid_version "$VERSION" || die "not a release version: $VERSION"

have() { command -v "$1" >/dev/null 2>&1; }
have systemctl || die "systemctl is required: the core runs as a systemd user service"

sha256_of() {
  if have sha256sum; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

fetch() { # url dest
  if have curl; then curl -fsSL --proto '=https' --retry 3 -o "$2" "$1"
  elif have wget; then wget -q -O "$2" "$1"
  else die "curl or wget is required"
  fi
}

# --- 1. what is installed ---------------------------------------------------

if have dpkg-query && dpkg-query -W -f='${Status}' agent-relay 2>/dev/null | grep -q 'install ok installed'; then
  installed="$(dpkg-query -W -f='${Version}' agent-relay 2>/dev/null || true)"
  note "the agent-relay package ($installed) is installed; apt owns it."
  note "update it with: sudo apt-get install --only-upgrade agent-relay (or install the new .deb)"
  note "then: systemctl --user restart $UNIT"
  exit 3
fi

probe_version() { # binary -> version it reports
  "$1" --version 2>/dev/null | awk '{print $NF}' | head -n 1
}

current_version=""
if [ -x "$PREFIX/current/agent-relay-probe" ]; then
  current_version="$(probe_version "$PREFIX/current/agent-relay-probe" || true)"
fi
# The in-app updater's layout: ExecStart in the user unit names
# ~/.local/lib/agent-relay/<version>/<tree>/usr/lib/agent-relay/agent-relay-probe.
legacy=""
if [ -z "$current_version" ] && [ -f "$UNIT_DIR/$UNIT" ]; then
  legacy="$(sed -n 's/^ExecStart=\([^ ]*agent-relay-probe\).*/\1/p' "$UNIT_DIR/$UNIT" | head -n 1)"
  if [ -n "$legacy" ] && [ -x "$legacy" ]; then
    current_version="$(probe_version "$legacy" || true)"
  fi
fi
if [ -n "$current_version" ]; then
  note "installed: $current_version"
else
  note "no per-user install found"
fi

installed_versions() { # oldest first
  [ -d "$PREFIX/versions" ] || return 0
  find "$PREFIX/versions" -mindepth 1 -maxdepth 1 -type d ! -name '*.partial' -printf '%f\n' | sort -V
}

previous_version() {
  [ -d "$PREFIX/versions" ] || return 0
  # Newest installed version other than the current one.
  installed_versions | { grep -vxF "${current_version:-}" || true; } | tail -n 1
}

unit_text() {
  cat <<EOF
[Unit]
Description=Agent Relay headless service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
UMask=0077
ExecStart=$PREFIX/current/agent-relay-probe relay serve --headless
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
}

switch_to() { # version
  local link="$PREFIX/current"
  run ln -sfn "versions/$1" "$link.new"
  run mv -T "$link.new" "$link"
}

core_version() { # [binary] -> what the running core reports, or nothing
  "${1:-$PREFIX/current/agent-relay-probe}" relay call status.get --json 2>/dev/null \
    | grep -o '"daemon":{[^}]*}' | grep -o '"version":"[^"]*"' | head -n 1 | cut -d'"' -f4
}

healthy() { # version [binary to ask]
  [ "$DRY_RUN" = 1 ] && return 0
  local waited=0
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
    [ "$(core_version "${2:-}" || true)" = "$1" ] && return 0
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

restart_service() { # fails when systemd could not (re)start the unit
  run systemctl --user daemon-reload || return 1
  # A unit that hit its start limit refuses a restart until it is reset.
  run systemctl --user reset-failed "$UNIT" 2>/dev/null || true
  if systemctl --user is-enabled --quiet "$UNIT" 2>/dev/null; then
    run systemctl --user restart "$UNIT"
  else
    run systemctl --user enable --now "$UNIT"
  fi
}

ensure_unit() {
  local wanted
  wanted="$(unit_text)"
  if [ -f "$UNIT_DIR/$UNIT" ] && [ "$(cat "$UNIT_DIR/$UNIT")" = "$wanted" ]; then
    return 0
  fi
  if [ -f "$UNIT_DIR/$UNIT" ]; then
    run cp -p "$UNIT_DIR/$UNIT" "$UNIT_DIR/$UNIT.before-install"
  fi
  run mkdir -p "$UNIT_DIR"
  if [ "$DRY_RUN" = 1 ]; then
    note "would write $UNIT_DIR/$UNIT"
  else
    printf '%s\n' "$wanted" > "$UNIT_DIR/$UNIT.new"
    mv "$UNIT_DIR/$UNIT.new" "$UNIT_DIR/$UNIT"
  fi
}

linger_note() {
  if have loginctl && [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo yes)" = no ]; then
    note "the core stops when you log out. To keep it running on a server, run (once):"
    note "  sudo loginctl enable-linger $(id -un)"
  fi
}

# --- rollback -----------------------------------------------------------------

if [ "$ROLLBACK" = 1 ]; then
  target="$(previous_version)"
  [ -n "$target" ] || die "no earlier version to roll back to"
  note "rolling back ${current_version:-?} -> $target"
  switch_to "$target"
  ensure_unit
  restart_service || true
  healthy "$target" || die "the core did not come back on $target; see: journalctl --user -u $UNIT"
  note "now running $target"
  exit 0
fi

# --- 2. which release -------------------------------------------------------

if [ -z "$VERSION" ]; then
  tmp_json="$(mktemp)"
  fetch "$RELEASES_API/latest" "$tmp_json" || die "could not read the latest release"
  VERSION="$(grep -o '"tag_name": *"[^"]*"' "$tmp_json" | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/')"
  VERSION="${VERSION#v}"
  rm -f "$tmp_json"
  valid_version "$VERSION" || die "the latest release has no usable version"
fi
note "release: $VERSION ($ARCH)"

if [ "$current_version" = "$VERSION" ] && [ -z "$legacy" ]; then
  if [ "$DRY_RUN" = 1 ] || [ "$(core_version || true)" = "$VERSION" ]; then
    note "already up to date"
    linger_note
    exit 0
  fi
  note "installed but not answering; restarting it"
  ensure_unit
  restart_service || true
  healthy "$VERSION" || die "the core did not start; see: journalctl --user -u $UNIT"
  exit 0
fi

# --- 3. download, verify, unpack -------------------------------------------

asset="AgentRelay-$VERSION-Linux-$ARCH-probe.tar.gz"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
note "downloading $asset"
fetch "$DOWNLOAD_BASE/v$VERSION/$asset" "$work/$asset" || die "could not download $asset"
fetch "$DOWNLOAD_BASE/v$VERSION/$asset.sha256" "$work/$asset.sha256" || die "could not download $asset.sha256"
expected="$(awk '{print $1}' "$work/$asset.sha256" | head -n 1)"
printf '%s' "$expected" | grep -Eq '^[0-9a-f]{64}$' || die "the published checksum is unreadable"
[ "$(sha256_of "$work/$asset")" = "$expected" ] || die "$asset does not match its published checksum"
note "checksum verified"

# Only the one published path is accepted out of the archive.
listing="$(tar -tzf "$work/$asset")"
[ "$listing" = "$(printf 'agent_relay/\nagent_relay/helpers/\nagent_relay/helpers/agent-relay-probe')" ] \
  || [ "$listing" = "agent_relay/helpers/agent-relay-probe" ] \
  || die "the archive holds something other than the core"
tar -xzf "$work/$asset" -C "$work" agent_relay/helpers/agent-relay-probe
reported="$(probe_version "$work/agent_relay/helpers/agent-relay-probe" || true)"
[ "$reported" = "$VERSION" ] || die "the downloaded core reports ${reported:-nothing}, not $VERSION"

destination="$PREFIX/versions/$VERSION"
if [ "$DRY_RUN" = 1 ]; then
  note "would install $destination"
else
  mkdir -p "$PREFIX/versions"
  rm -rf "$destination.partial"
  mkdir -p "$destination.partial"
  install -m 0755 "$work/agent_relay/helpers/agent-relay-probe" "$destination.partial/agent-relay-probe"
  rm -rf "$destination"
  mv "$destination.partial" "$destination"
fi

# --- 4. switch and restart ---------------------------------------------------

was="${current_version:-}"
switch_to "$VERSION"
ensure_unit
# A restart systemd refuses rolls back like a core that never answers.
restarted=1
restart_service || { restarted=0; note "systemd could not restart $UNIT"; }

# --- 5. health, or roll back -------------------------------------------------

if [ "$restarted" = 0 ] || ! healthy "$VERSION"; then
  # Moving over from the in-app updater's layout: its core is not under
  # versions/ (a versions/ entry of the same version is the release just
  # unpacked), so go back by restoring the unit that ran it.
  if [ -n "$legacy" ] && [ -f "$UNIT_DIR/$UNIT.before-install" ]; then
    note "the new core did not answer; going back to the installed $was"
    run mv "$UNIT_DIR/$UNIT.before-install" "$UNIT_DIR/$UNIT"
    run rm -f "$PREFIX/current"
    run rm -rf "${PREFIX:?}/versions/$VERSION"
    restart_service || true
    healthy "$was" "$legacy" || die "going back to $was did not answer either; see: journalctl --user -u $UNIT"
    die "update to $VERSION failed and the installed $was is running again; see: journalctl --user -u $UNIT"
  fi
  if [ -n "$was" ] && [ "$was" != "$VERSION" ] && [ -d "$PREFIX/versions/$was" ]; then
    note "the new core did not answer; rolling back to $was"
    switch_to "$was"
    restart_service || true
    # A version that failed is never a rollback target.
    run rm -rf "${PREFIX:?}/versions/$VERSION"
    healthy "$was" || die "rollback to $was did not answer either; see: journalctl --user -u $UNIT"
    die "update to $VERSION failed and was rolled back to $was; see: journalctl --user -u $UNIT"
  fi
  die "the core did not start; see: journalctl --user -u $UNIT"
fi
note "running $VERSION"

# Moved over from the in-app updater's layout: its core is kept as a version
# of its own, so --rollback can go back to it.
if [ -n "$legacy" ] && [ -n "$was" ] && [ "$was" != "$VERSION" ] && valid_version "$was" \
  && [ ! -e "$PREFIX/versions/$was" ] && [ "$DRY_RUN" = 0 ]; then
  rm -rf "$PREFIX/versions/$was.partial"
  mkdir -p "$PREFIX/versions/$was.partial"
  install -m 0755 "$legacy" "$PREFIX/versions/$was.partial/agent-relay-probe"
  mv "$PREFIX/versions/$was.partial" "$PREFIX/versions/$was"
  note "kept the in-app updater's $was for --rollback"
fi

# Keep the newest KEEP versions (always the current one).
if [ "$DRY_RUN" = 0 ]; then
  installed_versions | { grep -vxF "$VERSION" || true; } | head -n -$((KEEP - 1)) \
    | while read -r old; do rm -rf "${PREFIX:?}/versions/$old"; done
fi
linger_note
