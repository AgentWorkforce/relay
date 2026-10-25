#!/usr/bin/env bash
# Build the portable Windows tree and zips of Agent Relay under MSYS2.
#
# The Windows app is the Linux GTK 4 app (`agent-relay-desktop`, the probe crate's
# `gtk` feature) built natively with MSYS2's CLANG64 (x64) or CLANGARM64
# (arm64) toolchain. GTK links dynamically, so the tree carries the GTK
# runtime beside the two executables, laid out as an MSYS2 prefix
# (probe/src/linux_app/install/windows.rs describes it to the app):
#
#   AgentRelay-Windows-<arch>/
#     bin/agent-relay-desktop.exe      the app
#     bin/agent-relay-probe.exe        the relay core
#     bin/*.dll                        every DLL either needs from the MSYS2 prefix
#     bin/gdbus.exe                    the session bus GApplication uses to stay one instance
#     bin/gspawn-win64-helper*.exe     GLib's process-spawn helpers
#     lib/gdk-pixbuf-2.0/2.10.0/       image loaders (PNG, JPEG, GIF, BMP, ICO, SVG) and loaders.cache
#     share/glib-2.0/schemas/gschemas.compiled
#     share/gtk-4.0/                   GTK's data (emoji chooser translations)
#     share/icons/hicolor/             index.theme and the Agent Relay icon
#     share/icons/Adwaita/             index.theme and the symbolic icons
#     share/icons/agent-relay.ico      the Agent Relay icon for Windows
#     NOTICES.txt                      the bundled packages, their licenses and license texts
#
# Then, in --out:
#   AgentRelay-<version>-Windows-<arch>.zip (+ .sha256)        the tree above
#   AgentRelay-<version>-Windows-<arch>-probe.zip (+ .sha256)  the bare core:
#     agent_relay/helpers/agent-relay-probe.exe and the DLLs it needs
#   AgentRelay-<version>-Windows-<arch>-Setup.exe (+ .sha256)  the per-user
#     installer (windows/installer/AgentRelay.iss), when Inno Setup 6 is found
#
# The .ico is rendered from the SVG mark with rsvg-convert; no binary asset is
# checked in. When this script builds the executables it embeds the icon and
# the version in them (AGENT_RELAY_WINDOWS_ICON, read by probe/build.rs).
set -euo pipefail
shopt -s nullglob

SCRIPT_NAME="$(basename "$0")"

usage() {
  cat <<'EOF'
Usage: build-windows.sh --version VERSION [--arch x64|arm64] [--out DIR]
                        [--app FILE] [--probe FILE] [--installer|--no-installer]

Builds the portable Windows tree and zips from a built app and relay core.
Run it from an MSYS2 shell matching --arch: CLANG64 for x64, CLANGARM64 for
arm64, with the toolchain, rust, gtk4, pkgconf, librsvg and ntldd packages
plus zip.

  --version VERSION  The release version (AGENT_RELAY_PROBE_VERSION). Required.
  --arch x64|arm64   Default x64.
  --out DIR          Default dist/windows.
  --app FILE         `agent-relay-desktop.exe`, built with the probe crate's `gtk`
                     feature. Built with cargo (release, icon embedded) when
                     omitted.
  --probe FILE       `agent-relay-probe.exe`. Built with cargo when omitted.
  --installer        Require the Setup .exe: fail when Inno Setup 6's
                     ISCC.exe is not found. Without it the installer is built
                     when ISCC.exe is found ($ISCC, PATH, or Inno Setup 6's
                     machine or per-user install folder) and skipped otherwise.
  --no-installer     Do not build the Setup .exe.
EOF
}

die() { printf '%s: error: %s\n' "$SCRIPT_NAME" "$*" >&2; exit 1; }
note() { printf '%s: %s\n' "$SCRIPT_NAME" "$*"; }

version=""
app=""
probe=""
arch="x64"
out="dist/windows"
installer="auto"
while [ $# -gt 0 ]; do
  case "$1" in
    --version) version="${2:?}"; shift 2 ;;
    --app) app="${2:?}"; shift 2 ;;
    --probe) probe="${2:?}"; shift 2 ;;
    --arch) arch="${2:?}"; shift 2 ;;
    --out) out="${2:?}"; shift 2 ;;
    --installer) installer="yes"; shift ;;
    --no-installer) installer="no"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done
