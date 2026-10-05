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

This filesystem check does not validate token expiry. Muse device-login and
composer screen detection still require verified terminal captures; this change
does not yet prevent a present-but-expired login from reaching the existing
readiness heuristic. A worker that explicitly reports `provider_auth_required`
during verified startup is released through the normal failed-spawn cleanup,
and the fleet action receives that specific reason.
