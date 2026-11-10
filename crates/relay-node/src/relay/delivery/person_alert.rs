//! Person alerts: a direct message to you can ask this computer to show a
//! notification.
//!
//! A sender opts in by putting a marker in the DM's `data` (Relaycast keeps
//! it as the message's `metadata`):
//!
//! ```text
//! POST /v1/dm {"to": "<you>", "text": "...",
//!              "data": {"relay_alert": {"title": "<at most 120 chars>",
//!                                       "link": "https://..."}}}
//! ```
//!
//! When such a DM reaches the signed-in person's own relay identity (its
//! push channel, `@name`), the core raises the `notify` bridge event:
//! `title` from the marker, `body` a one-line preview of the message text,
//! `link` from the marker. Only the person's identity is alerted: the same
//! marker on a message to one of this computer's agents is delivered into
//! its session as usual and never notifies, and an ordinary DM never does.
//!
//! The DM itself is unaffected: Relaycast has already stored it, and it is
//! read and acknowledged with the conversation as before. The alert is only
//! a side effect of its arrival. A malformed marker is ignored (a diagnostic
//! line names the reason, never the text or title), and nothing is ever
//! reported back to the sender.
//!
//! Each sender, by Relaycast's immutable agent id, may raise at most
//! [`LIMIT`] alerts in [`WINDOW_MS`]; the rest are dropped (the DMs still
//! arrive) and counted, with one diagnostic line per sender per window. A
//! sender without an agent id is capped by its name, and a DM from your own
//! identity (by id, or by name when it has no id) never alerts. A message
//! redelivered (a push socket reconnecting before the conversation was read)
//! alerts once, as long as it is among the last [`SEEN_KEPT`] alerted
//! messages; an older one redelivered counts as new. The caps and the
//! remembered messages belong to one identity: when another person's
//! identity is current, they start over.

use crate::relay::daemon::Core;
use crate::relay::state::now_ms;
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};

/// The marker's key in a DM's `data` (the message's `metadata`).
pub const MARKER: &str = "relay_alert";
/// The longest title a marker may carry, in characters.
pub const TITLE_MAX_CHARS: usize = 120;
/// How much of the message text the notification shows, in characters.
pub const BODY_PREVIEW_CHARS: usize = 200;
/// Alerts one sender may raise in [`WINDOW_MS`]. An agent finishing work
/// or needing an answer alerts a few times an hour; more than this in ten
/// minutes is noise, or a loop.
pub const LIMIT: usize = 3;
/// How long an alert counts toward its sender's cap.
pub const WINDOW_MS: i64 = 10 * 60 * 1000;
/// How many alerted message ids are remembered, so a redelivery does not
/// alert again. Past this the oldest is forgotten, and a redelivery of it
/// alerts again (still within its sender's cap). With [`LIMIT`] per sender
/// per window this covers far more than a reconnect's backlog.
pub const SEEN_KEPT: usize = 4096;

/// A valid marker.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Alert {
    pub title: String,
    pub link: String,
}

/// Why a marker was ignored.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Malformed {
    NotAnObject,
    TitleMissing,
    TitleEmpty,
    TitleTooLong,
    LinkMissing,
    LinkNotHttps,
}

impl Malformed {
    fn reason(self) -> &'static str {
        match self {
            Malformed::NotAnObject => "the marker is not an object",
            Malformed::TitleMissing => "its title is missing or not a string",
            Malformed::TitleEmpty => "its title is empty",
            Malformed::TitleTooLong => "its title is longer than 120 characters",
            Malformed::LinkMissing => "its link is missing or not a string",
            Malformed::LinkNotHttps => "its link is not an https URL",
        }
    }
}

/// The marker in a message's metadata: `None` when there is none, else
/// whether it is valid.
pub fn parse_marker(metadata: &Value) -> Option<Result<Alert, Malformed>> {
    let marker = metadata.get(MARKER).filter(|m| !m.is_null())?;
    Some(parse(marker))
}

fn parse(marker: &Value) -> Result<Alert, Malformed> {
    let marker = marker.as_object().ok_or(Malformed::NotAnObject)?;
    let title = marker
        .get("title")
        .and_then(Value::as_str)
        .ok_or(Malformed::TitleMissing)?;
    // The raw title is measured: collapsing whitespace must not let a
    // longer one through.
    if title.chars().count() > TITLE_MAX_CHARS {
        return Err(Malformed::TitleTooLong);
    }
    let title = one_line(title);
    if title.is_empty() {
        return Err(Malformed::TitleEmpty);
    }
    let link = marker
        .get("link")
        .and_then(Value::as_str)
        .ok_or(Malformed::LinkMissing)?
        .trim();
    let valid = url::Url::parse(link).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str().is_some_and(|host| !host.is_empty())
            && url.username().is_empty()
            && url.password().is_none()
    });
    if !valid {
        return Err(Malformed::LinkNotHttps);
    }
    Ok(Alert {
        title,
        link: link.to_string(),
    })
}