[ -n "$version" ] || { usage >&2; exit 1; }
case "$arch" in
  x64) msystem=CLANG64; prefix=/clang64; triple=x86_64-pc-windows-gnullvm ;;
  arm64) msystem=CLANGARM64; prefix=/clangarm64; triple=aarch64-pc-windows-gnullvm ;;
  *) die "unsupported arch: $arch" ;;
esac
[ "${MSYSTEM:-}" = "$msystem" ] || die "run from an MSYS2 $msystem shell for $arch (MSYSTEM is '${MSYSTEM:-unset}')"
[ -d "$prefix/bin" ] || die "$prefix is missing; install the mingw-w64-clang packages for $msystem"
for tool in cygpath ntldd zip sha256sum glib-compile-schemas; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
done


# Inno Setup 6's compiler: $ISCC, PATH, then where its installer (or winget,
# per user, under %LOCALAPPDATA%: CSIDL 28) puts it.
iscc=""
if [ "$installer" != "no" ]; then
  for candidate in "${ISCC:-}" "$(command -v ISCC.exe 2>/dev/null || command -v iscc 2>/dev/null || true)" \
    "/c/Program Files (x86)/Inno Setup 6/ISCC.exe" "/c/Program Files/Inno Setup 6/ISCC.exe" \
    "$(cygpath -u -F 28 2>/dev/null)/Programs/Inno Setup 6/ISCC.exe"; do
    if [ -n "$candidate" ] && [ -f "$candidate" ]; then iscc="$candidate"; break; fi
  done
  if [ -z "$iscc" ] && [ "$installer" = "yes" ]; then
    die "Inno Setup 6 (ISCC.exe) is required for --installer; install it (winget install JRSoftware.InnoSetup) or set ISCC"
  fi
fi

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# `sha256sum` format, two spaces and no binary marker, as on Linux.
checksum() { # DIR NAME
  ( cd "$1" && printf '%s  %s\n' "$(sha256sum < "$2" | cut -d' ' -f1)" "$2" > "$2.sha256" )
}

# --- the icon ----------------------------------------------------------------

