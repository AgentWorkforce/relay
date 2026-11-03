//! The route Agent Relay's Codex hook asks (`codex::stop_hook`):
//!
//! ```text
//! POST /codex/stop-hook   {"session_id", "turn_id", "hook_event_name", "stop_hook_active"}
//! ```
//!
//! At SessionStart it answers with the session's Agent Relay preamble
//! (`hosted_mcp::codex_preamble`); after a tool call and at a stop, with the
//! next relayed message for the running turn.

use super::{Outbound, OutboundError};
use crate::relay::sessions::DiscoveredSession;
use crate::relay::store::{SessionKind, Target};
use serde_json::{json, Map, Value};
use std::time::Duration;

/// The Codex hook event that starts a session (startup, resume, clear,
/// compact or fork), as Codex names it in the hook's input.
const SESSION_START: &str = "SessionStart";

/// How long a starting session that the core is putting on the relay by
/// itself waits for its registration, so the preamble can name it. The
/// hook's own client waits longer for a SessionStart answer
/// (`cli::codex_stop_hook`).
const JOIN_WAIT: Duration = Duration::from_secs(5);

/// How often that wait looks again.
const JOIN_POLL: Duration = Duration::from_millis(250);

fn registration_context(socket: &std::path::Path) -> Option<Value> {
    let command = super::super::probe_socket_command_with_body(
        socket,
        "POST",
        "/register",
        r#"{"name":"NAME","mcp":"agent-relay-sessions"}"#,
    )?;
    let whoami = super::super::hints::probe_session_command(
        socket,
        &crate::relay::session_cli::SessionCommand::Whoami,
        None,
    )?;
    Some(json!({"hookSpecificOutput": {
        "hookEventName": "PostToolUse",
        "additionalContext": format!(
            "This Codex chat is not registered with Agent Relay Desktop. Hosted Relay tools cannot join or send as this chat until its desktop identity is registered. If the person asks to join or register, use their chosen name; if they have not authorized joining, ask first and do not register automatically. First check {whoami}; if already registered, use that identity. Otherwise replace NAME in {command} with the approved name and run it from this chat's own terminal. The absolute helper path works without a CLI on PATH. This registers only this chat and includes its conversation in the workspace's uploads; it does not change other sessions' sharing. After successful registration, retry hosted join_relay without name or description: the name comes from the verified desktop identity. Normal command approval still applies. Never run this from a separate terminal or substitute another chat ID."
        )
    }}))
}

