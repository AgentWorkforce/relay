//! The relay core: the messaging runtime `agent-relay-node serve` serves over
//! one bridge contract, to `relay init` and the desktop apps.
//! It finds the coding sessions on this computer, puts them on the relay,
//! delivers messages into them and sends theirs. What a build adds (an
//! account, session history, extra methods and sessions) it adds through
//! `daemon::plugins` and `session_sources`. See `docs/relay-core.md`.
//!
//! | Module | Owns |
//! |---|---|
//! | `protocol` | The bridge wire format: JSON-RPC envelopes, events, errors, `BRIDGE_VERSION` |
//! | `contract` | The method and topic registry with every params, result and event type; Swift code generation |
//! | `server` | The socket server: peer checks, handshake, dispatch, event forwarding |
//! | `daemon` | `serve`: single-instance lock, socket lifecycle, the `Core`, shutdown |
//! | `automatic_edit` | Renames and native titles a build makes on its own, applied only while still current |
//! | `session_sources` | What a build knows about sessions beyond this computer's discovery: remote sessions, Hermes homes |
//! | `admission` | Which discovered sessions join the relay by themselves: the build's session policy, or every one |
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
//! | `cli` | `call`, a one-shot bridge client |
//! | `store` | The agent store: format, migration, three-way merge, the file |
//! | `agents` | Registration, rename, removal, webhooks, test messages, settings |
//! | `delivery` | Inbound delivery: policy, injected text, ack/fail, final answers |
//! | `files` | Message attachments: saving what a delivery carries, uploading what a session sends |
//! | `inject` | The `Injector` trait: the session side of delivery |
//! | `sessions` | The `SessionDirectory` trait: sessions on this computer |
//! | `cloud_session` | The `CloudAccess` trait; session refresh and `whoami` |
//! | `cloud_http` | One redirect-free, bounded JSON request to Cloud |
//! | `cloud_login` | Device sign-in, for Relay Connect hosts (`connect create`); an account (sign-in, its bridge methods) is a plugin the core is built with (`daemon::plugins::AccountPlugin`) |
//! | `probe_alias` | The space-free link to the probe that Codex and Claude Code rules and reply hints name while their hooks are on |
//! | `messaging` | Messaging as the signed-in person; exact-address proof |
//! | `people` | Workspace members and the agent roster |
//! | `recipients` | Why a direct send's recipient was not an agent: candidates, a person, or nothing |
//! | `integrations` | relayfile subscriptions |
//! | `links` | Message endpoints and deep links |
//! | `usage` | What the core reports about its own operations to a build's account |
//! | `methods` | The bridge methods for agents, messaging, people, links, settings |
//! | `process` | The kernel's process table and the Codex caller rules |
//! | `codex` | Codex threads: discovery, liveness, the routes into a thread, final answers |
//! | `claude` | Claude Code sessions: registry, peer inbox, Claude app sessions, final answers, the optional SessionStart hook |
//! | `claude_settings` | Claude Code's `crossSessionInbound` (`direct_delivery`) |
//! | `claude_delivery_policy` | Claude Code per-session and per-sender consent, held approvals |
//! | `local` | This computer's `SessionDirectory` and `Injector`, and the plugins `serve` runs with |
//! | `fleet` | Fleet workers: broker discovery, `/api/spawned`, `fleet.list` and `fleet.release` |
//! | `local_methods` | `sessions.list` and the sessions watcher |
//! | `outbound` | The relay-send socket: sessions send, list, register and run setup |
//! | `setup` | Agent-led setup routes and defaults |
//! | `spawn` | The spawn node: Agent Relay starting Codex and Claude headless on this computer |

pub mod activity;
pub mod admission;
pub mod agents;
pub mod app_store;
pub mod automatic_edit;
pub mod backoff;
pub mod claude;
pub mod claude_delivery_policy;
pub mod claude_dirs;
pub mod claude_mobile_plugin;
pub mod claude_settings;
pub mod claude_web;
pub mod cli;
pub mod client;
pub mod cloud_http;
pub mod cloud_login;
pub mod cloud_session;
pub mod codex;
pub mod codex_mobile;
pub mod conductor;
pub mod connect;
mod connect_inbox;
mod connect_lifetime;
pub mod connect_presence;
pub mod contract;
pub mod copilot;
pub mod cursor_cli;
pub mod daemon;
pub mod delivery;
pub(crate) mod detach;
pub mod devin;
pub mod devin_cloud;
pub mod diagnostic_http;
pub mod diagnostics;
pub mod existing_session;
pub mod files;
pub mod fleet;
pub mod grok;
pub mod harness;
pub mod hermes;
pub mod hook_agents;
pub mod hosted_mcp;
pub mod inject;
pub mod integration_defaults;
pub mod integrations;
pub mod links;
pub mod local;
pub mod local_methods;
pub mod machine;
pub mod managed_sessions;
pub mod message_pointer;
pub mod messaging;
pub mod methods;
pub mod mobile_handoff;
mod mobile_permissions;
pub mod muse;
pub(crate) mod native_continuation;
pub mod openclaw;
pub mod opencode;
pub mod opencode_existing;
pub mod opencode_serve;
pub mod outbound;
pub mod paseo;
pub mod paths;
pub mod peer;
pub mod people;
pub mod pi;
pub mod plan;
pub mod probe_alias;
pub mod process;
pub mod project;
pub mod protocol;
pub mod push;
pub mod recipients;
pub mod request_log;
pub mod sdk_gaps;
pub mod server;
pub mod session_cli;
pub mod session_sources;
pub mod session_titles;
pub mod sessions;
pub mod settings_cli;
pub mod settings_registry;
pub mod settings_watch;
pub mod setup;
pub mod spawn;
pub mod state;
pub mod store;
pub mod store_settings;
#[doc(hidden)]
pub mod test_account;
pub mod transport;
pub mod trusted;
pub mod usage;
pub mod websocket_tls;
pub mod workspace;