# PNG images at the sizes Windows asks for, packed into an ICO container
# (PNG entries, Windows Vista and later).
ico=""
ico_sizes=(16 20 24 32 40 48 64 256)
# shellcheck disable=SC2059 # the format is the byte being written
byte() { printf "\\$(printf '%03o' "$1")"; }
le16() { byte $(($1 & 255)); byte $((($1 >> 8) & 255)); }
le32() { le16 $(($1 & 65535)); le16 $((($1 >> 16) & 65535)); }
if command -v rsvg-convert >/dev/null 2>&1; then
  mkdir -p "$work/ico"
  # A square canvas: the mark is wider than tall, so it is centered.
  sed 's/width="112" height="91" viewBox="0 0 112 91"/width="112" height="112" viewBox="0 -10.5 112 112"/' \
    "$repo/probe/resources/linux/agent-relay-mark.svg" > "$work/ico/mark.svg"
  grep -q 'viewBox="0 -10.5 112 112"' "$work/ico/mark.svg" || die "agent-relay-mark.svg changed size; update the square canvas here"
  for size in "${ico_sizes[@]}"; do
    rsvg-convert -w "$size" -h "$size" "$work/ico/mark.svg" -o "$work/ico/$size.png"
  done
  ico="$work/agent-relay.ico"
  {
    le16 0; le16 1; le16 "${#ico_sizes[@]}"
    offset=$((6 + 16 * ${#ico_sizes[@]}))
    for size in "${ico_sizes[@]}"; do
      bytes="$(wc -c < "$work/ico/$size.png")"
      dim=$((size == 256 ? 0 : size))
      byte "$dim"; byte "$dim"; byte 0; byte 0
      le16 1; le16 32; le32 "$bytes"; le32 "$offset"
      offset=$((offset + bytes))
    done
    for size in "${ico_sizes[@]}"; do cat "$work/ico/$size.png"; done
  } > "$ico"
else
  note "rsvg-convert is not installed (librsvg for $msystem): no agent-relay.ico, and the executables have no icon"
fi

# --- the executables ---------------------------------------------------------

if [ -z "$app" ] || [ -z "$probe" ]; then
  command -v cargo >/dev/null 2>&1 || die "cargo is required to build the app and core; or pass --app and --probe"
  host="$(rustc -vV | sed -n 's/^host: //p')"
  [ "$host" = "$triple" ] || die "the $msystem Rust toolchain builds for $triple, but rustc reports $host"
  target_dir="$(cygpath -u "${CARGO_TARGET_DIR:-$repo/probe/target}")"
  icon_env=""
  if [ -n "$ico" ]; then icon_env="$(cygpath -m "$ico")"; fi
  # The core builds without `gtk` so it never links the GTK stack, as on Linux.
  if [ -z "$probe" ]; then
    note "building agent-relay-probe $version for $triple"
    AGENT_RELAY_PROBE_VERSION="$version" AGENT_RELAY_WINDOWS_ICON="$icon_env" \
      cargo build --manifest-path "$repo/probe/Cargo.toml" --release --locked --bin agent-relay-probe
    probe="$target_dir/release/agent-relay-probe.exe"
  fi
  if [ -z "$app" ]; then
    note "building agent-relay-desktop $version for $triple"
    AGENT_RELAY_PROBE_VERSION="$version" AGENT_RELAY_WINDOWS_ICON="$icon_env" \
      cargo build --manifest-path "$repo/probe/Cargo.toml" --release --locked --features gtk --bin agent-relay-desktop
    app="$target_dir/release/agent-relay-desktop.exe"
  fi
fi
[ -f "$app" ] || die "app does not exist: $app"
[ -f "$probe" ] || die "probe does not exist: $probe"

# --- DLL closure -------------------------------------------------------------

# Print the prefix DLLs FILE loads, directly or through other DLLs, one
# Windows path per line. System DLLs (Windows, API sets) are left to Windows;
# a missing lib*.dll, which only MSYS2 provides, is reported.
prefix_bin_win="$(cygpath -m "$prefix/bin" | tr '[:upper:]' '[:lower:]')"
dll_closure() {
  local listing
  listing="$(ntldd -R "$1")" || die "ntldd could not read $1"
  printf '%s\n' "$listing" | awk -v bin="$prefix_bin_win/" -v me="$SCRIPT_NAME" -v file="$1" '
    / => not found/ {
      if (tolower($1) ~ /^lib/)
        printf "%s: warning: %s needs %s, which was not found\n", me, file, $1 > "/dev/stderr"
      next
    }
    / => / {
      sub(/^.* => /, ""); sub(/ \(0x[0-9a-fA-F]*\)[[:space:]]*$/, ""); gsub(/[\\]/, "/")
      if (index(tolower($0), bin) == 1) print
    }'
}

copy_closure() { # DEST FILE...
  local dest="$1"; shift
  local file
  for file in "$@"; do dll_closure "$file"; done | sort -fu | cygpath -u -f - | xargs -r -d '\n' cp -t "$dest"
}

# --- the tree ----------------------------------------------------------------

name="AgentRelay-Windows-$arch"
root="$out/$name"
rm -rf "$root"
mkdir -p "$root/bin" "$root/lib" "$root/share/glib-2.0/schemas" "$root/share/icons"

cp "$app" "$root/bin/agent-relay-desktop.exe"
cp "$probe" "$root/bin/agent-relay-probe.exe"
cp "$repo/LICENSE" "$root/LICENSE.txt"
cp "$repo/assets/agent-icons-LICENSE.txt" "$root/agent-icons-LICENSE.txt"
# gdbus is the session bus GApplication keeps one instance on: GLib starts
# `gdbus.exe _win32_run_session_bus` from beside libgio the first time the
# app registers, and a later launch hands its command line (`--background`,
# agentrelay:// links) to the running app over it and exits. GLib runs the
# gspawn helpers to spawn child processes with redirected handles.
for helper in gdbus.exe gspawn-win64-helper.exe gspawn-win64-helper-console.exe; do
  [ -f "$prefix/bin/$helper" ] || die "$prefix/bin/$helper is missing; install glib2 for $msystem"
  cp "$prefix/bin/$helper" "$root/bin/"
done

# Image loaders: the formats the app and GTK draw, SVG for the icons. The
# loaders.cache paths are relative to the tree's root, so it copies as is,
# keeping only the loaders shipped.
pixbuf="lib/gdk-pixbuf-2.0/2.10.0"
loaders=(libpixbufloader-png.dll libpixbufloader-jpeg.dll libpixbufloader-gif.dll
  libpixbufloader-bmp.dll libpixbufloader-ico.dll pixbufloader_svg.dll libpixbufloader-svg.dll)
mkdir -p "$root/$pixbuf/loaders"
shipped=()
for loader in "${loaders[@]}"; do
  if [ -f "$prefix/$pixbuf/loaders/$loader" ]; then
    cp "$prefix/$pixbuf/loaders/$loader" "$root/$pixbuf/loaders/"
    shipped+=("$loader")
  fi
done
case " ${shipped[*]} " in *svg*) ;; *) die "the SVG pixbuf loader is missing; install librsvg for $msystem" ;; esac
awk -v keep="${shipped[*]}" '
  BEGIN { n = split(keep, names, " ") }
  /^#/ { print; next }
  /^"[^"]*[.]dll"$/ {
    on = 0
    for (i = 1; i <= n; i++) if (index($0, "\\\\" names[i] "\"") || index($0, "/" names[i] "\"")) on = 1
  }
  on { print }
