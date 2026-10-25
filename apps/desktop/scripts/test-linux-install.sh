#!/usr/bin/env bash
#
# test-linux-install.sh -- exercise linux/install.sh end to end on Linux with
# a fake release server and fake systemctl, curl and dpkg-query on PATH: a
# first install, an idempotent rerun, an update, a bad checksum, a new version
# that never answers or that systemd refuses to start (rolled back),
# --rollback (also back to an in-app updater's core it moved from), and a
# .deb install it leaves to apt. The core's data directory must come through
# untouched.
#
#   scripts/test-linux-install.sh            (Linux, or in a container:)
#   docker run --rm -v "$PWD":/src -w /src debian:bookworm-slim scripts/test-linux-install.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL="$REPO/linux/install.sh"
[ "$(uname -s)" = Linux ] || { echo "run on Linux (see the header)"; exit 2; }
[ "$(id -u)" != 0 ] || exec setpriv --reuid=65534 --regid=65534 --clear-groups env HOME=/tmp/install-test-home "$0" "$@"

root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
export HOME="$root/home" XDG_DATA_HOME="$root/home/.local/share" XDG_CONFIG_HOME="$root/home/.config"
mkdir -p "$HOME" "$root/bin" "$root/releases" "$root/state"
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; *) arch=arm64 ;; esac

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

# A fake core: reports its version, and answers status.get with it only
# while the fake service manager says it is the one running.
release() { # version [broken]
  local version="$1" dir="$root/releases/v$1" tree
  tree="$(mktemp -d)"
  mkdir -p "$dir" "$tree/agent_relay/helpers"
  cat > "$tree/agent_relay/helpers/agent-relay-probe" <<EOF
#!/usr/bin/env bash
if [ "\$1" = --version ]; then echo "agent-relay-probe $version"; exit 0; fi
if [ "\$1 \$2 \$3" = "relay call status.get" ]; then
  [ "${2:-}" = broken ] && exit 1
  [ "\$(cat "$root/state/running" 2>/dev/null)" = "$version" ] || exit 1
  echo '{"bridge_version":1,"result":{"daemon":{"version":"$version","pid":1},"spawn":null}}'
  exit 0
fi
exit 0
EOF
  chmod 0755 "$tree/agent_relay/helpers/agent-relay-probe"
  local asset="AgentRelay-$version-Linux-$arch-probe.tar.gz"
  tar -czf "$dir/$asset" -C "$tree" agent_relay
  (cd "$dir" && sha256sum "$asset" > "$asset.sha256")
  rm -rf "$tree"
}

cat > "$root/bin/curl" <<EOF
#!/usr/bin/env bash
# Serves https://releases.test/... from $root/releases.
out=""; url=""
while [ \$# -gt 0 ]; do
  case "\$1" in -o) out="\$2"; shift 2 ;; --proto|--retry) shift 2 ;; -*) shift ;; *) url="\$1"; shift ;; esac
done
case "\$url" in
  https://api.test/releases/latest) printf '{"tag_name": "v%s"}' "\$(cat "$root/state/latest")" > "\$out" ;;
  https://releases.test/*) cp "$root/releases/\${url#https://releases.test/}" "\$out" 2>/dev/null || exit 22 ;;
  *) exit 6 ;;