/// `text` on one line: every run of whitespace (newlines included) is one
/// space, and the ends are trimmed.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The notification body: the first [`BODY_PREVIEW_CHARS`] characters of
/// the message text, on one line, with an ellipsis when cut.
pub fn body_preview(text: &str) -> String {
    let line = one_line(text);
    if line.chars().count() <= BODY_PREVIEW_CHARS {
        return line;
    }
    let mut cut: String = line.chars().take(BODY_PREVIEW_CHARS).collect();
    cut.truncate(cut.trim_end().len());
    cut.push('…');
    cut
}

/// Whether an alert is shown.
#[derive(Debug, PartialEq, Eq)]
pub enum Admission {
    Notify,
    /// This message alerted already.
    Repeated,
    /// The sender is at the cap. `report` is set for the first drop in a
    /// window; `dropped` counts this window's drops so far.
    Capped {
        report: bool,
        dropped: u32,
    },
}

/// One sender's drops in the current window.
#[derive(Debug)]
struct Drops {
    since_ms: i64,
    count: u32,
}

/// The alerts raised recently for one identity, in memory only: a restart
/// forgets them, and so does another identity becoming current.
#[derive(Debug, Default)]
pub struct PersonAlerts {
    /// The agent id of the identity these alerts were raised for.
    owner: Option<String>,
    /// When each sender's counted alerts were raised, oldest first.
    sent: HashMap<String, VecDeque<i64>>,
    dropped: HashMap<String, Drops>,
    seen: HashSet<String>,
    seen_order: VecDeque<String>,
}

impl PersonAlerts {
    /// Counts `message_id` from `sender` to the identity `owner` (its agent
    /// id) at `now_ms`, if it may alert. Another owner than the last one
    /// starts with no caps and nothing seen.
    pub fn admit(&mut self, owner: &str, sender: &str, message_id: &str, now_ms: i64) -> Admission {
        if self.owner.as_deref() != Some(owner) {
            *self = PersonAlerts {
                owner: Some(owner.to_string()),
                ..PersonAlerts::default()
            };
        }
        if self.seen.contains(message_id) {
            return Admission::Repeated;
        }
        self.expire(now_ms);
        let times = self.sent.entry(sender.to_string()).or_default();
        if times.len() >= LIMIT {
            let drops = self.dropped.entry(sender.to_string()).or_insert(Drops {
                since_ms: now_ms,
                count: 0,
            });
            drops.count += 1;
            return Admission::Capped {
                report: drops.count == 1,
                dropped: drops.count,
            };
        }
        times.push_back(now_ms);
        self.remember(message_id);
        Admission::Notify
    }

    /// Forgets alerts and drops [`WINDOW_MS`] old, and senders with none.
    fn expire(&mut self, now_ms: i64) {
        self.sent.retain(|_, times| {
            while times.front().is_some_and(|at| now_ms - at >= WINDOW_MS) {
                times.pop_front();
            }
            !times.is_empty()
        });
        self.dropped
            .retain(|_, drops| now_ms - drops.since_ms < WINDOW_MS);
    }

    fn remember(&mut self, message_id: &str) {
        if self.seen.insert(message_id.to_string()) {
            self.seen_order.push_back(message_id.to_string());
        }
        while self.seen_order.len() > SEEN_KEPT {
            if let Some(oldest) = self.seen_order.pop_front() {
                self.seen.remove(&oldest);
            }
        }
    }
}

fn string(value: &Value) -> Option<&str> {
    value.as_str().filter(|s| !s.is_empty())
}