' "$prefix/$pixbuf/loaders.cache" > "$root/$pixbuf/loaders.cache"
[ "$(grep -c '^"[^"]*[.]dll"$' "$root/$pixbuf/loaders.cache")" -eq "${#shipped[@]}" ] \
  || die "loaders.cache does not list every shipped loader"

copy_closure "$root/bin" "$root"/bin/*.exe "$root/$pixbuf/loaders"/*.dll

# GTK's settings schemas only, compiled for the tree.
mkdir -p "$work/schemas"
cp "$prefix"/share/glib-2.0/schemas/org.gtk.gtk4.*.gschema.xml "$work/schemas/"
glib-compile-schemas --targetdir="$root/share/glib-2.0/schemas" "$work/schemas"

# GTK's data: the emoji chooser's translations (English is built in).
mkdir -p "$root/share/gtk-4.0"
if [ -d "$prefix/share/gtk-4.0/emoji" ]; then cp -r "$prefix/share/gtk-4.0/emoji" "$root/share/gtk-4.0/"; fi

# hicolor: the Agent Relay icon.
hicolor="$root/share/icons/hicolor"
mkdir -p "$hicolor/scalable/apps" "$hicolor/symbolic/apps"
if [ -f "$prefix/share/icons/hicolor/index.theme" ]; then cp "$prefix/share/icons/hicolor/index.theme" "$hicolor/"; fi
cp "$repo/probe/resources/linux/agent-relay-mark.svg" "$hicolor/scalable/apps/agent-relay.svg"
cp "$repo/probe/resources/linux/agent-relay-symbolic.svg" "$hicolor/symbolic/apps/agent-relay-symbolic.svg"
# Symbolic icons the app names that Adwaita 47+ no longer ships.
# They go in symbolic/apps: the only symbolic directory hicolor's index.theme
# lists, and GTK looks only in listed directories.
cp "$repo"/probe/resources/windows/icons/*-symbolic.svg "$hicolor/symbolic/apps/"
if [ -n "$ico" ]; then cp "$ico" "$root/share/icons/agent-relay.ico"; fi

# Adwaita, trimmed to the symbolic icons GTK and the app draw: no cursors
# (Windows draws its own), no full-color icons, and no icon-theme.cache, which
# would go stale and hide icons.
adwaita_src="$prefix/share/icons/Adwaita"
[ -d "$adwaita_src/symbolic" ] || die "$adwaita_src/symbolic is missing; install adwaita-icon-theme for $msystem"
mkdir -p "$root/share/icons/Adwaita"
cp "$adwaita_src/index.theme" "$root/share/icons/Adwaita/"
cp -r "$adwaita_src/symbolic" "$root/share/icons/Adwaita/"

# NOTICES.txt: which MSYS2 package each bundled file came from, its license,
# and the license texts the package installs.
notices="$root/NOTICES.txt"
{
  printf 'Agent Relay %s for Windows (%s)\n\n' "$version" "$arch"
  printf 'agent-relay-desktop.exe and agent-relay-probe.exe are Agent Relay. The other\n'
  printf 'files in this folder are unmodified builds from the MSYS2 project\n'
  printf '(https://www.msys2.org), redistributed under their own licenses below.\n'
  printf 'GTK, GLib and the other LGPL libraries are linked dynamically; you may\n'
  printf 'replace any DLL in bin with your own build of the same library.\n'
  printf 'Sources: https://packages.msys2.org and https://github.com/msys2/MINGW-packages\n\n'
} > "$notices"
bundled="$(cd "$root" && find bin lib share -type f ! -name 'agent-relay*' ! -name 'gschemas.compiled' ! -name 'loaders.cache' | sort)"
if command -v pacman >/dev/null 2>&1; then
  # pacman is slow to start under MSYS2: one call for every file, then one for
  # every package. -Qo prints "<path> is owned by <package> <version>".
  owners="$(cd "$prefix" || exit 1; printf '%s\n' "$bundled" | xargs pacman -Qo 2>/dev/null || true)"
  packages="$(printf '%s\n' "$owners" | sed -n 's/^.* is owned by \([^ ]*\) .*$/\1/p' | sort -u)"
  [ -n "$packages" ] || die "pacman could not name the packages of the bundled files"
  {
    printf 'Bundled packages\n================\n\n'
    # shellcheck disable=SC2086 # one word per package
    pacman -Qi $packages | awk '
      /^Name +: /     { name = $3 }
      /^Version +: /  { version = $3 }
      /^URL +: /      { sub(/^URL +: /, ""); url = $0 }
      /^Licenses +: / { sub(/^Licenses +: /, ""); license = $0 }
      /^$/ && name    { printf "%s %s\n  License: %s\n  Upstream: %s\n", name, version, license, url; name = "" }
      END { if (name) printf "%s %s\n  License: %s\n  Upstream: %s\n", name, version, license, url }'
    # Libraries, loaders and helpers by name; the icons and data under share/
    # come from the icon-theme and GTK packages above.
    printf '\nLibraries\n=========\n\n'
    printf '%s\n' "$owners" | sed -n "s|^$prefix/\(bin/[^ ]*\|lib/[^ ]*\) is owned by \([^ ]*\) .*\$|\1 (\2)|p"
    printf '\nLicense texts\n=============\n'
    # shellcheck disable=SC2086 # one word per package
    pacman -Ql $packages | { grep '/share/licenses/.*[^/]$' || true; } | while read -r package text; do
      printf '\n----- %s: %s -----\n\n' "$package" "${text#"$prefix"/share/licenses/}"
      cat "$text"
    done
  } >> "$notices"
else
  note "pacman is not available: NOTICES.txt lists the bundled files without their packages and licenses"
  printf 'Files\n=====\n\n%s\n' "$bundled" >> "$notices"
fi

# --- archives ----------------------------------------------------------------

mkdir -p "$out"
out_abs="$(cd "$out" && pwd)"
zip_name="AgentRelay-$version-Windows-$arch.zip"
rm -f "$out_abs/$zip_name"
( cd "$out_abs" && zip -qr -9 "$zip_name" "$name" )
checksum "$out_abs" "$zip_name"

# The bare core, as the Linux and macOS probe archives lay it out
# (agent_relay/helpers/agent-relay-probe, here with .exe), with the DLLs it
# needs beside it.
probe_name="AgentRelay-$version-Windows-$arch-probe.zip"
helpers="$work/probe/agent_relay/helpers"
mkdir -p "$helpers"
cp "$probe" "$helpers/agent-relay-probe.exe"
cp "$repo/LICENSE" "$work/probe/agent_relay/LICENSE.txt"
copy_closure "$helpers" "$helpers/agent-relay-probe.exe"
rm -f "$out_abs/$probe_name"
( cd "$work/probe" && zip -qr -9 "$out_abs/$probe_name" agent_relay )
checksum "$out_abs" "$probe_name"

# --- the installer -----------------------------------------------------------

# A per-user Setup program that installs the tree where the zip goes,
# %LOCALAPPDATA%\Programs\AgentRelay\<version>\<tree>, so in-app updates keep
# working after it.
setup_name="AgentRelay-$version-Windows-$arch-Setup.exe"
packages="$zip_name, $probe_name"
if [ -n "$iscc" ]; then
  note "building $setup_name with $(cygpath -w "$iscc")"
  rm -f "$out_abs/$setup_name"
  # ISCC's options start with /, which MSYS2 would otherwise rewrite as paths.
  MSYS2_ARG_CONV_EXCL='*' "$iscc" /Q \
    "/DVersion=$version" "/DArch=$arch" \
    "/DSourceDir=$(cygpath -w "$(cd "$root" && pwd)")" \
    "/DOutputDir=$(cygpath -w "$out_abs")" \
    "$(cygpath -w "$repo/windows/installer/AgentRelay.iss")"
  [ -f "$out_abs/$setup_name" ] || die "ISCC did not write $setup_name"
  checksum "$out_abs" "$setup_name"
  packages="$packages, $setup_name"
elif [ "$installer" = "auto" ]; then
  note "Inno Setup 6 (ISCC.exe) was not found: no $setup_name"
fi

note "$(find "$root/bin" -name '*.dll' | wc -l) DLLs bundled; $(du -sh "$root" | cut -f1) unpacked, $(du -h "$out_abs/$zip_name" | cut -f1) zipped"
note "Windows package ready in $out: $packages"
