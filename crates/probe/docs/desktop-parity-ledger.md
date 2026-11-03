# Desktop parity ledger

Relay's core (`crates/probe`) must be a superset of relay-desktop's former
in-repo core (`probe/`, last at relay-desktop `644f931a`) before relay-desktop
drops its copy and pins this crate. #2057 three-way merged each file against
the desktop snapshot `5601b739` and kept relay's side where both had changed,
which dropped some desktop changes made before the split. #2060 restores them.

## Method

1. Every Rust file under desktop `probe/src` and `probe/tests` (678) was compared
   with relay's, both formatted with rustfmt and with `cfg(feature = ...)` lines
   ignored: **516 identical**, and 162 differing as listed below
   (desktop-only / relay-only line counts).
2. Every desktop test was matched by name and body. All 3,649 are in relay or
   relay-desktop's desktop-core, except where noted below. The 132 shared tests
   whose bodies differ were read one by one. Most differ by formatting, the
   internal-name sweep, or added relay assertions. The rest were ported.
3. Each desktop commit since `5601b739` was checked for added and removed lines
   that relay lacks.

## Restored desktop behaviors (each with a test)

| Behavior | Desktop commit | Test |
| --- | --- | --- |
| `relay serve --headless` keeps the app's Open-at-login entry | d23664e2 | `the_headless_service_preserves_the_apps_login_entry_and_stops_on_sigterm`, `the_binary_serves_answers_calls_and_stops_with_its_host` |
| Devin reviews are never listed, activated, or recreated as offline rows | 27854327, aa893455 | `discover_skips_sessions_an_automation_started`, `automation_classification_wins_across_installs_in_either_order`, `a_devin_review_session_is_never_listed_or_auto_activated`, `a_registered_devin_review_is_not_recreated_as_an_offline_session` |
| Grok usage records do not become empty transcript messages | fc84dd6e | `grok_usage_records_do_not_become_empty_messages_and_pagination_keeps_progress` |
| Presentation discovery runs on a fixed cadence; reads never start a pass | 96ebd2c5 | `warm_session_reads_do_not_repeat_live_discovery` (tests/relay_agents.rs) |
| The desktop's automatic-activation default (on unless turned off) | a37b11a3, 7373df8b | `the_desktop_account_turns_automatic_activation_on_unless_turned_off` |

The activation default is a hook, not relay's default:
`AccountPlugin::auto_activate_by_default` is false in relay, so the CLI's core
leaves `auto_activate` unset. desktop-core's account answers true, so an unset
setting becomes on at start and an explicit Off is kept. Open Pi, Oh My Pi and
OpenCode sessions join only with their own opt-ins (`pi_auto_activate`,
`opencode_auto_activate`), which matches the desktop: its core never activated
those kinds by itself.

## Relay-only, kept on purpose

- The broker, fleet and `relay-cli` pieces desktop removed in 27d4b2e0 (fleet
  methods, fleet-owned filtering and authority slot, CLI workspace sources,
  official CLI session reuse, `ar_` keys, `cli_managed`).
