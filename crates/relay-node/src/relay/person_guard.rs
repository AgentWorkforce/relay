//! Keeps agent sessions on this computer from writing as the person through
//! the bridge.
//!
//! The bridge admits any process of this user, and `messages.send` and
//! `agents.test_message` send as the signed-in person. A process the session
//! directory places inside a registered agent session (the same peer-process
//! walk the relay-send socket names its caller with) is refused those
//! methods and told to send as its own agent instead, and so is a process
//! under an agent process of this user's whose one session cannot be named
//! (an OpenCode holding two sessions, say, under an Apple `curl` that hides
//! its tag): when in doubt, the guard refuses. A process outside every agent,
//! and a client the platform reports no pid for, are served as before.
//!
//! This is a guard, not a boundary: a process of this user outside every
//! agent, or one using the stored sign-in directly, is not stopped by it.

use crate::relay::daemon::{CallContext, Core};
use crate::relay::outbound::caller_session;
use crate::relay::protocol::{ErrorKind, RpcError};
use crate::relay::sessions::CallerMiss;

/// What a person send's caller is to the guard.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Caller {
    /// Outside every agent session, or not identifiable: served as before.
    Person,
    /// Inside a registered agent session, a live session whose own file
    /// does not parse, or under an agent process whose one session cannot be
    /// named, so its registration cannot be ruled out.
    Session,
}

async fn caller(core: &Core, context: &CallContext) -> Caller {
    // A client the platform reports no pid for, and the core's own calls
    // (`server::call`), are served as before: the bridge admits only this
    // user, and refusing them would break the app where `LOCAL_PEERPID`
    // fails.
    let Some(pid) = context.peer_pid else {
        return Caller::Person;
    };
    match caller_session(core, pid).await {
        Ok(session) => {
            let registered = core
                .once_spawns_save(|store| store.registration_for(&session.target).map(|_| ()))
                .await
                .is_some();
            if registered {
                Caller::Session
            } else {
                Caller::Person
            }
        }
        Err(CallerMiss::Unreadable(_) | CallerMiss::Unattributed) => Caller::Session,
        Err(CallerMiss::NotASession) => Caller::Person,
    }
}