esac
EOF
cat > "$root/bin/systemctl" <<EOF
#!/usr/bin/env bash
# Records each call; a (re)start runs what the unit's ExecStart names: the
# version current points at, or an in-app updater install by its path.
echo "\$*" >> "$root/state/systemctl.log"
start() {
  local exe
  exe="\$(sed -n 's/^ExecStart=\([^ ]*\).*/\1/p' "$XDG_CONFIG_HOME/systemd/user/agent-relay.service" | head -n 1)"
  case "\$exe" in
    */current/*) basename "\$(readlink "$HOME/.local/lib/agent-relay/current")" ;;
    *) "\$exe" --version | awk '{print \$NF}' ;;
  esac > "$root/state/running"
}
case "\$*" in
  "--user daemon-reload") ;;
  "--user is-enabled --quiet agent-relay.service") [ -f "$root/state/enabled" ] ;;
  "--user reset-failed agent-relay.service") ;;
  "--user restart agent-relay.service")
    if [ -f "$root/state/restart-fails" ]; then rm "$root/state/restart-fails"; exit 1; fi
    start ;;
  "--user enable --now agent-relay.service") touch "$root/state/enabled"; start ;;
esac
EOF
cat > "$root/bin/dpkg-query" <<EOF
#!/usr/bin/env bash
[ -f "$root/state/deb" ] && { case "\$*" in *Status*) echo "install ok installed" ;; *) echo "2026.1.1" ;; esac; exit 0; }
exit 1
EOF
chmod 0755 "$root/bin/"*
export PATH="$root/bin:$PATH"
export AGENT_RELAY_RELEASES_API=https://api.test/releases
export AGENT_RELAY_DOWNLOAD_BASE=https://releases.test
export AGENT_RELAY_HEALTH_TIMEOUT=4

current() { basename "$(readlink "$HOME/.local/lib/agent-relay/current")"; }
restarts() { grep -cE 'restart|enable --now' "$root/state/systemctl.log" 2>/dev/null || true; }

# The core's data: settings, sign-in, agents. Never touched.
data="$XDG_DATA_HOME/com.agentrelay.desktop"
mkdir -p "$data" && echo '{"cloudSession":"kept"}' > "$data/injectable-agents.json"
data_sum="$(sha256sum "$data/injectable-agents.json")"

release 1.0.0; release 1.1.0; release 1.2.0; release 1.3.0 broken; release 0.9.0 broken; release 1.4.0
echo 1.0.0 > "$root/state/latest"
bash "$INSTALL" > "$root/state/out" 2>&1 || { cat "$root/state/out"; fail "install failed"; }
[ "$(current)" = 1.0.0 ] || fail "first install points at $(current)"
grep -q "ExecStart=$HOME/.local/lib/agent-relay/current/agent-relay-probe relay serve --headless" \
  "$XDG_CONFIG_HOME/systemd/user/agent-relay.service" || fail "unit not written"
grep -q 'enable --now' "$root/state/systemctl.log" || fail "first install did not enable the service"
pass "first install enables and starts 1.0.0"

before="$(restarts)"
bash "$INSTALL" | grep -q "already up to date" || fail "rerun was not a no-op"
[ "$(restarts)" = "$before" ] || fail "rerun restarted the service"
pass "rerun leaves a healthy install alone"

echo 1.1.0 > "$root/state/latest"
bash "$INSTALL" > "$root/state/out" 2>&1 || { cat "$root/state/out"; fail "install failed"; }
[ "$(current)" = 1.1.0 ] || fail "update points at $(current)"
[ -d "$HOME/.local/lib/agent-relay/versions/1.0.0" ] || fail "previous version removed"
grep -q 'restart agent-relay.service' "$root/state/systemctl.log" || fail "update did not restart"
pass "update to 1.1.0 restarts and keeps 1.0.0"

echo "0000000000000000000000000000000000000000000000000000000000000000  x" \
  > "$root/releases/v1.2.0/AgentRelay-1.2.0-Linux-$arch-probe.tar.gz.sha256"
if bash "$INSTALL" --version 1.2.0 >/dev/null 2>&1; then fail "a bad checksum was accepted"; fi
[ "$(current)" = 1.1.0 ] || fail "a bad checksum changed current"
[ ! -d "$HOME/.local/lib/agent-relay/versions/1.2.0" ] || fail "a bad download was unpacked"
pass "a checksum mismatch changes nothing"

if bash "$INSTALL" --version 1.3.0 >/dev/null 2>&1; then fail "a core that never answers was accepted"; fi
[ "$(current)" = 1.1.0 ] || fail "the failed update was not rolled back ($(current))"
[ ! -d "$HOME/.local/lib/agent-relay/versions/1.3.0" ] || fail "the failed version was kept"
[ "$(cat "$root/state/running")" = 1.1.0 ] || fail "1.1.0 is not running after rollback"
pass "a new core that never answers is rolled back"

touch "$root/state/restart-fails"
if bash "$INSTALL" --version 1.4.0 >/dev/null 2>&1; then fail "a refused restart was accepted"; fi
[ "$(current)" = 1.1.0 ] || fail "a refused restart was not rolled back ($(current))"
[ ! -d "$HOME/.local/lib/agent-relay/versions/1.4.0" ] || fail "the version systemd refused was kept"
[ "$(cat "$root/state/running")" = 1.1.0 ] || fail "1.1.0 is not running after a refused restart"
pass "a restart systemd refuses is rolled back"

bash "$INSTALL" --rollback >/dev/null
[ "$(current)" = 1.0.0 ] || fail "rollback picked $(current)"
pass "--rollback switches to an earlier version ($(current))"

bash "$INSTALL" --version 1.1.0 >/dev/null
before="$(restarts)"
bash "$INSTALL" --dry-run --version 1.0.0 >/dev/null
if [ "$(current)" != 1.1.0 ] || [ "$(restarts)" != "$before" ]; then
  fail "--dry-run changed something"
fi
pass "--dry-run changes nothing"

touch "$root/state/deb"
set +e; bash "$INSTALL" >/dev/null 2>&1; status=$?; set -e
[ "$status" = 3 ] || fail "a .deb install was not left to apt (exit $status)"
rm "$root/state/deb"
pass "a .deb install is left to apt"

# Moving over from the in-app updater's layout, whose core is not under
# versions/ and runs from the unit's own ExecStart.
rm -rf "$HOME/.local/lib/agent-relay/current" "$HOME/.local/lib/agent-relay/versions"
legacy="$HOME/.local/lib/agent-relay/0.9.0/AgentRelay-linux-x64/usr/lib/agent-relay/agent-relay-probe"
mkdir -p "$(dirname "$legacy")"
cat > "$legacy" <<EOF
#!/usr/bin/env bash
if [ "\$1" = --version ]; then echo "agent-relay-probe 0.9.0"; exit 0; fi
if [ "\$1 \$2 \$3" = "relay call status.get" ]; then
  [ "\$(cat "$root/state/running" 2>/dev/null)" = 0.9.0 ] || exit 1
  echo '{"bridge_version":1,"result":{"daemon":{"version":"0.9.0","pid":1},"spawn":null}}'
fi
EOF
chmod 0755 "$legacy"
legacy_unit="$(printf '[Service]\nExecStart=%s relay serve --headless\nRestart=always\n' "$legacy")"
printf '%s\n' "$legacy_unit" > "$XDG_CONFIG_HOME/systemd/user/agent-relay.service"
echo 0.9.0 > "$root/state/running"

if bash "$INSTALL" --version 1.3.0 >/dev/null 2>&1; then fail "a core that never answers was accepted"; fi
[ "$(cat "$XDG_CONFIG_HOME/systemd/user/agent-relay.service")" = "$legacy_unit" ] \
  || fail "the in-app updater's unit was not restored"
[ ! -e "$HOME/.local/lib/agent-relay/current" ] || fail "current was left pointing at the failed core"
[ ! -d "$HOME/.local/lib/agent-relay/versions/1.3.0" ] || fail "the failed version was kept"
[ "$(cat "$root/state/running")" = 0.9.0 ] || fail "the in-app updater's core is not running again"
pass "a failed move from the in-app updater's install goes back to it"

# The same version as the in-app updater's: versions/0.9.0 is the release
# just unpacked, never a rollback target.
if bash "$INSTALL" --version 0.9.0 >/dev/null 2>&1; then fail "a core that never answers was accepted"; fi
[ "$(cat "$XDG_CONFIG_HOME/systemd/user/agent-relay.service")" = "$legacy_unit" ] \
  || fail "a failed same-version move did not restore the in-app updater's unit"
[ ! -e "$HOME/.local/lib/agent-relay/current" ] || fail "a failed same-version move left current behind"
[ ! -d "$HOME/.local/lib/agent-relay/versions/0.9.0" ] || fail "the failed same-version core was kept"
if [ "$(cat "$root/state/running")" != 0.9.0 ] || [ ! -x "$legacy" ]; then
  fail "the in-app updater's core is not running again"
fi
pass "a failed same-version move from the in-app updater's install goes back to it"

bash "$INSTALL" --version 1.1.0 > "$root/state/out" 2>&1 || { cat "$root/state/out"; fail "move from the in-app updater failed"; }
[ "$(current)" = 1.1.0 ] || fail "the move points at $(current)"
[ "$(cat "$root/state/running")" = 1.1.0 ] || fail "1.1.0 is not running after the move"
pass "a move from the in-app updater's install switches to the managed layout"

bash "$INSTALL" --rollback > "$root/state/out" 2>&1 || { cat "$root/state/out"; fail "rollback after the move failed"; }
[ "$(current)" = 0.9.0 ] || fail "rollback after the move picked $(current)"
[ "$(cat "$root/state/running")" = 0.9.0 ] || fail "the in-app updater's core is not running after rollback"
pass "--rollback after a move goes back to the in-app updater's core"

[ "$(sha256sum "$data/injectable-agents.json")" = "$data_sum" ] || fail "the core's data changed"
pass "settings and sign-in data untouched"
echo "all install tests passed"
