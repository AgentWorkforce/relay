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

#[cfg(test)]
#[path = "codex_stop/affinity.rs"]
mod affinity;

/// Explain consent-based self-registration using this core's actual socket.
fn registration_context(socket: &std::path::Path) -> Option<Value> {
    let command = super::super::hints::probe_session_command(
        socket,
        &crate::relay::session_cli::SessionCommand::Register {
            name: Some("NAME".into()),
            description: None,
            mcp: Some(crate::relay::hosted_mcp::SERVER_NAME.into()),
        },
        None,
    )?;
    let whoami = super::super::hints::probe_session_command(
        socket,
        &crate::relay::session_cli::SessionCommand::Whoami,
        None,
    )?;
    Some(json!({"hookSpecificOutput": {
        "hookEventName": "PostToolUse",
        "additionalContext": format!(
            "This Codex chat is not registered with Agent Relay Desktop. Hosted Relay tools cannot join or send as this chat until its desktop identity is registered. If the person asks to join or register, use their chosen name; if they have not authorized joining, ask first and do not register automatically. First check {whoami}; if already registered, use that identity. Otherwise replace NAME in {command} with the approved name and run it from this chat's own terminal. The absolute helper path works without a CLI on PATH. This registers only this chat and includes its conversation in the workspace's uploads; it does not change other sessions' sharing. After successful registration, retry hosted join_relay without name or description: the name comes from the verified desktop identity. If hosted linking is unavailable or refused, keep this locally registered identity and use the local session commands; never join under a new hosted name or use another identity as a fallback. Normal command approval still applies. Never run this from a separate terminal or substitute another chat ID."
        )
    }}))
}

/// How long the question hook may take in all, from the request's
/// arrival: the hook client's own wait (`cli::QUESTION_HOOK_WAIT`).
const QUESTION_BUDGET: std::time::Duration = crate::relay::cli::QUESTION_HOOK_WAIT;

/// Time kept back for answering once the question was sent.
const QUESTION_MARGIN: std::time::Duration = std::time::Duration::from_secs(3);

/// Codex's PreToolUse answer for the question hook: refused with `reason`
/// once the question went to the inbox, so Codex tells the model instead
/// of showing the dialog; otherwise `{}`, which lets the tool run and the
/// dialog show (Codex 0.154, `hooks/src/events/pre_tool_use.rs`).
fn question_hook_answer(reason: Option<&str>) -> Value {
    match reason {
        Some(reason) => json!({"hookSpecificOutput": {
            "hookEventName": crate::relay::codex::stop_hook::QUESTION_EVENT,
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }}),
        None => json!({}),
    }
}

#[cfg(test)]
mod question_hook_tests {
    use super::*;

    #[test]
    fn only_a_sent_question_refuses_the_tool() {
        assert_eq!(question_hook_answer(None), json!({}));
        assert_eq!(
            question_hook_answer(Some("Sent to @triage.")),
            json!({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                "permissionDecision": "deny", "permissionDecisionReason": "Sent to @triage."}})
        );
    }
}

