//! The relay core: the desktop's non-UI runtime, served to the macOS and
//! Linux apps by `agent-relay-probe relay serve` over one bridge contract.
//! See `docs/relay-core.md`.
//!
//! | Module | Owns |
//! |---|---|
//! | `protocol` | The bridge wire format: JSON-RPC envelopes, events, errors, `BRIDGE_VERSION` |
//! | `contract` | The method and topic registry with every params, result and event type; Swift code generation |
//! | `server` | The socket server: peer checks, handshake, dispatch, event forwarding |
//! | `daemon` | `relay serve`: single-instance lock, socket lifecycle, the `Core`, shutdown |
//! | `detach` | Starting a process in a process session of its own |
//! | `state` | The status snapshot and the event hub |
//! | `paths` | Socket and lock locations |
//! | `peer` | Kernel peer credentials; Windows uids from user SIDs |
//! | `transport` | The local stream every socket runs on: Unix sockets, Windows named pipes |
//! | `workspace` | Relaycast workspace discovery and origin validation |
//! | `app_store` | The app data directory and the store's workspace fields |
//! | `machine` | The machine address prefix |
//! | `client` | Relaycast clients over the `relaycast` SDK |
//! | `sdk_gaps` | The Relaycast surface the SDK does not yet cover |
//! | `push` | Per-agent direct node sockets |
//! | `cli` | `relay call`, a one-shot bridge client |
//! | `store` | The agent store: format, migration, three-way merge, the file |
//! | `agents` | Registration, rename, removal, webhooks, test messages, settings |
//! | `delivery` | Inbound delivery: policy, injected text, ack/fail, final answers |
//! | `files` | Message attachments: saving what a delivery carries, uploading what a session sends |
//! | `inject` | The `Injector` trait: the session side of delivery |
//! | `sessions` | The `SessionDirectory` trait: sessions on this computer |
//! | `cloud_session` | The `CloudAccess` trait; Cloud session calls: refresh, handoff exchange, revoke, whoami, workspace resolve; where the session is kept |
//! | `cloud_http` | One redirect-free, bounded JSON request to Cloud |
//! | `cloud_login` | Browser (loopback + PKCE) and device sign-in |
//! | `account` | Sign-in, the kept session, the account workspace, sign-out; the daemon's `CloudAccess` |
//! | `uploader` | The probe's own capture and upload: its commands, status stages, supervision |
//! | `probe_copy` | The command-line copy of the probe in `~/.local/bin`, only ever upgraded |
//! | `account_methods` | The bridge methods for the account, uploader, Skip chat, contractor access, telemetry, launch at login |
//! | `cloud_chat` | Skip chat: requests, the saved conversation and project view, pushes |
//! | `messaging` | Messaging as the signed-in person; exact-address proof |
//! | `people` | Workspace members and the agent roster |
//! | `contractor_access` | Owner grants of scoped service access to contractor seats; a contractor's own grant |
//! | `integrations` | relayfile subscriptions |
//! | `links` | Message endpoints and deep links |
//! | `telemetry` | PostHog operation telemetry: opt-out, identity, rate limits, the send queue |
//! | `login_item` | Linux launch at login: the XDG autostart entry |
//! | `methods` | The bridge methods for agents, messaging, people, links, settings |
//! | `process` | The kernel's process table and the Codex caller rules |
//! | `codex` | Codex threads: discovery, liveness, the routes into a thread, final answers |
//! | `claude` | Claude Code sessions: registry, peer inbox, Claude app sessions, final answers, the optional SessionStart hook |
//! | `claude_settings` | Claude Code's `crossSessionInbound` (`direct_delivery`) |
//! | `claude_delivery_policy` | Claude Code per-session and per-sender consent, held approvals |
//! | `fleet` | Fleet workers: broker discovery, `/api/spawned`, `fleet.list` and `fleet.release` |
//! | `local` | This computer's `SessionDirectory` and `Injector`, and the plugins `relay serve` runs with |
//! | `local_methods` | `sessions.list`, `fleet.*`, and the sessions/fleet watcher |
//! | `outbound` | The relay-send socket: sessions send, list, register and run setup |
//! | `setup` | Agent-led setup routes and defaults |
//! | `outbox` | Incoming cloud messages: outboxes, delivery workers, sharing policy, inboxes |
//! | `spawn` | The spawn node: Agent Relay starting Codex and Claude headless on this computer |

pub mod account;
pub mod account_methods;
pub mod agents;
pub mod app_store;
pub mod backoff;
pub mod claude;
pub mod claude_delivery_policy;
pub mod claude_dirs;
pub mod claude_keychain;
pub mod claude_settings;
pub mod cli;
pub mod client;
pub mod cloud_chat;
pub mod cloud_http;
pub mod cloud_login;
pub mod cloud_session;
pub mod codex;
pub mod conductor;
pub mod connect;
mod connect_lifetime;
pub mod connect_presence;
pub mod contract;
pub mod contractor_access;
pub mod daemon;
pub mod delivery;
pub mod desktop_identity;
pub(crate) mod detach;
pub mod devin;
pub mod devin_cloud;
pub mod diagnostic_http;
pub(crate) mod diagnostics;
pub mod existing_session;
pub mod files;
pub mod fleet;
pub mod grok;
pub mod harness;
pub mod harness_setup;
pub mod hermes;
pub mod hosted_mcp;
pub mod incoming;
pub mod inject;
pub mod integrations;
pub mod links;
pub mod local;
pub mod local_methods;
pub mod login_item;
pub mod machine;
pub mod mailbox;
pub mod managed_sessions;
pub mod message_pointer;
pub mod messaging;
pub mod methods;
pub mod muse;
pub mod openclaw;
pub mod opencode;
pub mod opencode_existing;
pub mod opencode_serve;
pub mod outbound;
pub mod outbox;
pub mod paseo;
pub mod paths;
pub mod peer;
pub mod people;
pub mod pi;
pub mod probe_copy;
pub mod process;
pub mod project;
pub mod protocol;
pub mod push;
pub mod quota;
pub mod relay_uploads;
pub mod request_log;
pub mod sdk_gaps;
pub mod server;
pub mod sessions;
pub mod session_titles;
pub mod settings_cli;
pub mod settings_registry;
pub mod settings_watch;
pub mod setup;
pub mod spawn;
pub mod state;
pub mod store;
pub mod store_settings;
pub mod telemetry;
pub mod transport;
pub mod trusted;
pub mod uploader;
pub mod workspace;
