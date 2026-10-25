#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: build-linux.sh --version VERSION --app FILE --probe FILE [--arch x64|arm64] [--out DIR]

Builds a portable Linux tree, tarball, and (when dpkg-deb or ar is installed)
.deb from a built app and relay core:

  --app FILE    `agent-relay-desktop`, built with the probe crate's `gtk` feature
  --probe FILE  `agent-relay-probe` (scripts/build-probe.sh)

Both are built for --arch with AGENT_RELAY_PROBE_VERSION=VERSION.
EOF
}

version=""
app=""
probe=""
arch="x64"
out="dist/linux"
while [ $# -gt 0 ]; do
  case "$1" in
    --version) version="${2:?}"; shift 2 ;;
    --app) app="${2:?}"; shift 2 ;;
    --probe) probe="${2:?}"; shift 2 ;;
    --arch) arch="${2:?}"; shift 2 ;;
    --out) out="${2:?}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; printf 'Unknown argument: %s\n' "$1" >&2; exit 1 ;;
  esac
done
[ -n "$version" ] || { usage >&2; exit 1; }
[ -f "$app" ] || { printf 'App does not exist: %s\n' "$app" >&2; exit 1; }
[ -f "$probe" ] || { printf 'Probe does not exist: %s\n' "$probe" >&2; exit 1; }
case "$arch" in x64) deb_arch=amd64 ;; arm64) deb_arch=arm64 ;; *) printf 'Unsupported arch: %s\n' "$arch" >&2; exit 1 ;; esac

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The tree probe/src/linux_app/install.rs describes.
root="$out/AgentRelay-linux-$arch"
rm -rf "$root"
mkdir -p "$root/usr/bin" "$root/usr/lib/agent-relay" \
  "$root/usr/share/applications" "$root/usr/share/icons/hicolor/scalable/apps" \
  "$root/usr/lib/systemd/user"
install -m 0755 "$app" "$root/usr/bin/agent-relay-desktop"
install -m 0755 "$probe" "$root/usr/lib/agent-relay/agent-relay-probe"
install -m 0644 "$repo/linux/agent-relay.desktop" "$root/usr/share/applications/agent-relay.desktop"
install -m 0644 "$repo/probe/resources/linux/agent-relay-mark.svg" "$root/usr/share/icons/hicolor/scalable/apps/agent-relay.svg"
install -m 0644 "$repo/linux/agent-relay-headless.service" "$root/usr/lib/systemd/user/agent-relay.service"
install -D -m 0644 "$repo/LICENSE" "$root/usr/share/doc/agent-relay/LICENSE"
install -m 0644 "$repo/assets/agent-icons-LICENSE.txt" "$root/usr/share/doc/agent-relay/agent-icons-LICENSE.txt"

mkdir -p "$out"
tar -C "$out" -czf "$out/AgentRelay-$version-Linux-$arch.tar.gz" "$(basename "$root")"
sha256sum "$out/AgentRelay-$version-Linux-$arch.tar.gz" > "$out/AgentRelay-$version-Linux-$arch.tar.gz.sha256"

write_control() {
  cat > "$1" <<EOF
Package: agent-relay
Version: $version
Architecture: $deb_arch
Maintainer: Agent Relay <support@agentrelay.com>
Depends: libc6 (>= 2.34), libgtk-4-1 (>= 4.6), librsvg2-common
Section: devel
Priority: optional
Homepage: https://agentrelay.com
Description: Native Agent Relay companion for Linux
 Connect coding sessions to Agent Relay with explicit upload controls.
EOF
}

deb="$out/AgentRelay-$version-Linux-$arch.deb"
deb="$(cd "$(dirname "$deb")" && pwd)/$(basename "$deb")"
if command -v dpkg-deb >/dev/null 2>&1; then
  mkdir -p "$root/DEBIAN"
  write_control "$root/DEBIAN/control"
  install -m 0755 "$repo/linux/agent-relay.postinst" "$root/DEBIAN/postinst"
  dpkg-deb --build --root-owner-group "$root" "$deb" >/dev/null
else
  command -v ar >/dev/null 2>&1 || { printf 'Neither dpkg-deb nor ar is available; cannot build .deb\n' >&2; exit 1; }
  deb_tmp="$out/.deb-$arch-$$"
  mkdir -p "$deb_tmp/control"
  write_control "$deb_tmp/control/control"
  install -m 0755 "$repo/linux/agent-relay.postinst" "$deb_tmp/control/postinst"
  printf '2.0\n' > "$deb_tmp/debian-binary"
  tar --numeric-owner --owner=0 --group=0 -C "$deb_tmp/control" -czf "$deb_tmp/control.tar.gz" .
  tar --numeric-owner --owner=0 --group=0 -C "$root" -czf "$deb_tmp/data.tar.gz" --exclude=./DEBIAN .
  ( cd "$deb_tmp" && ar r "$deb" debian-binary control.tar.gz data.tar.gz >/dev/null )
  rm -rf "$deb_tmp"
fi
sha256sum "$deb" > "$deb.sha256"
printf 'Linux package ready in %s\n' "$out"