- #2057's reviewed retry rule for `permission_denied`: a block is retried
  after an update and once more at a later start, then stays until a new
  build (the desktop's c24c1706 retried it at every start).
- Relay's per-provider opt-ins for Pi and OpenCode activation, and Pi
  installation under `relay init`.

## Moved to relay-desktop's desktop-core

Browser sign-in (`BrowserLogin`), the provider-credentials test support, and
account, MCP and attestation code. See relay-desktop `docs/workspace-layout.md`.

## Per-file decisions (files that differ)

| File | Desktop-only / relay-only lines | Decision |
| --- | --- | --- |
| `src/bin/relay-contract-codegen.rs` | 7 / 25 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/cloud.rs` | 6 / 130 | equivalent; relay-only fleet/broker/relay-cli kept |
| `src/delivery.rs` | 30 / 4 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/delivery/retry.rs` | 1 / 8 | relay decision kept (#2057 review), see collector.rs (c24c1706) |
| `src/delivery_status.rs` | 2 / 34 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/delivery_status/inclusion.rs` | 1 / 12 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/delivery_status/status.rs` | 0 / 26 | relay-only additions (desktop content all present) |
| `src/destination.rs` | 2 / 37 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/install.rs` | 0 / 1 | relay-only additions (desktop content all present) |
| `src/lib.rs` | 0 / 4 | relay-only additions (desktop content all present) |
| `src/migration.rs` | 0 / 53 | relay-only additions (desktop content all present) |
| `src/probe/bridge.rs` | 22 / 51 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/probe/bridge/selection_validation.rs` | 2 / 8 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/probe/collector.rs` | 1 / 4 | relay decision kept (#2057 review): a `permission_denied` block retries after an update and once at a later start, not every start (c24c1706) |
| `src/probe/history/capture.rs` | 1 / 5 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/probe/mod.rs` | 9 / 20 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/probe/relay_commands.rs` | 2 / 6 | equivalent; relay-only fleet/broker/relay-cli kept |
| `src/probe/remote_sources.rs` | 2 / 2 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/probe/remote_sources/enumeration_schedule.rs` | 4 / 5 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/probe/remote_sources/pacing.rs` | 1 / 35 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/probe/remote_sources/pacing/unresolved.rs` | 3 / 58 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/probe/remote_sources/sweep.rs` | 2 / 14 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay.rs` | 0 / 1 | relay-only additions (desktop content all present) |
| `src/relay/activity.rs` | 2 / 10 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/agents.rs` | 23 / 252 | equivalent; relay-only fleet/broker/relay-cli kept |
| `src/relay/agents/activation_journal.rs` | 1 / 16 | equivalent; relay-only fleet/broker/relay-cli kept |
| `src/relay/agents/registration_routes.rs` | 0 / 55 | relay-only additions (desktop content all present) |
| `src/relay/agents/rejected_keys.rs` | 0 / 1 | relay-only additions (desktop content all present) |
| `src/relay/agents/rejected_keys_tests.rs` | 0 / 1 | relay-only additions (desktop content all present) |
| `src/relay/claude/app.rs` | 9 / 265 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/claude/session_hook.rs` | 4 / 38 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/claude/session_hook/output.rs` | 0 / 30 | relay-only additions (desktop content all present) |
| `src/relay/claude/session_hook/rollback.rs` | 2 / 8 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/claude_settings.rs` | 18 / 57 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/claude_web.rs` | 1 / 3 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/cli.rs` | 8 / 14 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/cli/socket_request.rs` | 5 / 3 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/cloud_login.rs` | 413 / 2 | moved: `BrowserLogin` lives in relay-desktop desktop-core (`browser_login.rs`) |
| `src/relay/cloud_session.rs` | 0 / 83 | relay-only additions (desktop content all present) |
| `src/relay/cloud_session/recovery.rs` | 1 / 18 | equivalent; relay-only fleet/broker/relay-cli kept |
| `src/relay/codex/processes.rs` | 4 / 12 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/codex/router.rs` | 1 / 1 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/codex/runner.rs` | 1 / 12 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/codex/stop_hook.rs` | 5 / 48 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/codex/stop_hook/inbox.rs` | 3 / 6 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/codex/stop_hook/rules.rs` | 1 / 2 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/codex/stop_hook/trust.rs` | 5 / 11 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/connect.rs` | 1 / 1 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/connect_presence.rs` | 2 / 9 | equivalent; relay-only fleet/broker/relay-cli kept |
| `src/relay/contract/agents/settings.rs` | 0 / 27 | relay-only additions (desktop content all present) |
| `src/relay/contract/codegen.rs` | 7 / 14 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/contract/directory.rs` | 0 / 6 | relay-only additions (desktop content all present) |
| `src/relay/contract/mod.rs` | 1 / 39 | equivalent; relay-only fleet/broker/relay-cli kept |
| `src/relay/contract/plan.rs` | 1 / 9 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/contract/reader.rs` | 2 / 17 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/cursor_cli.rs` | 0 / 10 | relay-only additions (desktop content all present) |
| `src/relay/cursor_cli/editor.rs` | 14 / 30 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/cursor_cli/editor_tests.rs` | 1 / 38 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/cursor_cli/settings.rs` | 9 / 28 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/cursor_cli/tests.rs` | 2 / 17 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/cursor_cli/wait.rs` | 3 / 22 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/cursor_cli/wait_tests.rs` | 0 / 48 | relay-only additions (desktop content all present) |
| `src/relay/daemon.rs` | 8 / 102 | ported (d23664e2): `relay serve --headless` keeps the app's login entry |
| `src/relay/daemon/plugins.rs` | 4 / 17 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/daemon/refresh.rs` | 1 / 6 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/delivery/activation.rs` | 8 / 14 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/delivery/channel/prompt.rs` | 3 / 8 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/delivery/policy.rs` | 12 / 16 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/delivery/stuck.rs` | 8 / 15 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/desktop_identity.rs` | 4 / 16 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/desktop_identity/native.rs` | 7 / 20 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/devin.rs` | 4 / 11 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/devin_cloud.rs` | 1 / 41 | ported (27854327, aa893455): Devin reviews never discovered; history gates kept |
| `src/relay/grok.rs` | 1 / 6 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/harness/codex.rs` | 21 / 11 | equivalent; relay-only fleet/broker/relay-cli kept |
| `src/relay/harness/codex/tests.rs` | 4 / 83 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/harness/devin/host.rs` | 1 / 1 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/harness/diagnostics.rs` | 1 / 10 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/harness/grok/tests.rs` | 1 / 1 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/harness/muse.rs` | 1 / 1 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/harness/opencode/detect.rs` | 2 / 40 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/harness/opencode/detect/tests.rs` | 0 / 54 | relay-only additions (desktop content all present) |
| `src/relay/hermes.rs` | 1 / 6 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/history_retention.rs` | 8 / 85 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/hosted_mcp.rs` | 0 / 126 | relay-only additions (desktop content all present) |
| `src/relay/integration_defaults.rs` | 0 / 6 | relay-only additions (desktop content all present) |
| `src/relay/local.rs` | 9 / 700 | equivalent; relay-only fleet/broker/relay-cli kept |
| `src/relay/local/connect_codex.rs` | 2 / 64 | equivalent; relay-only fleet/broker/relay-cli kept |
| `src/relay/local/directory_trait.rs` | 49 / 74 | ported (27854327): `hidden_sessions` for Devin reviews; relay keeps fleet filtering and `activation_check` |
| `src/relay/local/paths.rs` | 4 / 44 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/local/plugins.rs` | 3 / 63 | equivalent; relay-only fleet/broker/relay-cli kept |
| `src/relay/local/session_directory.rs` | 18 / 32 | equivalent; relay-only fleet/broker/relay-cli kept |
| `src/relay/local/tests/automatic_admission.rs` | 0 / 202 | ported (27854327) + activation-default hook test |
| `src/relay/local_methods.rs` | 17 / 72 | ported (96ebd2c5): reads no longer request a pass; relay keeps fleet methods |
| `src/relay/local_methods/discovery.rs` | 14 / 39 | ported (96ebd2c5): fixed cadence, reads never start a pass; relay keeps the fleet-authority slot |
| `src/relay/local_methods/discovery/tests.rs` | 1 / 1 | ported (96ebd2c5): demand tests removed with demand |
| `src/relay/mailbox.rs` | 1 / 2 | equivalent; relay-only fleet/broker/relay-cli kept |
| `src/relay/mailbox/tests.rs` | 0 / 34 | relay-only additions (desktop content all present) |
| `src/relay/message_pointer.rs` | 8 / 3 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/messaging.rs` | 6 / 60 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/mobile_handoff/journal.rs` | 4 / 5 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/mobile_handoff/journal/tests.rs` | 3 / 7 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/muse.rs` | 2 / 2 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/openclaw/settings.rs` | 1 / 6 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/opencode.rs` | 1 / 6 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/opencode_existing/native_tests.rs` | 1 / 1 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/outbound.rs` | 1 / 36 | equivalent; relay-only fleet/broker/relay-cli kept |
| `src/relay/outbound/hooks/codex_stop.rs` | 3 / 90 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/outbound/mobile_handoff.rs` | 6 / 5 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/outbound/socket_path.rs` | 4 / 6 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/pi.rs` | 3 / 135 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/pi/config.rs` | 4 / 56 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/pi/setup.rs` | 15 / 156 | equivalent; relay-only fleet/broker/relay-cli kept |
| `src/relay/process.rs` | 2 / 2 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/process/fake.rs` | 1 / 1 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/process/linux.rs` | 4 / 18 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/project.rs` | 2 / 2 | equivalent; relay-only fleet/broker/relay-cli kept |
| `src/relay/protocol.rs` | 0 / 15 | relay-only additions (desktop content all present) |
| `src/relay/relay_uploads.rs` | 3 / 4 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/request_log.rs` | 1 / 7 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/server.rs` | 0 / 11 | relay-only additions (desktop content all present) |
| `src/relay/session_titles/extra.rs` | 0 / 3 | relay-only additions (desktop content all present) |
| `src/relay/sessions.rs` | 0 / 8 | relay-only additions (desktop content all present) |
| `src/relay/settings_registry.rs` | 1 / 5 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/settings_watch.rs` | 0 / 3 | relay-only additions (desktop content all present) |
| `src/relay/setup.rs` | 1 / 31 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/setup/policy.rs` | 5 / 20 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/spawn.rs` | 0 / 1 | relay-only additions (desktop content all present) |
| `src/relay/spawn/control/tests.rs` | 0 / 1 | relay-only additions (desktop content all present) |
| `src/relay/spawn/settings.rs` | 2 / 154 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/spawn/tests/owner_framing.rs` | 7 / 7 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/state.rs` | 0 / 2 | relay-only additions (desktop content all present) |
| `src/relay/store/settings_extras.rs` | 0 / 30 | relay-only additions (desktop content all present) |
| `src/relay/store/tests.rs` | 10 / 2 | relay-only default kept (CLI: activation off until set); desktop default via `AccountPlugin::auto_activate_by_default` (a37b11a3, 7373df8b) |
| `src/relay/store_settings.rs` | 2 / 14 | relay-only default kept; desktop default via `AccountPlugin::auto_activate_by_default` (a37b11a3) |
| `src/relay/test_account.rs` | 0 / 5 | relay-only additions (desktop content all present) |
| `src/relay/transport.rs` | 0 / 1 | relay-only additions (desktop content all present) |
| `src/relay/trusted.rs` | 22 / 34 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/trusted/tests.rs` | 1 / 1 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/uploader.rs` | 2 / 84 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/uploader/query.rs` | 1 / 25 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/uploader/refresh.rs` | 2 / 8 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/uploader/refresh/lifecycle.rs` | 1 / 0 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/uploader/retrying.rs` | 2 / 2 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/uploader/session_mutations.rs` | 1 / 1 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/uploader/status_read.rs` | 0 / 11 | relay-only additions (desktop content all present) |
| `src/relay/websocket_tls.rs` | 19 / 98 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/relay/workspace.rs` | 4 / 228 | equivalent; relay-only fleet/broker/relay-cli kept |
| `src/session_model/agent_kind.rs` | 2 / 35 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/session_model/local_sessions.rs` | 2 / 4 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/session_model/session_query.rs` | 6 / 8 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `src/session_model/uploads.rs` | 0 / 11 | relay-only additions (desktop content all present) |
| `tests/build_metadata.rs` | 7 / 16 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `tests/build_retry.rs` | 0 / 20 | relay-only additions (desktop content all present) |
| `tests/core_boundary.rs` | 5 / 1 | equivalent: relay refactor, #2057/#2060 review fix or internal-name sweep |
| `tests/relay_agents.rs` | 19 / 25 | equivalent; relay-only fleet/broker/relay-cli kept |
| `tests/relay_contract.rs` | 2 / 9 | equivalent; relay-only fleet/broker/relay-cli kept |
| `tests/relay_core_binary.rs` | 0 / 27 | ported (d23664e2): login entry preserved; test restored |
| `tests/relay_outbound.rs` | 5 / 242 | equivalent; relay-only fleet/broker/relay-cli kept |
| `tests/support/bridge.rs` | 8 / 31 | equivalent; relay-only fleet/broker/relay-cli kept |
| `tests/support/outbound_harness.rs` | 0 / 6 | relay-only additions (desktop content all present) |
| `tests/support/provider_credentials.rs` | 58 / 0 | moved: relay-desktop desktop-core/tests/support |