impl Core {
    /// A frame pushed on the person's own channel: shows the alert a
    /// marked DM asks for. Never changes how the DM is delivered.
    pub(super) fn alert_person(&self, frame: &Value) {
        let Some(identity) = self.current_identity() else {
            return;
        };
        if frame["type"] != "deliver" || frame["payload"]["type"] != "dm.received" {
            return;
        }
        // The frame names its recipient; it must be you.
        if string(&frame["agent_id"]).is_some_and(|id| id != identity.agent_id) {
            return;
        }
        let data = &frame["payload"]["data"];
        let message = &data["message"];
        let metadata = if message["metadata"].is_object() {
            &message["metadata"]
        } else {
            &data["metadata"]
        };
        let Some(marker) = parse_marker(metadata) else {
            return;
        };
        // The sender by its immutable agent id, else its name; either way a
        // DM from your own identity never alerts.
        let sender = match string(&message["agent_id"]) {
            Some(id) if id == identity.agent_id => return,
            Some(id) => id,
            None => match string(&message["agent_name"]) {
                Some(name) if name == identity.name => return,
                Some(name) => name,
                None => return,
            },
        };
        let alert = match marker {
            Ok(alert) => alert,
            Err(malformed) => {
                crate::relay::diagnostics::write(format_args!(
                    "relay: ignored a {MARKER} marker from {sender}: {}",
                    malformed.reason()
                ));
                return;
            }
        };
        let Some(message_id) = string(&frame["msg_id"]).or_else(|| string(&message["id"])) else {
            return;
        };
        let admission = self.delivery.lock().unwrap().person_alerts.admit(
            &identity.agent_id,
            sender,
            message_id,
            now_ms(),
        );
        match admission {
            Admission::Notify => {
                let body = body_preview(message["text"].as_str().unwrap_or_default());
                self.hub.notify(&alert.title, &body, Some(&alert.link));
            }
            Admission::Repeated => {}
            Admission::Capped { report, .. } => {
                if report {
                    crate::relay::diagnostics::write(format_args!(
                        "relay: {sender} reached {LIMIT} alerts in {} minutes; \
                         further alerts from it are dropped for now (its messages still arrive)",
                        WINDOW_MS / 60_000
                    ));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::cloud_session::{AgentOwner, CloudAccess, CloudAccount, CloudError};
    use crate::relay::daemon::{Config, Plugins};
    use crate::relay::delivery::DeliveryTiming;
    use crate::relay::paths::CorePaths;
    use crate::relay::protocol::Topic;
    use crate::relay::push::PushTiming;
    use futures_util::future::BoxFuture;
    use serde_json::json;
    use std::sync::Arc;

    fn marker(title: Value, link: Value) -> Value {
        json!({ MARKER: { "title": title, "link": link } })
    }

    #[test]
    fn a_valid_marker_gives_its_title_and_link() {
        let alert = parse_marker(&marker(
            json!("  Review ready\n for desktop "),
            json!("https://example.com/r/1?x=y"),
        ));
        assert_eq!(
            alert,
            Some(Ok(Alert {
                title: "Review ready for desktop".into(),
                link: "https://example.com/r/1?x=y".into(),
            }))
        );
        let longest = "t".repeat(TITLE_MAX_CHARS);
        assert!(matches!(
            parse_marker(&marker(json!(longest), json!("https://example.com"))),
            Some(Ok(_))
        ));
    }

    #[test]
    fn no_marker_is_not_an_alert() {
        assert_eq!(parse_marker(&json!({})), None);
        assert_eq!(parse_marker(&json!({"injection_mode": "wait"})), None);
        assert_eq!(parse_marker(&json!({ MARKER: null })), None);
        assert_eq!(parse_marker(&Value::Null), None);
    }

    #[test]
    fn each_malformed_marker_is_ignored_with_its_reason() {
        let https = json!("https://example.com");
        let cases = [
            (json!({ MARKER: "Review ready" }), Malformed::NotAnObject),
            (json!({ MARKER: ["Review ready"] }), Malformed::NotAnObject),
            (
                json!({ MARKER: { "link": https } }),
                Malformed::TitleMissing,
            ),
            (marker(json!(7), https.clone()), Malformed::TitleMissing),
            (marker(json!(""), https.clone()), Malformed::TitleEmpty),
            (
                marker(json!(" \n\t "), https.clone()),
                Malformed::TitleEmpty,
            ),
            (
                marker(json!("t".repeat(TITLE_MAX_CHARS + 1)), https.clone()),
                Malformed::TitleTooLong,
            ),
            // Measured before whitespace collapses: this one is 121
            // characters raw and 81 collapsed.
            (
                marker(
                    json!(format!("{}t", "t  ".repeat(TITLE_MAX_CHARS / 3))),
                    https.clone(),
                ),
                Malformed::TitleTooLong,
            ),
            (
                json!({ MARKER: { "title": "Ready" } }),
                Malformed::LinkMissing,
            ),
            (marker(json!("Ready"), json!(null)), Malformed::LinkMissing),
            (marker(json!("Ready"), json!(42)), Malformed::LinkMissing),
            (
                marker(json!("Ready"), json!("http://example.com")),
                Malformed::LinkNotHttps,
            ),
            (
                marker(json!("Ready"), json!("agentrelay://x")),
                Malformed::LinkNotHttps,
            ),
            (
                marker(json!("Ready"), json!("javascript:alert(1)")),
                Malformed::LinkNotHttps,
            ),
            (
                marker(json!("Ready"), json!("example.com/x")),
                Malformed::LinkNotHttps,
            ),
            (marker(json!("Ready"), json!("")), Malformed::LinkNotHttps),
            (
                marker(json!("Ready"), json!("https://user:pw@example.com")),
                Malformed::LinkNotHttps,
            ),
        ];
        for (metadata, expected) in cases {
            assert_eq!(parse_marker(&metadata), Some(Err(expected)), "{metadata}");
        }
    }

    #[test]
    fn the_body_is_one_trimmed_line_of_at_most_the_preview_length() {
        assert_eq!(body_preview("  hello\n\nthere\tyou  "), "hello there you");
        assert_eq!(body_preview(""), "");
        let long = format!("{} tail", "a".repeat(BODY_PREVIEW_CHARS));
        let preview = body_preview(&long);
        assert_eq!(preview.chars().count(), BODY_PREVIEW_CHARS + 1);
        assert!(preview.ends_with('…'));
        let exact = "b".repeat(BODY_PREVIEW_CHARS);
        assert_eq!(body_preview(&exact), exact);
    }

    #[test]
    fn a_sender_is_capped_within_the_window_and_free_at_its_boundary() {
        let mut alerts = PersonAlerts::default();
        for (i, at) in [0, 1_000, 2_000].into_iter().enumerate() {
            assert_eq!(
                alerts.admit(OWNER_ID, "ag_a", &format!("m{i}"), at),
                Admission::Notify
            );
        }
        assert_eq!(
            alerts.admit(OWNER_ID, "ag_a", "m3", 3_000),
            Admission::Capped {
                report: true,
                dropped: 1
            }
        );
        assert_eq!(
            alerts.admit(OWNER_ID, "ag_a", "m4", WINDOW_MS - 1),
            Admission::Capped {
                report: false,
                dropped: 2
            }
        );
        // The first alert stops counting once it is WINDOW_MS old.
        assert_eq!(
            alerts.admit(OWNER_ID, "ag_a", "m5", WINDOW_MS),
            Admission::Notify
        );
        assert_eq!(
            alerts.admit(OWNER_ID, "ag_a", "m6", WINDOW_MS + 1),
            Admission::Capped {
                report: false,
                dropped: 3
            }
        );
        // The drop count is reported again once its window has passed.
        let later = 3_000 + WINDOW_MS + 1_000;
        assert_eq!(
            alerts.admit(OWNER_ID, "ag_a", "m7", later),
            Admission::Notify
        );
        assert_eq!(
            alerts.admit(OWNER_ID, "ag_a", "m8", later + 1),
            Admission::Notify
        );
        assert_eq!(
            alerts.admit(OWNER_ID, "ag_a", "m9", later + 2),
            Admission::Capped {
                report: true,
                dropped: 1
            }
        );
    }

    #[test]
    fn senders_are_capped_independently() {
        let mut alerts = PersonAlerts::default();
        for i in 0..LIMIT {
            assert_eq!(
                alerts.admit(OWNER_ID, "ag_a", &format!("a{i}"), 0),
                Admission::Notify
            );
        }
        assert!(matches!(
            alerts.admit(OWNER_ID, "ag_a", "a-over", 0),
            Admission::Capped { .. }
        ));
        for i in 0..LIMIT {
            assert_eq!(
                alerts.admit(OWNER_ID, "ag_b", &format!("b{i}"), 0),
                Admission::Notify
            );
        }
        assert!(matches!(
            alerts.admit(OWNER_ID, "ag_b", "b-over", 0),
            Admission::Capped { .. }
        ));
    }

    #[test]
    fn a_redelivered_message_alerts_once_and_does_not_use_the_cap() {
        let mut alerts = PersonAlerts::default();
        assert_eq!(alerts.admit(OWNER_ID, "ag_a", "m1", 0), Admission::Notify);
        assert_eq!(
            alerts.admit(OWNER_ID, "ag_a", "m1", 10),
            Admission::Repeated
        );
        assert_eq!(alerts.admit(OWNER_ID, "ag_a", "m2", 20), Admission::Notify);
        assert_eq!(alerts.admit(OWNER_ID, "ag_a", "m3", 30), Admission::Notify);
    }

    #[test]
    fn a_redelivery_after_the_seen_bound_alerts_again() {
        let mut alerts = PersonAlerts::default();
        // One sender per message, so no cap is reached.
        for i in 0..=SEEN_KEPT {
            assert_eq!(
                alerts.admit(OWNER_ID, &format!("ag_{i}"), &format!("m{i}"), 0),
                Admission::Notify
            );
        }
        // m0 was forgotten when the bound was passed; m1 is still kept.
        assert_eq!(alerts.admit(OWNER_ID, "ag_x", "m1", 1), Admission::Repeated);
        assert_eq!(alerts.admit(OWNER_ID, "ag_x", "m0", 1), Admission::Notify);
    }

    #[test]
    fn another_identity_starts_with_no_caps_and_nothing_seen() {
        let mut alerts = PersonAlerts::default();
        for i in 0..LIMIT {
            assert_eq!(
                alerts.admit("ag_alice", "ag_reviewer", &format!("m{i}"), 0),
                Admission::Notify
            );
        }
        assert!(matches!(
            alerts.admit("ag_alice", "ag_reviewer", "m-over", 0),
            Admission::Capped { .. }
        ));
        assert_eq!(
            alerts.admit("ag_bob", "ag_reviewer", "m0", 1),
            Admission::Notify
        );
        assert_eq!(
            alerts.admit("ag_bob", "ag_reviewer", "m-bob", 1),
            Admission::Notify
        );
    }

    const OWNER_ID: &str = "ag_owner";

    /// Signed in as `user`, whose identity is `@<user>` with agent id
    /// `ag_<user>`; the user can change, as with an account switch.
    struct SignedIn(std::sync::Mutex<&'static str>);
    impl CloudAccess for SignedIn {
        fn account(&self) -> Option<CloudAccount> {
            Some(CloudAccount {
                site_url: "https://agentrelay.example".into(),
                workspace_id: "cloud-workspace".into(),
                user_id: Some(self.0.lock().unwrap().to_string()),
            })
        }
        fn agent_owner(&self) -> Option<AgentOwner> {
            None
        }
        fn request(
            &self,
            _: &'static str,
            path: String,
            _: Option<Value>,
        ) -> BoxFuture<'_, Result<Value, CloudError>> {
            let user = *self.0.lock().unwrap();
            Box::pin(async move {
                Ok(if path.ends_with("/messaging/identity/credential") {
                    json!({"identity": {"name": user, "agentId": format!("ag_{user}"),
                        "token": "at_test", "relaycastUrl": "http://127.0.0.1:9"}})
                } else {
                    Value::Null
                })
            })
        }
    }

    async fn signed_in_core() -> (tempfile::TempDir, Arc<Core>) {
        let (home, core, _) = switchable_core().await;
        (home, core)
    }

    async fn switchable_core() -> (tempfile::TempDir, Arc<Core>, Arc<SignedIn>) {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let config = Config {
            paths: CorePaths::for_socket(home.join("core.sock")).unwrap(),
            home: home.into(),
            app_data_dir: home.join("app-data"),
            env: Default::default(),
            version: "test".into(),
            host_name: "alert-test".into(),
            rediscover_every: std::time::Duration::from_secs(3600),
            push_timing: PushTiming::default(),
            delivery_timing: DeliveryTiming::default(),
        };
        let cloud = Arc::new(SignedIn(std::sync::Mutex::new("owner")));
        let plugins = Plugins {
            cloud: cloud.clone(),
            ..Plugins::default()
        };
        let core = Core::with_plugins(config, plugins).0;
        core.person_identity(false).await.unwrap();
        (temp, core, cloud)
    }

    fn dm_frame(to_id: &str, message_id: &str, metadata: Value) -> Value {
        json!({
            "v": 1, "type": "deliver", "delivery_id": format!("del_{message_id}"),
            "agent_id": to_id, "msg_id": message_id, "seq": 1, "mode": "wait",
            "payload": {"type": "dm.received", "data": {
                "conversation_id": "conv_1",
                "message": {
                    "id": message_id, "agent_id": "ag_reviewer", "agent_name": "reviewer",
                    "text": "Round finished:\n  two findings,\tnone blocking.  ",
                    "metadata": metadata,
                },
            }},
        })
    }

    fn notifications(
        events: &mut tokio::sync::broadcast::Receiver<crate::relay::protocol::Event>,
    ) -> Vec<Value> {
        let mut found = Vec::new();
        while let Ok(event) = events.try_recv() {
            if event.topic == Topic::Notify {
                found.push(event.data);
            }
        }
        found
    }

    fn valid_marker() -> Value {
        json!({"injection_mode": "wait",
            MARKER: {"title": "Review finished", "link": "https://example.com/round/1"}})
    }

    #[tokio::test]
    async fn a_marked_dm_to_the_person_raises_one_notification() {
        let (_home, core) = signed_in_core().await;
        let mut events = core.hub.subscribe();
        core.wake(
            "@owner".into(),
            Some(dm_frame(OWNER_ID, "msg_1", valid_marker())),
        );
        assert_eq!(
            notifications(&mut events),
            vec![json!({
                "title": "Review finished",
                "body": "Round finished: two findings, none blocking.",
                "link": "https://example.com/round/1",
            })]
        );
        // Redelivered on a reconnect: no second notification.
        core.wake(
            "@owner".into(),
            Some(dm_frame(OWNER_ID, "msg_1", valid_marker())),
        );
        assert!(notifications(&mut events).is_empty());
    }

    #[tokio::test]
    async fn a_marked_dm_to_an_agent_raises_none() {
        let (_home, core) = signed_in_core().await;
        let mut events = core.hub.subscribe();
        core.wake(
            "reviewer-agent".into(),
            Some(dm_frame("ag_agent", "msg_2", valid_marker())),
        );
        // A frame on the person's channel naming another recipient.
        core.wake(
            "@owner".into(),
            Some(dm_frame("ag_agent", "msg_3", valid_marker())),
        );
        assert!(notifications(&mut events).is_empty());
    }

    #[tokio::test]
    async fn a_dm_without_a_valid_marker_raises_none() {
        let (_home, core) = signed_in_core().await;
        let mut events = core.hub.subscribe();
        core.wake(
            "@owner".into(),
            Some(dm_frame(
                OWNER_ID,
                "msg_4",
                json!({"injection_mode": "wait"}),
            )),
        );
        core.wake(
            "@owner".into(),
            Some(dm_frame(
                OWNER_ID,
                "msg_5",
                marker(json!(""), json!("https://example.com")),
            )),
        );
        core.wake("@owner".into(), None);
        assert!(notifications(&mut events).is_empty());
    }

    #[tokio::test]
    async fn the_person_hears_at_most_the_cap_from_one_sender() {
        let (_home, core) = signed_in_core().await;
        let mut events = core.hub.subscribe();
        for i in 0..LIMIT + 2 {
            core.wake(
                "@owner".into(),
                Some(dm_frame(OWNER_ID, &format!("m{i}"), valid_marker())),
            );
        }
        assert_eq!(notifications(&mut events).len(), LIMIT);
    }

    #[tokio::test]
    async fn a_self_dm_known_only_by_name_raises_none() {
        let (_home, core) = signed_in_core().await;
        let mut events = core.hub.subscribe();
        let mut frame = dm_frame(OWNER_ID, "msg_self", valid_marker());
        let message = &mut frame["payload"]["data"]["message"];
        message.as_object_mut().unwrap().remove("agent_id");
        message["agent_name"] = json!("owner");
        core.wake("@owner".into(), Some(frame));
        assert!(notifications(&mut events).is_empty());
    }

    #[tokio::test]
    async fn after_an_account_switch_the_new_person_is_alerted() {
        let (_home, core, cloud) = switchable_core().await;
        *cloud.0.lock().unwrap() = "alice";
        core.person_identity(false).await.unwrap();
        let mut events = core.hub.subscribe();
        for i in 0..LIMIT + 1 {
            core.wake(
                "@alice".into(),
                Some(dm_frame("ag_alice", &format!("a{i}"), valid_marker())),
            );
        }
        assert_eq!(notifications(&mut events).len(), LIMIT);
        // Bob signs in: Alice's cap on ag_reviewer is not his.
        *cloud.0.lock().unwrap() = "bob";
        core.person_identity(false).await.unwrap();
        core.wake(
            "@bob".into(),
            Some(dm_frame("ag_bob", "b0", valid_marker())),
        );
        assert_eq!(notifications(&mut events).len(), 1);
    }
}