impl Outbound {
    /// Agent Relay's Codex hook (`codex::stop_hook`), from a Codex turn after
    /// a tool call (PostToolUse) or as it ends (Stop): the next relayed
    /// message waiting for that turn (`codex::turn_hook`), or at a stop for
    /// that thread's Conductor chat, else a recap of those delivered while
    /// the chat was idle, else `{}`. Only a hook below the Codex that holds
    /// the thread's writer lock gets its messages; one for a thread nothing
    /// waits for is answered before the slower check, so a tool call is not
    /// held up.
    pub(super) async fn codex_stop_hook(
        &self,
        pid: i32,
        uid: u32,
        fields: &Map<String, Value>,
    ) -> Result<Value, OutboundError> {
        use crate::relay::codex::turn_hook::HookEvent;
        if uid != self.uid {
            return Err(OutboundError::not_this_user());
        }
        let Some(inbox) = self.core.plugins.codex_stop_hook.clone() else {
            return Ok(json!({}));
        };
        let thread = fields
            .get("session_id")
            .and_then(Value::as_str)
            .map(str::to_lowercase)
            .filter(|thread| crate::relay::store::is_uuid(thread))
            .ok_or_else(|| {
                OutboundError::new(
                    400,
                    "invalid_session_id",
                    "session_id must be a Codex thread id.",
                )
            })?;
        let event_name = fields.get("hook_event_name").and_then(Value::as_str);
        if event_name == Some(SESSION_START) {
            let cwd = fields
                .get("cwd")
                .and_then(Value::as_str)
                .filter(|cwd| std::path::Path::new(cwd).is_absolute())
                .map(str::to_string);
            return self.codex_session_start(pid, thread, cwd).await;
        }
        let Some(event) = HookEvent::named(event_name) else {
            return Ok(json!({}));
        };
        let target = crate::relay::store::Target::new(SessionKind::Codex, thread.clone());
        let guidance = (event == HookEvent::PostToolUse
            && inbox.is_ready()
            && self.core.workspace().is_some()
            && self.core.allows_self_registration()
            && self
                .core
                .store
                .read(|store| store.registration_for(&target).is_none())
            && inbox.needs_registration_guidance(&thread))
        .then(|| {
            self.core
                .plugins
                .relay_send
                .as_ref()
                .and_then(|send| registration_context(&send.socket))
        })
        .flatten();
        if event == HookEvent::PostToolUse
            && !inbox.turns().has_offered(&thread)
            && guidance.is_none()
        {
            return Ok(json!({}));
        }
        let stop_hook_active = fields
            .get("stop_hook_active")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let turn = fields
            .get("turn_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let directory = self.core.plugins.sessions.clone();
        let injector = self.core.plugins.injector.clone();
        tokio::task::spawn_blocking(move || {
            if !directory.holds_codex_thread(pid, &thread) {
                return Err(OutboundError::not_a_session());
            }
            if event == HookEvent::PostToolUse {
                if let Some(guidance) = guidance {
                    if inbox.take_registration_guidance(&thread) {
                        return Ok(guidance);
                    }
                }
                return Ok(inbox.turns().answer(&thread, event));
            }
            let target = crate::relay::store::Target::new(SessionKind::Codex, thread.clone());
            let shown = !turn.is_empty() && !injector.relay_started_turn(&target, &turn);
            let conductor = inbox.answer(
                &thread,
                stop_hook_active,
                shown,
                &|message_ref| injector.codex_recorded(&target, message_ref),
                &|message_ref| injector.final_answer(&target, message_ref),
            );
            if conductor != json!({}) {
                return Ok(conductor);
            }
            Ok(inbox.turns().answer(&thread, event))
        })
        .await
        .unwrap_or_else(|_| Ok(json!({})))
    }

    /// Agent Relay's Codex hook at SessionStart: the session's Agent Relay
    /// preamble as `additionalContext`, which Codex adds to the session once
    /// as it starts (and again after a resume, clear or compaction, when the
    /// earlier context is gone), never on every prompt. Only a session on the
    /// relay, or one the core is putting there by itself, is told anything;
    /// for the rest, and whenever the socket's commands cannot be named,
    /// the answer is `{}`. Like the turn hook, only a hook below the Codex
    /// that holds the thread's writer lock is answered.
    ///
    /// A session starts before the core's next pass would put it on the
    /// relay, so for one that activation admits the pass runs now, and the
    /// answer waits briefly for its name. `cwd` is the folder Codex names in
    /// the hook's input, which activation checks when the directory does
    /// not know the thread yet.
    async fn codex_session_start(
        &self,
        pid: i32,
        thread: String,
        cwd: Option<String>,
    ) -> Result<Value, OutboundError> {
        let directory = self.core.plugins.sessions.clone();
        let session = tokio::task::spawn_blocking(move || {
            if !directory.holds_codex_thread(pid, &thread) {
                return None;
            }
            let target = Target::new(SessionKind::Codex, thread);
            // The session as the directory names it (its folder decides
            // whether activation admits it), else the thread alone.
            Some(match directory.caller(pid) {
                Ok(session) if session.target == target && session.directory.is_some() => session,
                _ => DiscoveredSession {
                    target,
                    title: "Codex session".into(),
                    directory: cwd,
                    updated_at_ms: None,
                    host: None,
                    live: true,
                    holder: None,
                },
            })
        })
        .await
        .ok()
        .flatten()
        .ok_or_else(OutboundError::not_a_session)?;
        let Some(commands) = self.codex_socket_commands() else {
            return Ok(json!({}));
        };
        // Its one current name, as `GET /whoami` and its sends use: the
        // alias once the session renamed itself.
        let registered = || {
            self.core.store.read(|store| {
                store.registration_for(&session.target).map(|r| {
                    (
                        r.display_name().to_string(),
                        r.current_address(&self.core.machine_prefix),
                    )
                })
            })
        };
        let mut identity = registered();
        if identity.is_none() {
            if !self.setup.auto_activates(&session).await {
                return Ok(json!({}));
            }
            // The pass that puts it on the relay, now rather than at the
            // next poll. It goes on by itself if the answer stops waiting.
            let core = self.core.clone();
            tokio::spawn(async move { core.activate_new_sessions().await });
            let deadline = tokio::time::Instant::now() + JOIN_WAIT;
            while identity.is_none() && tokio::time::Instant::now() < deadline {
                tokio::time::sleep(JOIN_POLL).await;
                identity = registered();
            }
        }
        let text = crate::relay::hosted_mcp::codex_preamble(
            identity
                .as_ref()
                .map(|(name, address)| (name.as_str(), address.as_str())),
            &commands,
        );
        Ok(json!({"hookSpecificOutput": {
            "hookEventName": SESSION_START,
            "additionalContext": text,
        }}))
    }

    /// The probe commands on this core's serving session socket, naming the
    /// space-free link to the probe while the core keeps one (`probe_alias`).
    fn codex_socket_commands(&self) -> Option<crate::relay::hosted_mcp::CodexSocketCommands> {
        let socket = self.core.plugins.relay_send.as_ref()?.serving.get()?;
        crate::relay::hosted_mcp::CodexSocketCommands::for_probe(
            &super::super::fetch::probe_executable()?,
            &socket,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::{
        codex::stop_hook::StopHookInbox,
        daemon::{Config, Core, Plugins},
        delivery::DeliveryTiming,
        outbound::{Outbound, RelaySend, ServingPath},
        paths::CorePaths,
        push::PushTiming,
        sessions::{DiscoveredSession, SessionDirectory},
        setup::DirectDelivery,
        workspace::{Secret, Workspace},
    };
    use std::{collections::BTreeMap, sync::Arc, time::Duration};

    const THREAD: &str = "550e8400-e29b-41d4-a716-446655440000";
    struct Sessions;
    impl SessionDirectory for Sessions {
        fn sessions(&self) -> Vec<DiscoveredSession> {
            Vec::new()
        }
        fn holds_codex_thread(&self, pid: i32, thread: &str) -> bool {
            pid == 42 && thread == THREAD
        }
    }
    struct Direct;
    impl DirectDelivery for Direct {
        fn delivers_directly(&self) -> bool {
            true
        }
        fn managed_value(&self) -> Option<String> {
            None
        }
        fn user_choice(&self) -> Option<String> {
            None
        }
        fn set_direct_delivery(&self, _: bool) -> Result<(), String> {
            Ok(())
        }
    }
    fn fixture() -> (tempfile::TempDir, Outbound, Arc<StopHookInbox>) {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().to_path_buf();
        let config = Config {
            paths: CorePaths::for_socket(home.join("core.sock")).unwrap(),
            home: home.clone(),
            app_data_dir: home.join("data"),
            env: BTreeMap::new(),
            version: "test".into(),
            host_name: "Test Desk".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: PushTiming::default(),
            delivery_timing: DeliveryTiming::default(),
        };
        let inbox = Arc::new(StopHookInbox::default());
        inbox.set_ready(true);
        let direct = Arc::new(Direct);
        let plugins = Plugins {
            sessions: Arc::new(Sessions),
            codex_stop_hook: Some(inbox.clone()),
            relay_send: Some(RelaySend {
                socket: home.join("relay.sock"),
                pointer: home.join("pointer"),
                direct_delivery: direct.clone(),
                serving: ServingPath::default(),
                agent_led_defaults_at_start: false,
            }),
            ..Plugins::default()
        };
        let (core, _) = Core::with_plugins(config, plugins);
        *core.workspace.lock().unwrap() = Some(Workspace {
            key: Secret::new("rk_live_fixture"),
            base_url: "https://cast.test".into(),
            workspace_id: Some("workspace".into()),
            source: crate::relay::workspace::WorkspaceSource::Cloud,
        });
        (temp, Outbound::new(core, direct), inbox)
    }
    fn fields() -> Map<String, Value> {
        json!({"session_id": THREAD, "hook_event_name":"PostToolUse"})
            .as_object()
            .unwrap()
            .clone()
    }

    #[tokio::test]
    async fn verified_unregistered_codex_gets_one_registration_command_without_joining() {
        let (_temp, outbound, _) = fixture();
        let answer = outbound
            .codex_stop_hook(42, outbound.uid, &fields())
            .await
            .unwrap();
        let context = answer["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap();
        assert!(context.contains("socket-request"));
        assert!(context.contains("--path /register"));
        assert!(context.contains("NAME"));
        assert!(context.contains("ask first"));
        assert!(context.contains("retry hosted join_relay without name"));
        assert!(outbound
            .core
            .store
            .read(|store| store.registrations.is_empty()));
        assert_eq!(
            outbound
                .codex_stop_hook(42, outbound.uid, &fields())
                .await
                .unwrap(),
            json!({})
        );
    }

    #[tokio::test]
    async fn forged_thread_cannot_get_or_consume_registration_guidance() {
        let (_temp, outbound, inbox) = fixture();
        assert!(outbound
            .codex_stop_hook(99, outbound.uid, &fields())
            .await
            .is_err());
        assert!(inbox.needs_registration_guidance(THREAD));
        let mut forged = fields();
        forged.insert(
            "session_id".into(),
            json!("550e8400-e29b-41d4-a716-446655440001"),
        );
        assert!(outbound
            .codex_stop_hook(42, outbound.uid, &forged)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn an_already_registered_chat_is_not_prompted_to_register_again() {
        let (_temp, outbound, inbox) = fixture();
        let registration = serde_json::from_value(json!({
            "name":"codex-api", "agentID":"agent-1",
            "target":{"kind":"codex", "id":THREAD}, "title":"API",
            "baseURL":"https://cast.test", "registeredAt":"2026-11-02T00:00:00Z"
        }))
        .unwrap();
        outbound
            .core
            .store
            .update(|store| {
                assert!(store.add(registration, Secret::new("fixture-only")));
            })
            .unwrap();
        assert_eq!(
            outbound
                .codex_stop_hook(42, outbound.uid, &fields())
                .await
                .unwrap(),
            json!({})
        );
        assert!(inbox.needs_registration_guidance(THREAD));
    }

    #[tokio::test]
    async fn disabled_hook_or_self_registration_or_signed_out_core_offers_no_command() {
        let (_temp, outbound, inbox) = fixture();
        inbox.set_ready(false);
        assert_eq!(
            outbound
                .codex_stop_hook(42, outbound.uid, &fields())
                .await
                .unwrap(),
            json!({})
        );
        inbox.set_ready(true);
        outbound
            .core
            .store
            .update(|store| store.allow_self_registration = Some(false))
            .unwrap();
        assert_eq!(
            outbound
                .codex_stop_hook(42, outbound.uid, &fields())
                .await
                .unwrap(),
            json!({})
        );
        outbound
            .core
            .store
            .update(|store| store.allow_self_registration = Some(true))
            .unwrap();
        *outbound.core.workspace.lock().unwrap() = None;
        assert_eq!(
            outbound
                .codex_stop_hook(42, outbound.uid, &fields())
                .await
                .unwrap(),
            json!({})
        );
    }
}