impl Outbound {
    /// Agent Relay's Codex hook (`codex::stop_hook`), from a Codex turn after
    /// a tool call (PostToolUse) or as it ends (Stop): the next relayed
    /// message waiting for that turn (`codex::turn_hook`), or at a stop for
    /// that thread's Conductor chat, else a recap of those delivered while
    /// the chat was idle, else `{}`. A hook must match the active turn in
    /// the requested thread's rollout held by its trusted Codex writer. A
    /// hook for a thread with nothing waiting is answered before the slower
    /// check, so a tool call is not held up.
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
        if event_name == Some("RelayIdentityReceipt") {
            let confirmed = fields
                .get("receipt")
                .and_then(Value::as_str)
                .is_some_and(|receipt| inbox.acknowledge_startup_identity(&thread, pid, receipt));
            return if confirmed {
                Ok(json!({}))
            } else {
                Err(OutboundError::not_a_session())
            };
        }
        if event_name == Some(SESSION_START) {
            let cwd = fields
                .get("cwd")
                .and_then(Value::as_str)
                .filter(|cwd| std::path::Path::new(cwd).is_absolute())
                .map(str::to_string);
            return self.codex_session_start(pid, thread, cwd).await;
        }
        if event_name == Some(crate::relay::codex::stop_hook::QUESTION_EVENT) {
            return self.codex_question_hook(pid, thread, fields).await;
        }
        let Some(event) = HookEvent::named(event_name) else {
            return Ok(json!({}));
        };
        let target = crate::relay::store::Target::new(SessionKind::Codex, thread.clone());
        let automatic = self.core.store.read(|s| s.auto_activate == Some(true));
        let identity = self.core.store.read(|s| {
            s.registration_for(&target).map(|r| {
                (
                    r.display_name().to_string(),
                    r.current_address(&self.core.machine_prefix),
                )
            })
        });
        let refresh = automatic && identity.is_none() && inbox.needs_discovery_refresh(&thread);
        let guidance = if event == HookEvent::PostToolUse {
            identity
                .as_ref()
                .filter(|(_, address)| inbox.needs_registered_identity(&thread, address))
                .and_then(|(name, address)| {
                    let commands = self.codex_socket_commands()?;
                    Some(json!({"hookSpecificOutput":{"hookEventName":"PostToolUse",
                    "additionalContext": crate::relay::hosted_mcp::codex_preamble(
                        Some((name.as_str(),address.as_str())), &commands)}}))
                })
        } else {
            None
        };
        let guidance = guidance.or_else(|| {
            (event == HookEvent::PostToolUse
                && identity.is_none()
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
            .flatten()
        });
        if event == HookEvent::PostToolUse
            && !inbox.turns().has_offered(&thread)
            && guidance.is_none()
            && !refresh
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
            .filter(|turn| !turn.is_empty())
            .ok_or_else(OutboundError::not_a_session)?
            .to_string();
        let directory = self.core.plugins.sessions.clone();
        let injector = self.core.plugins.injector.clone();
        let core = self.core.clone();
        tokio::task::spawn_blocking(move || {
            if !directory.codex_hook_turn_matches(pid, &thread, &turn) {
                return Err(OutboundError::not_a_session());
            }
            if refresh && inbox.take_discovery_refresh(&thread) {
                core.request_codex_discovery();
            }
            if event == HookEvent::PostToolUse {
                let mut answer = inbox.turns().answer(&thread, event);
                if let Some(guidance) = guidance {
                    let take = match identity.as_ref() {
                        Some((_, address)) => inbox.take_registered_identity(&thread, address),
                        None => inbox.take_registration_guidance(&thread),
                    };
                    if take {
                        if let Some(text) = answer
                            .pointer("/hookSpecificOutput/additionalContext")
                            .and_then(Value::as_str)
                        {
                            let mut combined = guidance;
                            if let Some(context) =
                                combined.pointer_mut("/hookSpecificOutput/additionalContext")
                            {
                                *context = json!(format!(
                                    "{}\n\n{text}",
                                    context.as_str().unwrap_or_default()
                                ));
                            }
                            answer = combined;
                        } else {
                            answer = guidance;
                        }
                    }
                }
                return Ok(answer);
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
            let answer = if conductor != json!({}) {
                conductor
            } else {
                inbox.turns().answer(&thread, event)
            };
            // The build's turn-end advisory (`TurnEndAdvisories`), once, on
            // a Stop that is not already continuing from a stop hook's block
            // and whose turn the person sees. The hook has no write
            // callback, so it is acknowledged as the answer is built.
            if stop_hook_active || !shown {
                return Ok(answer);
            }
            match core.take_turn_end_advisory(&target) {
                Some(advisory) => {
                    let merged = crate::relay::turn_end_advisories::merge_stop(
                        answer.clone(),
                        &advisory.text,
                    );
                    if merged != answer {
                        core.turn_end_advisory_shown(&target, &advisory.ids);
                    }
                    Ok(merged)
                }
                None => Ok(answer),
            }
        })
        .await
        .unwrap_or_else(|_| Ok(json!({})))
    }

    /// Agent Relay's Codex hook at PreToolUse, which `hooks.json` runs for
    /// `request_user_input` alone: with question escalation on, the question
    /// goes to the question inbox and the tool call is refused with the
    /// reason, so the session keeps working and the answer arrives as a
    /// message. Only the thread's running turn, held by the trusted Codex
    /// writer that called, is answered. Anything else (another tool, a
    /// session not on the relay, escalation off, input that does not parse,
    /// a question not sent within `question::ROUTE_LIMIT`) answers `{}`, and
    /// Codex shows the question as usual.
    async fn codex_question_hook(
        &self,
        pid: i32,
        thread: String,
        fields: &Map<String, Value>,
    ) -> Result<Value, OutboundError> {
        self.codex_question_hook_within(pid, thread, fields, QUESTION_BUDGET)
            .await
    }

    /// `codex_question_hook`, where the question may take `budget` in all
    /// from the request's arrival.
    async fn codex_question_hook_within(
        &self,
        pid: i32,
        thread: String,
        fields: &Map<String, Value>,
        budget: std::time::Duration,
    ) -> Result<Value, OutboundError> {
        let arrived = std::time::Instant::now();
        use crate::relay::codex::stop_hook::QUESTION_TOOL;
        if fields.get("tool_name").and_then(Value::as_str) != Some(QUESTION_TOOL) {
            return Ok(json!({}));
        }
        let Some(input) = fields.get("tool_input").filter(|input| input.is_object()) else {
            return Ok(json!({}));
        };
        // Off costs nothing: no caller check, no lookup, nothing sent.
        if !self.core.store.read(crate::relay::question::settings::on) {
            return Ok(json!({}));
        }
        let turn = fields
            .get("turn_id")
            .and_then(Value::as_str)
            .filter(|turn| !turn.is_empty())
            .ok_or_else(OutboundError::not_a_session)?
            .to_string();
        let directory = self.core.plugins.sessions.clone();
        let caller = thread.clone();
        let matches = tokio::task::spawn_blocking(move || {
            directory.codex_hook_turn_matches(pid, &caller, &turn)
        })
        .await
        .unwrap_or(false);
        if !matches {
            return Err(OutboundError::not_a_session());
        }
        let target = Target::new(SessionKind::Codex, thread);
        let Some(registration) = self
            .core
            .store
            .read(|store| store.registration_for(&target).cloned())
        else {
            return Ok(json!({}));
        };
        // The caller check took part of the time the hook client waits: a
        // question that might not be sent before it gives up is not sent,
        // so Codex never shows a dialog for a question the core also sends.
        if arrived.elapsed() + crate::relay::question::ROUTE_LIMIT + QUESTION_MARGIN > budget {
            return Ok(json!({}));
        }
        let cwd = fields
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let reason = self
            .core
            .escalate_codex_hook_question(&registration, input, cwd)
            .await;
        Ok(question_hook_answer(reason.as_deref()))
    }

    /// Agent Relay's Codex hook at SessionStart: the session's Agent Relay
    /// preamble as `additionalContext`, which Codex adds to the session once
    /// as it starts (and again after a resume, clear or compaction, when the
    /// earlier context is gone), never on every prompt. Only a session on the
    /// relay, or one the core is putting there by itself, is told anything;
    /// for the rest, and whenever the socket's commands cannot be named,
    /// the answer is `{}`. With no turn id at SessionStart, only a trusted
    /// Codex writer holding this thread alone can authorize its context.
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
        let trusted_host =
            tokio::task::spawn_blocking(move || directory.trusted_codex_discovery_signal(pid))
                .await
                .unwrap_or(false);
        if trusted_host {
            self.core.request_codex_discovery();
        }
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
        .flatten();
        // A multiplexing host can request discovery without proving which
        // chat will receive this response. Return no identity or context.
        let Some(session) = session else {
            return if trusted_host {
                Ok(json!({}))
            } else {
                Err(OutboundError::not_a_session())
            };
        };
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
        if identity.is_none() && self.core.spawning_targets().contains(&session.target) {
            // A thread a spawn here started is that spawn's agent: it waits
            // for the spawn's registration, never one of its own.
            identity = self
                .core
                .saved_spawn_registration(&session.target)
                .await
                .and(registered());
        } else if identity.is_none() {
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
        let mut answer = json!({"hookSpecificOutput": {
            "hookEventName": SESSION_START,
            "additionalContext": text,
        }});
        // Only the helper's receipt acknowledgement spends the fallback.
        // A timeout or unreadable reply must leave later tool hooks able
        // to supply identity. Resume/compaction still gets fresh context.
        if let (Some((_, address)), Some(inbox)) = (
            identity.as_ref(),
            self.core.plugins.codex_stop_hook.as_ref(),
        ) {
            answer["relayIdentityReceipt"] =
                json!(inbox.startup_identity_receipt(&session.target.id, address, pid));
        }
        Ok(answer)
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
        fn codex_hook_turn_matches(&self, pid: i32, thread: &str, turn: &str) -> bool {
            if turn == "question-turn-slow" {
                std::thread::sleep(std::time::Duration::from_millis(400));
                return self.holds_codex_thread(pid, thread);
            }
            if turn.starts_with("question-turn") {
                QUESTION_CHECKS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                return self.holds_codex_thread(pid, thread) && turn == "question-turn";
            }
            self.holds_codex_thread(pid, thread) && turn == "fixture-turn"
        }
    }

    /// How many times the question hook asked the directory about a turn.
    static QUESTION_CHECKS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
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
        fixture_with(None)
    }