/// Refuses a call that would write as the person when it comes from inside
/// an agent session on this computer. Bridge methods that send as the person
/// call this first; a build's own such methods can too.
pub async fn admit_person_send(core: &Core, context: &CallContext) -> Result<(), RpcError> {
    match caller(core, context).await {
        Caller::Person => Ok(()),
        Caller::Session => Err(RpcError::new(
            ErrorKind::Refused,
            "This call sends as the person, and it comes from inside an agent session on \
             this computer. Send as the session's own agent instead, with \
             `agent-relay-probe send` (the relay-send socket's /send route).",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::daemon::{Config, Plugins};
    use crate::relay::delivery::DeliveryTiming;
    use crate::relay::paths::CorePaths;
    use crate::relay::push::PushTiming;
    use crate::relay::sessions::{DiscoveredSession, SessionDirectory, UnreadableSessionFile};
    use crate::relay::store::{Registration, SessionKind, Target};
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    const REGISTERED: i32 = 4101;
    const UNREGISTERED: i32 = 4102;
    const UNREADABLE: i32 = 4103;
    const OUTSIDE: i32 = 4104;
    const UNATTRIBUTED: i32 = 4105;

    /// Callers by pid, and every pid the guard asked about.
    #[derive(Default)]
    struct Callers {
        sessions: HashMap<i32, DiscoveredSession>,
        asked: Mutex<Vec<i32>>,
    }

    impl SessionDirectory for Callers {
        fn sessions(&self) -> Vec<DiscoveredSession> {
            self.sessions.values().cloned().collect()
        }

        fn caller(&self, pid: i32) -> Result<DiscoveredSession, CallerMiss> {
            self.asked.lock().unwrap().push(pid);
            if pid == UNREADABLE {
                return Err(CallerMiss::Unreadable(UnreadableSessionFile {
                    path: "/tmp/sessions/4100.json".into(),
                    pid: 4100,
                    error: "expected value".into(),
                }));
            }
            if pid == UNATTRIBUTED {
                return Err(CallerMiss::Unattributed);
            }
            self.sessions
                .get(&pid)
                .cloned()
                .ok_or(CallerMiss::NotASession)
        }
    }

    fn session(id: &str) -> DiscoveredSession {
        DiscoveredSession {
            target: Target::new(SessionKind::Codex, id),
            title: id.into(),
            directory: Some("/Users/me/Projects/api".into()),
            updated_at_ms: None,
            live: true,
            host: None,
            holder: None,
        }
    }

    fn core(home: &std::path::Path, callers: Arc<Callers>) -> Arc<Core> {
        let config = Config {
            paths: CorePaths::for_socket(home.join("core.sock")).unwrap(),
            home: home.into(),
            app_data_dir: home.join("app-data"),
            env: Default::default(),
            version: "test".into(),
            host_name: "Test Desk.local".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: PushTiming::default(),
            delivery_timing: DeliveryTiming::default(),
        };
        let plugins = Plugins {
            sessions: callers,
            ..Plugins::default()
        };
        let core = Core::with_plugins(config, plugins).0;
        let registration: Registration = serde_json::from_value(json!({
            "name": "codex-api",
            "agentID": "a_1",
            "target": {"kind": "codex", "id": "registered-thread"},
            "baseURL": "https://cast.test",
            "registeredAt": "2026-11-01T12:00:00Z",
        }))
        .unwrap();
        core.store
            .update(|store| store.registrations.push(registration))
            .unwrap();
        core
    }

    fn from(pid: Option<i32>) -> CallContext {
        CallContext {
            peer_pid: pid,
            connection_id: Some(1),
        }
    }

    #[tokio::test]
    async fn only_a_caller_inside_a_registered_or_unreadable_session_is_refused() {
        let home = tempfile::tempdir().unwrap();
        let callers = Arc::new(Callers {
            sessions: HashMap::from([
                (REGISTERED, session("registered-thread")),
                (UNREGISTERED, session("other-thread")),
            ]),
            ..Callers::default()
        });
        let core = core(home.path(), callers.clone());

        let refused = admit_person_send(&core, &from(Some(REGISTERED)))
            .await
            .unwrap_err();
        assert_eq!(refused.data.kind, ErrorKind::Refused);
        assert!(refused.message.contains("agent-relay-probe send"));
        assert!(!refused.message.contains("registered-thread"));
        assert_eq!(
            caller(&core, &from(Some(UNREADABLE))).await,
            Caller::Session
        );
        assert_eq!(
            caller(&core, &from(Some(UNREGISTERED))).await,
            Caller::Person
        );
        assert_eq!(caller(&core, &from(Some(OUTSIDE))).await, Caller::Person);
        admit_person_send(&core, &from(Some(OUTSIDE)))
            .await
            .unwrap();
        assert_eq!(
            *callers.asked.lock().unwrap(),
            [REGISTERED, UNREADABLE, UNREGISTERED, OUTSIDE, OUTSIDE]
        );
    }

    #[tokio::test]
    async fn a_caller_under_an_agent_whose_session_cannot_be_named_is_refused() {
        let home = tempfile::tempdir().unwrap();
        let callers = Arc::new(Callers::default());
        let core = core(home.path(), callers.clone());
        assert_eq!(
            caller(&core, &from(Some(UNATTRIBUTED))).await,
            Caller::Session
        );
        let context = from(Some(UNATTRIBUTED));
        for (method, params) in [
            ("messages.send", json!({"to": "reviewer", "text": "hello"})),
            ("agents.test_message", json!({"name": "codex-api"})),
        ] {
            let refused = crate::relay::server::call_from(&core, &context, method, params)
                .await
                .unwrap_err();
            assert_eq!(refused.data.kind, ErrorKind::Refused, "{method}");
            assert!(
                refused.message.contains("agent-relay-probe send"),
                "{method}"
            );
        }
        admit_person_send(&core, &from(Some(OUTSIDE)))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_caller_with_no_pid_is_served_without_a_walk() {
        let home = tempfile::tempdir().unwrap();
        let callers = Arc::new(Callers::default());
        let core = core(home.path(), callers.clone());
        admit_person_send(&core, &from(None)).await.unwrap();
        admit_person_send(&core, &CallContext::default())
            .await
            .unwrap();
        assert!(callers.asked.lock().unwrap().is_empty());
    }
}
