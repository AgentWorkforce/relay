# Run an Ubuntu server in your existing workspace

Use the Linux Agent Relay package when an always-on server should appear beside
an existing Mac in the same Cloud workspace and accept Claude Code or Codex
spawns. It runs as `agent-relay.service`, a systemd user service over SSH; no
desktop window, display server, local browser, or SSH port forwarding is required. The package includes
the account-aware core, even when you never open its desktop UI.

## Choose the right setup path

| Path                                                        | What it does                                                                                                                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux Agent Relay package + `agent-relay-probe relay setup` | Signs this machine into an existing Cloud workspace by device approval and runs the account-aware service. Use this for a server beside your Mac.                                     |
| npm CLI `agent-relay cloud login` + `cloud enroll`          | Saves a separate CLI login and fleet enrollment record. A returned node ID does not start a service or prove a live spawn target.                                                     |
| npm CLI `agent-relay init --hosted`                         | Can create a new hosted messaging workspace. It does not select your Desktop workspace just because both use the same account or the name “Default”.                                  |
| `agent-relay-node serve --headless`                         | Runs the standalone messaging core. It reads CLI workspace configuration and has no Cloud account sign-in plugin; it does not consume the Cloud fleet enrollment as an account login. |

In v18, `relay node up` and `relay fleet status` were removed with the local
broker. The older v18.0.0 enrollment output still recommends `node up`; that
is stale advice, corrected in newer CLI builds.
Do not use it as the next step, repeat enrollment, or create another workspace
to make the existing machine appear.

## 1. Install the Linux service

Run as the non-root Linux user who will run Claude Code and Codex. You need
`curl`, `ca-certificates`, and sudo access for the package installation and
lingering. On Ubuntu 24.04, use the `.deb` for your architecture. Download its
published checksum alongside it, and stop if verification fails. The script
uses the latest stable release; its checksum verifies download integrity. If
a release changes between the two downloads, rerun both. To repeat the verified
`2026.11.3` release, set `relay_release` to
`https://github.com/AgentWorkforce/relay-desktop-releases/releases/download/v2026.11.3`
in place of the `latest/download` URL below.

```sh
case "$(uname -m)" in
  x86_64|amd64) relay_arch=x64 ;;
  aarch64|arm64) relay_arch=arm64 ;;
  *) printf 'Unsupported Linux architecture\n' >&2; exit 2 ;;
esac
relay_tmp=$(mktemp -d)
chmod 700 "$relay_tmp"
relay_release=https://github.com/AgentWorkforce/relay-desktop-releases/releases/latest/download
curl -fL "$relay_release/AgentRelay-Linux-$relay_arch.deb" -o "$relay_tmp/AgentRelay-Linux-$relay_arch.deb" &&
curl -fL "$relay_release/AgentRelay-Linux-$relay_arch.deb.sha256" -o "$relay_tmp/AgentRelay-Linux-$relay_arch.deb.sha256" &&
(cd "$relay_tmp" && sha256sum --check "AgentRelay-Linux-$relay_arch.deb.sha256") &&
sudo apt-get install -y "$relay_tmp/AgentRelay-Linux-$relay_arch.deb"
```

Continue only after a successful install:

```sh
sudo loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable agent-relay.service
systemctl --user restart agent-relay.service
systemctl --user is-active agent-relay.service
loginctl show-user "$USER" -p Linger
```

Restarting loads the newly installed build even when an older service was
already active. Expect `active` and `Linger=yes`. Lingering keeps the user's service running
after SSH logout and starts it at boot. A user-bus error means the systemd user
session needs fixing; running the service as root would use a different home
and provider credentials.

The `.deb` installs GTK runtime dependencies even when no window is used.
For a minimal server, the release also offers a separate GTK-free probe archive
and headless installer; the commands here use the Debian-managed package.

## 2. Sign into the exact existing workspace

Use the Cloud workspace UUID for the workspace your Mac uses. Names such as
“Default” are not enough to establish that two machines share a workspace.
An existing npm CLI login can list accessible IDs with
`agent-relay cloud workspaces`; confirm the intended workspace with its owner.
That command's login is separate from the Linux service's login.

Linux stable `2026.11.3` uses the `relay setup` terminal wizard to sign in
without copying a key:

```sh
test -x /usr/lib/agent-relay/agent-relay-probe || {
  printf 'Agent Relay helper missing; check the Linux package installation.\n' >&2
  exit 1
}
/usr/lib/agent-relay/agent-relay-probe relay setup --workspace YOUR-CLOUD-WORKSPACE-UUID
```

Replace the placeholder with the intended Cloud workspace UUID. Open the
wizard's verification URL on your Mac or phone, approve its displayed device
code using the account with access to that workspace, then return to the SSH
terminal. Keep an existing sign-in only if it is for the intended workspace.
Choose providers and session sharing in the wizard; omitted options preserve
saved preferences. A fresh connection defaults to **Only sessions I choose**.
Sharing a session uploads it so teammates can read it; choose broader sharing
only when you want it.

Newer builds may list `setup` and `call` directly in the probe’s `--help`;
on those builds omit `relay` from the probe commands in this guide. If neither
form is available, update the Linux package from the download page.
`agent-relay-probe` is the account-aware package helper. It is different from
`agent-relay-node`, and from the separately installed npm `agent-relay` CLI.
The stable `2026.11.3` `.deb` installs the helper at the path above and the
app launcher as `/usr/bin/agent-relay-desktop`. Older packages used the CLI’s
`agent-relay` name for that launcher; use the full probe path to avoid confusion.

## 3. Verify spawning separately from sign-in

Install and authenticate Claude Code and Codex for the same Linux user running
the service. The service must be able to find their executables; a working
interactive shell alone does not prove the service has the same PATH.

For Relay’s `2026.11.3` integration, Codex also needs its app-server daemon: a
managed daemon package, its standalone install, or an existing control socket.
An older Codex installed only through npm or a version manager such as mise
can lack these and be missing from spawn targets. The diagnostic begins
“Codex here cannot start its app-server daemon”. If that is the cause, use the [official Codex standalone installer](https://learn.chatgpt.com/docs/codex/cli#getting-started)
for this Linux user. This is Relay’s version-specific discovery requirement;
npm remains a supported general Codex CLI installation method.

Spawning is on by default unless explicitly disabled. Check **Accept spawns
from Agent Relay** under **Settings → Messages → Spawned agents** if it was
turned off. Existing settings are preserved. The core setting is
`accept_spawns`; an agent can inspect it through the probe's `settings.get`
bridge call rather than requiring a desktop window. Workspace owners/admins
spawning on a teammate's machine also require that machine's teammate-spawn
opt-in (`spawn_allow_teammates`).

Read the local settings and spawn status without starting a model:

```sh
/usr/lib/agent-relay/agent-relay-probe relay call settings.get --json
/usr/lib/agent-relay/agent-relay-probe relay call status.get --json
```

From an authenticated Agent Relay session in that same workspace, refresh the
available spawn targets. Confirm this server offers `claude` and/or `codex`.
The core's spawn status reports `state: live`, `node_name`, and `harnesses`;
`error`, `claim`, and `plan_limit` explain why a machine cannot be offered.
The machine name comes from the running service, and need not match a previous
`cloud enroll --name` record.

Once the owner authorizes a test agent run, spawn a small task on the explicit
server target and confirm its response. Enrollment success, service liveness,
and a queued message receipt alone do not establish that a provider can run.
Do not start paid model work just to diagnose connectivity without approval.

## If the server still does not appear

- Confirm the Linux service and Mac use the same workspace UUID and account.
- Check `systemctl --user is-active agent-relay.service` and `Linger=yes`.
- Check provider installation, authentication, and the service's executable PATH.
- Inspect the spawn status for disabled spawning, connection errors, ownership,
  or device limits before trying another enrollment.
- Report the CLI version, Linux package version, architecture, service state,
  and redacted spawn status to support. Do not paste credentials or raw logs.

## Where is the workspace key for Default?

This Cloud setup does not require finding, exporting, or pasting an `ar_ws_…`
workspace key. Device approval authorizes the account-aware service for the
selected workspace. A workspace ID or enrolled node ID is not a workspace key.
`relay init --key` is a separate messaging-workspace join path for someone who
already holds that credential; it is not a way to retrieve Desktop's login.

If you require a server running **only** the npm CLI and standalone node,
without the Linux account-aware package, the v18 enrollment sequence above is
not a complete key-free path to the existing Desktop workspace. Report that
requirement to support rather than inventing a key-export step.
