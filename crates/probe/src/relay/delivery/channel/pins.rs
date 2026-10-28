//! The channel injections handed to a session but not yet settled, kept
//! on disk so a restart cannot change what they contain.
//!
//! A channel injection is written here, with its key, its posts and its
//! exact text, before the prompt is handed to the session's route. While it
//! is here, every retry hands over that same text under that same key, even
//! when a post has since left the queue or would no longer be chosen; the
//! route recognises a prompt it already holds by its key, so a post is
//! never put into a second prompt. It is removed once the injection
//! settles (delivered, in doubt, refused, or certainly not handed over), or
//! once none of its posts is still queued.

use super::super::policy::Delivery;
use crate::relay::store::SessionKind;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// The journal's file name in the app data directory.
pub const FILE_NAME: &str = "channel-injections.json";

/// One injection, as it was handed over.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pin {
    /// The receiving agent.
    pub agent_id: String,
    /// The delivery and message ids it was handed over with.
    pub delivery_id: String,
    pub key: String,
    /// Its posts' delivery ids.
    pub members: Vec<String>,
    /// The prompt, exactly.
    pub text: String,
    /// The reply routes this injection opened, which a failure takes back.
    pub routes: Vec<String>,
    /// Original reply target and Pi/gateway receipt key, independent of queue reads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_post: Option<ReplyPost>,
}

/// Only routing metadata is retained; the bounded prompt already holds the text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplyPost {
    id: String,
    message_id: String,
    channel_id: Option<String>,
    sender: Option<String>,
    sender_address: Option<String>,
    thread_id: Option<String>,
}

impl From<&Delivery> for ReplyPost {
    fn from(post: &Delivery) -> Self {
        Self {
            id: post.id.clone(),
            message_id: post.message_id.clone(),
            channel_id: post.channel_id.clone(),
            sender: post.sender.clone(),
            sender_address: post.sender_address.clone(),
            thread_id: post.thread_id.clone(),
        }
    }
}

impl ReplyPost {
    fn delivery(&self) -> Delivery {
        Delivery {
            id: self.id.clone(),
            message_id: self.message_id.clone(),
            channel_id: self.channel_id.clone(),
            sender: self.sender.clone(),
            sender_address: self.sender_address.clone(),
            thread_id: self.thread_id.clone(),
            reason: Some("message".into()),
            ..Delivery::default()
        }
    }
}

impl Pin {
    /// Replays the original receipt key and reply destination. Old Pi pins used
    /// their batch key and had no automatic answer; preserve that behavior.
    /// Old gateways used the original last post. If it is missing, no safe key
    /// can be recovered, so fail closed instead of submitting another prompt.
    pub fn reply_delivery(
        &self,
        kind: SessionKind,
        queued: &[Delivery],
    ) -> Result<Option<Delivery>, String> {
        if let Some(post) = &self.reply_post {
            return Ok(Some(post.delivery()));
        }
        match kind {
            SessionKind::OpenClaw | SessionKind::Hermes => self
                .members
                .last()
                .and_then(|id| queued.iter().find(|post| &post.id == id))
                .cloned()
                .map(Some)
                .ok_or_else(|| {
                    "The saved channel batch's original reply target is unavailable; not resent."
                        .into()
                }),
            _ => Ok(None),
        }
    }
}

/// The journal: pins by key, loaded once, saved on every change.
#[derive(Debug, Default)]
pub struct ChannelPins {
    path: PathBuf,
    pins: Vec<Pin>,
}

impl ChannelPins {
    /// The journal at `path`; empty when it is missing or unreadable.
    pub fn load(path: PathBuf) -> ChannelPins {
        let pins = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        ChannelPins { path, pins }
    }

    /// The pin of `agent_id` holding any of `delivery_ids`.
    pub fn find<'a>(
        &self,
        agent_id: &str,
        mut delivery_ids: impl Iterator<Item = &'a str>,
    ) -> Option<Pin> {
        let held: HashSet<&str> = self
            .pins
            .iter()
            .filter(|pin| pin.agent_id == agent_id)
            .flat_map(|pin| pin.members.iter().map(String::as_str))
            .collect();
        let id = delivery_ids.find(|id| held.contains(id))?;
        self.pins
            .iter()
            .find(|pin| pin.agent_id == agent_id && pin.members.iter().any(|m| m == id))
            .cloned()
    }

    /// Records `pin`, replacing one with its key. Nothing may be handed
    /// over when this fails.
    pub fn insert(&mut self, pin: Pin) -> Result<(), String> {
        let before = self.pins.clone();
        self.pins
            .retain(|kept| kept.key != pin.key || kept.agent_id != pin.agent_id);
        self.pins.push(pin);
        self.save().inspect_err(|_| self.pins = before)
    }

    /// Forgets the pin `key` of `agent_id`.
    pub fn remove(&mut self, agent_id: &str, key: &str) -> Result<(), String> {
        let before = self.pins.len();
        self.pins
            .retain(|pin| pin.key != key || pin.agent_id != agent_id);
        if self.pins.len() == before {
            return Ok(());
        }
        self.save()
    }

    /// Forgets `agent_id`'s pins none of whose posts is still `queued`.
    pub fn retain_queued(&mut self, agent_id: &str, queued: &HashSet<&str>) -> Result<(), String> {
        let before = self.pins.len();
        self.pins.retain(|pin| {
            pin.agent_id != agent_id || pin.members.iter().any(|m| queued.contains(m.as_str()))
        });
        if self.pins.len() == before {
            return Ok(());
        }
        self.save()
    }

    fn save(&self) -> Result<(), String> {
        save_atomically(
            &self.path,
            &serde_json::to_vec(&self.pins).map_err(|e| e.to_string())?,
        )
    }
}

