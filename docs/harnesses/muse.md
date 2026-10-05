# Muse on Fleet nodes

Log in by running `muse` on the enrolled node as the user running the broker.
Workers with Relay MCP provisioning share that user's Muse login while keeping
settings and per-worker Relay tokens in a separate config home.

The shared login path is resolved in this order:

1. An absolute `RELAY_MUSE_SHARED_AUTH_PATH`.
2. An absolute `MUSE_AUTH_PATH`.
3. `$XDG_CONFIG_HOME/muse/auth.json`.
4. `$HOME/.config/muse/auth.json` (`USERPROFILE` when `HOME` is unset).

Spawn environment precedence is `harnessConfig.env`, then the broker's worker
environment, then its inherited environment. The preflight uses the same order.
Without a provisioned clean home, Muse uses its own auth path and config home;
Relay's sharing and isolation overrides do not apply.

Verified fleet spawns check that the resolved login is a readable regular file
containing a non-empty JSON object. Symlinks to usable files are accepted. A
failure returns `provider_auth_required` with the path and login remediation
before worker registration. Unverified remote spawns log a warning and retain
their previous behavior. Auth contents are never included in this diagnostic.

`RELAY_MUSE_ISOLATED_AUTH=1` selects the per-worker login instead of the shared
login when a clean home is provisioned. A fresh isolated home has no login and
therefore fails a verified spawn's preflight. Unset the isolation override to
reuse the node's login.

The filesystem check does not validate token expiry, so a present-but-expired
login is caught at startup instead. Readiness for Muse is the visible prompt
alone: output volume is not accepted as proof, because the device-login screen
renders a prompt glyph and plenty of output while waiting on a human. A
recognised device-login screen is reported once as `provider_auth_required`,
which fails the verified spawn immediately and releases the worker through the
normal failed-spawn cleanup; the fleet action receives that specific reason. An
unrecognised screen still cannot report itself ready, so the spawn fails closed
on the readiness deadline instead.

Device-login detection keys on whole phrases that only an authentication
interstitial renders (`waiting for authentication`, `enter this code`,
`sign in to continue`, a `facebook.com/device` verification URL, and similar) —
never on bare words like `login` or `signed in`, which an authenticated
composer legitimately shows. The phrase list lives in
`detect_muse_device_auth_prompt` (`crates/relay-pty/src/terminal.rs`) and is
not derived from a captured Muse screen; extend it when one is captured. Device
codes and auth contents are never copied into logs or protocol frames.