    fn fixture_with(
        turn_end_advisories: Option<Arc<dyn crate::relay::daemon::TurnEndAdvisories>>,
    ) -> (tempfile::TempDir, Outbound, Arc<StopHookInbox>) {
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
        let inbox = Arc::new(StopHookInbox::with_turns(
            crate::relay::codex::turn_hook::TurnInbox::open(home.join("turns.json")),
        ));
        inbox.set_ready(true);
        let direct = Arc::new(Direct);
        let plugins = Plugins {
            sessions: Arc::new(Sessions),
            codex_stop_hook: Some(inbox.clone()),
            turn_end_advisories,
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
            control_url: None,
            gate_url: None,
        });
        (temp, Outbound::new(core, direct), inbox)
    }
    fn fields() -> Map<String, Value> {
        json!({"session_id": THREAD, "hook_event_name":"PostToolUse", "turn_id":"fixture-turn"})
            .as_object()
            .unwrap()
            .clone()
    }

    fn stop(active: bool) -> Map<String, Value> {
        json!({"session_id": THREAD, "hook_event_name": "Stop", "turn_id": "fixture-turn",
            "stop_hook_active": active})
        .as_object()
        .unwrap()
        .clone()
    }

    #[tokio::test]
    async fn a_stop_carries_the_turn_end_advisory_once() {
        use crate::relay::turn_end_advisories::fake::Queue;
        let target = Target::new(SessionKind::Codex, THREAD);
        let queue = Arc::new(Queue::with(
            target.clone(),
            " Heads up: @b edits auth.rs. ",
            &["a1", "a2"],
        ));
        let (_temp, outbound, _) = fixture_with(Some(queue.clone()));
        // A stop already continuing from a stop hook's block takes nothing.
        assert_eq!(
            outbound
                .codex_stop_hook(42, outbound.uid, &stop(true))
                .await
                .unwrap(),
            json!({})
        );
        assert!(queue.taken.lock().unwrap().is_empty());
        assert!(queue.shown().is_empty());
        assert_eq!(
            outbound
                .codex_stop_hook(42, outbound.uid, &stop(false))
                .await
                .unwrap(),
            json!({"decision": "block", "reason": "Heads up: @b edits auth.rs."})
        );
        assert_eq!(
            queue.shown(),
            vec![(target, vec!["a1".to_string(), "a2".to_string()])]
        );
        // The next stop has nothing left to carry.
        assert_eq!(
            outbound
                .codex_stop_hook(42, outbound.uid, &stop(false))
                .await
                .unwrap(),
            json!({})
        );
        assert_eq!(queue.shown().len(), 1);
        // A tool call never takes it.
        let (_temp, outbound, _) = fixture_with(Some(queue.clone()));
        let taken = queue.taken.lock().unwrap().len();
        let _ = outbound.codex_stop_hook(42, outbound.uid, &fields()).await;
        assert_eq!(queue.taken.lock().unwrap().len(), taken);
    }

    #[tokio::test]
    async fn without_the_plugin_a_quiet_stop_says_nothing() {
        let (_temp, outbound, _) = fixture();
        assert_eq!(
            outbound
                .codex_stop_hook(42, outbound.uid, &stop(false))
                .await
                .unwrap(),
            json!({})
        );
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
        assert!(!context.contains("socket-request"));
        assert!(context.contains(" register --socket "));
        assert!(context.contains("--name NAME --mcp agent-relay-sessions"));
        assert!(context.contains("NAME"));
        assert!(context.contains("ask first"));
        assert!(context.contains("retry hosted join_relay without name"));
        assert!(context
            .contains("keep this locally registered identity and use the local session commands"));
        assert!(context.contains("never join under a new hosted name"));
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
    async fn automatic_unregistered_chats_keep_manual_guidance_and_one_discovery_nudge() {
        let (_temp, outbound, inbox) = fixture();
        outbound
            .core
            .store
            .update(|s| s.auto_activate = Some(true))
            .unwrap();
        assert!(outbound
            .codex_stop_hook(99, outbound.uid, &fields())
            .await
            .is_err());
        assert!(inbox.needs_discovery_refresh(THREAD));
        let answer = outbound
            .codex_stop_hook(42, outbound.uid, &fields())
            .await
            .unwrap();
        assert!(answer.to_string().contains(" register --socket "));
        assert!(!inbox.needs_discovery_refresh(THREAD));
        assert!(!inbox.needs_registration_guidance(THREAD));
        // Once there is no pending delivery, later hooks take the fast path
        // rather than repeatedly probing affinity and scheduling discovery.
        assert_eq!(
            outbound
                .codex_stop_hook(99, outbound.uid, &fields())
                .await
                .unwrap(),
            json!({})
        );
    }

    /// A late identity must reach only its verified turn, with queued messages.
    async fn registered_identity_after_manual_guidance(automatic: bool) {
        let (_temp, outbound, inbox) = fixture();
        let send = outbound.core.plugins.relay_send.as_ref().unwrap();
        send.serving.set(Some(send.socket.clone()));
        outbound
            .core
            .store
            .update(|s| s.auto_activate = Some(automatic))
            .unwrap();
        let first = outbound
            .codex_stop_hook(42, outbound.uid, &fields())
            .await
            .unwrap();
        assert!(first.to_string().contains(" register --socket "));
        assert!(!inbox.needs_registration_guidance(THREAD));
        let registration = serde_json::from_value(json!({
            "name":"codex-api", "agentID":"agent-1",
            "target":{"kind":"codex", "id":THREAD}, "title":"API",
            "baseURL":"https://cast.test", "registeredAt":"2026-11-02T00:00:00Z"
        }))
        .unwrap();
        outbound
            .core
            .store
            .update(|s| {
                assert!(s.add(registration, Secret::new("fixture-only")));
            })
            .unwrap();
        let address = outbound.core.store.read(|s| {
            s.registration_for(&Target::new(SessionKind::Codex, THREAD))
                .unwrap()
                .current_address(&outbound.core.machine_prefix)
        });
        if !automatic {
            // Simulate a startup reply that the helper never receives.
            // Merely constructing it must not suppress the late fallback.
            let start = json!({"session_id":THREAD,"hook_event_name":"SessionStart"});
            let offered = outbound
                .codex_stop_hook(42, outbound.uid, start.as_object().unwrap())
                .await
                .unwrap();
            let receipt = offered["relayIdentityReceipt"].as_str().unwrap();
            let forged = json!({"session_id":THREAD,"hook_event_name":"RelayIdentityReceipt",
                "receipt":receipt});
            assert!(outbound
                .codex_stop_hook(99, outbound.uid, forged.as_object().unwrap())
                .await
                .is_err());
        }
        assert!(inbox.needs_registered_identity(THREAD, &address));
        assert!(outbound
            .codex_stop_hook(99, outbound.uid, &fields())
            .await
            .is_err());
        assert!(inbox.needs_registered_identity(THREAD, &address));
        inbox
            .turns()
            .offer(THREAD, "late-message", "late delivery fixture")
            .unwrap();
        let answer = outbound
            .codex_stop_hook(42, outbound.uid, &fields())
            .await
            .unwrap();
        let context = answer["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap();
        assert!(context.contains("codex-api"));
        assert!(context.contains("late delivery fixture"));
        assert!(!context.contains("This Codex chat is not registered"));
        assert!(!inbox.needs_registered_identity(THREAD, &address));
        assert_eq!(
            outbound
                .codex_stop_hook(99, outbound.uid, &fields())
                .await
                .unwrap(),
            json!({})
        );
    }

    /// Registration may complete between two hooks after manual guidance.
    #[tokio::test]
    async fn manual_guidance_cannot_spend_later_registered_identity_context() {
        registered_identity_after_manual_guidance(true).await;
    }

    #[tokio::test]
    async fn manual_registration_gets_verified_identity_when_automatic_activation_is_off() {
        registered_identity_after_manual_guidance(false).await;
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

    /// The question hook's input for `tool`, `input` and `turn`, as Codex
    /// 0.154 gives it (`fixtures/questions/codex-0.154-...`), from THREAD.
    fn question(tool: &str, input: Value, turn: Option<&str>) -> Map<String, Value> {
        let mut fields = json!({"session_id": THREAD, "hook_event_name": "PreToolUse",
            "tool_name": tool, "tool_input": input, "cwd": "/work"})
        .as_object()
        .unwrap()
        .clone();
        if let Some(turn) = turn {
            fields.insert("turn_id".into(), json!(turn));
        }
        fields
    }

    fn asked() -> Value {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../fixtures/questions/codex-0.154-pre-tool-use-request-user-input.json"
        ))
        .unwrap();
        fixture["input"]["tool_input"].clone()
    }

    /// Puts THREAD on the relay in a workspace at `base`, with escalation
    /// on and the inbox `triage`.
    fn register(outbound: &Outbound, base: &str) {
        let asker = crate::relay::question::tests::registration(
            "asker-route",
            Target::new(SessionKind::Codex, THREAD),
            base,
        );
        outbound
            .core
            .workspace
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .base_url = base.into();
        outbound
            .core
            .workspace
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .key = Secret::new("rk_live_test");
        outbound
            .core
            .store
            .remember(|store| {
                store
                    .tokens
                    .insert(asker.name.clone(), Secret::new("at_live_asker"));
                store.registrations.push(asker);
                store.extras.question_escalation_inbox = Some("triage".into());
            })
            .unwrap();
    }

    #[tokio::test]
    async fn the_question_hook_answers_only_its_own_turns_question() {
        let (base, hits) = crate::relay::question::tests::relaycast(false);
        let (_temp, outbound, _) = fixture();
        let ask = |fields: Map<String, Value>| {
            let outbound = &outbound;
            async move { outbound.codex_stop_hook(42, outbound.uid, &fields).await }
        };
        // Another tool, or input that is not an object: allowed at once.
        assert_eq!(
            ask(question("shell", asked(), Some("question-turn")))
                .await
                .unwrap(),
            json!({})
        );
        assert_eq!(
            ask(question(
                "request_user_input",
                json!("Which?"),
                Some("question-turn")
            ))
            .await
            .unwrap(),
            json!({})
        );
        // No turn, an empty one, or one the caller does not hold.
        for turn in [None, Some(""), Some("question-turn-other")] {
            let error = ask(question("request_user_input", asked(), turn))
                .await
                .unwrap_err();
            assert_eq!(error.code, OutboundError::not_a_session().code, "{turn:?}");
        }
        let other_caller = outbound
            .codex_stop_hook(
                7,
                outbound.uid,
                &question("request_user_input", asked(), Some("question-turn")),
            )
            .await
            .unwrap_err();
        assert_eq!(other_caller.code, OutboundError::not_a_session().code);
        // Not on the relay: allowed.
        assert_eq!(
            ask(question(
                "request_user_input",
                asked(),
                Some("question-turn")
            ))
            .await
            .unwrap(),
            json!({})
        );
        // On the relay: sent, and the tool is refused with the reason.
        register(&outbound, &base);
        let answer = ask(question(
            "request_user_input",
            asked(),
            Some("question-turn"),
        ))
        .await
        .unwrap();
        assert_eq!(answer["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert_eq!(answer["hookSpecificOutput"]["permissionDecision"], "deny");
        assert!(answer["hookSpecificOutput"]["permissionDecisionReason"]
            .as_str()
            .unwrap()
            .starts_with("Sent to @triage over Agent Relay as question q"));
        assert!(hits
            .lock()
            .unwrap()
            .iter()
            .any(|hit| hit.starts_with("POST /v1/dm")));
        // Off: allowed, with no directory check and nothing sent.
        outbound
            .core
            .store
            .remember(|store| store.extras.question_escalation = Some(false))
            .unwrap();
        let before = QUESTION_CHECKS.load(std::sync::atomic::Ordering::SeqCst);
        let sent = hits.lock().unwrap().len();
        assert_eq!(
            ask(question(
                "request_user_input",
                asked(),
                Some("question-turn-off")
            ))
            .await
            .unwrap(),
            json!({})
        );
        assert_eq!(
            QUESTION_CHECKS.load(std::sync::atomic::Ordering::SeqCst),
            before
        );
        assert_eq!(hits.lock().unwrap().len(), sent);
    }

    /// A caller check that leaves no room for a full send leaves the
    /// question to Codex's dialog, with nothing sent; a quick one sends.
    #[tokio::test]
    async fn a_slow_caller_check_leaves_the_question_to_codex() {
        let (base, hits) = crate::relay::question::tests::relaycast(false);
        let (_temp, outbound, _) = fixture();
        register(&outbound, &base);
        let budget = crate::relay::question::ROUTE_LIMIT
            + QUESTION_MARGIN
            + std::time::Duration::from_millis(200);
        let dms = || {
            hits.lock()
                .unwrap()
                .iter()
                .filter(|hit| hit.starts_with("POST /v1/dm"))
                .count()
        };
        let slow = question("request_user_input", asked(), Some("question-turn-slow"));
        let answer = outbound
            .codex_question_hook_within(42, THREAD.into(), &slow, budget)
            .await
            .unwrap();
        assert_eq!(answer, json!({}));
        assert_eq!(dms(), 0, "nothing sent");
        // A question of its own: another test may have this thread's
        // fixture question open already.
        let mut own = asked();
        own["questions"][0]["question"] = json!("Which cache should the service use?");
        let quick = question("request_user_input", own, Some("question-turn"));
        let answer = outbound
            .codex_question_hook_within(42, THREAD.into(), &quick, budget)
            .await
            .unwrap();
        assert_eq!(answer["hookSpecificOutput"]["permissionDecision"], "deny");
        assert_eq!(dms(), 1);
    }
}