/// Writes `bytes` to `path` through a private temporary file and a rename.
fn save_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("The journal path has no directory.")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    crate::platform::fs::set_mode(parent, 0o700).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("json.new");
    let mut file = crate::platform::fs::private(
        fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true),
    )
    .open(&temporary)
    .map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    fs::rename(&temporary, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pin(agent: &str, key: &str, members: &[&str]) -> Pin {
        Pin {
            agent_id: agent.into(),
            delivery_id: key.into(),
            key: key.into(),
            members: members.iter().map(|m| m.to_string()).collect(),
            text: format!("prompt {key}"),
            routes: vec![],
            reply_post: None,
        }
    }

    #[test]
    fn pins_survive_a_reload_and_are_found_by_any_member() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app").join(FILE_NAME);
        let mut pins = ChannelPins::load(path.clone());
        pins.insert(pin("a1", "chb-1", &["del_1", "del_2"]))
            .unwrap();
        pins.insert(pin("a2", "chb-1", &["del_9"])).unwrap();

        let reloaded = ChannelPins::load(path.clone());
        let found = reloaded.find("a1", ["del_7", "del_2"].into_iter()).unwrap();
        assert_eq!(found, pin("a1", "chb-1", &["del_1", "del_2"]));
        assert_eq!(reloaded.find("a2", ["del_1"].into_iter()), None);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn the_original_reply_target_survives_reload_without_its_queued_post() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let post = Delivery {
            id: "d2".into(),
            message_id: "m2".into(),
            channel_id: Some("ch_swarm".into()),
            sender: Some("alice".into()),
            sender_address: Some("alice@direct".into()),
            thread_id: Some("root".into()),
            reason: Some("message".into()),
            ..Delivery::default()
        };
        let mut original = pin("a1", "batch", &["d1", "d2"]);
        original.reply_post = Some(ReplyPost::from(&post));
        ChannelPins::load(path.clone()).insert(original).unwrap();
        let restored = ChannelPins::load(path)
            .find("a1", ["d1"].into_iter())
            .unwrap();
        assert_eq!(
            restored.reply_delivery(SessionKind::Pi, &[]).unwrap(),
            Some(post)
        );
    }

    #[test]
    fn legacy_pi_pins_keep_batch_keys_and_legacy_gateways_require_the_original_post() {
        let legacy = pin("a1", "batch", &["d1", "d2"]);
        let value = serde_json::to_value(&legacy).unwrap();
        assert!(value.get("reply_post").is_none());
        let legacy: Pin = serde_json::from_value(value).unwrap();
        let post = Delivery {
            id: "d2".into(),
            message_id: "m2".into(),
            ..Delivery::default()
        };
        assert!(legacy
            .reply_delivery(SessionKind::Pi, std::slice::from_ref(&post))
            .unwrap()
            .is_none());
        for kind in [SessionKind::OpenClaw, SessionKind::Hermes] {
            assert_eq!(
                legacy
                    .reply_delivery(kind, std::slice::from_ref(&post))
                    .unwrap(),
                Some(post.clone())
            );
            assert!(legacy.reply_delivery(kind, &[]).is_err());
        }
    }

    #[test]
    fn pins_leave_when_settled_or_when_none_of_their_posts_is_queued() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let mut pins = ChannelPins::load(path.clone());
        pins.insert(pin("a1", "k1", &["del_1"])).unwrap();
        pins.insert(pin("a1", "k2", &["del_2", "del_3"])).unwrap();
        pins.insert(pin("a2", "k3", &["del_4"])).unwrap();
        pins.retain_queued("a1", &HashSet::from(["del_3"])).unwrap();
        pins.remove("a2", "k3").unwrap();
        let reloaded = ChannelPins::load(path);
        assert_eq!(reloaded.pins, vec![pin("a1", "k2", &["del_2", "del_3"])]);
    }

    #[test]
    fn an_unreadable_journal_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::write(&path, b"not json").unwrap();
        assert!(ChannelPins::load(path).pins.is_empty());
    }
}
