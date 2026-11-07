//! Typed identifier newtypes for protocol fields.
//!
//! Each wrapper is `#[serde(transparent)]` so the JSON wire format is
//! identical to the previous bare-`String` form, which means the broker
//! ↔ SDK protocol on disk and over the wire is unchanged.
//!
//! The wrappers impl `Deref<Target = str>`, `Display`, `AsRef<str>`,
//! `Borrow<str>`, `From<String>` / `From<&str>`, and `PartialEq` against
//! `str`/`&str`/`String` so existing call sites that treated these fields
//! as strings keep compiling unchanged. The point is not to force
//! ceremony at use sites — it's to prevent passing a `DeliveryId` where
//! an `EventId` was expected, and to make the meaning of overloaded
//! fields (`target` in particular) legible in the type system.

use std::borrow::Borrow;
use std::ffi::OsStr;
use std::fmt;
use std::ops::Deref;

use serde::{Deserialize, Serialize};

macro_rules! string_id {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            #[inline]
            pub fn new(s: impl Into<String>) -> Self {
                Self(s.into())
            }

            #[inline]
            pub fn as_str(&self) -> &str {
                &self.0
            }

            #[inline]
            pub fn into_string(self) -> String {
                self.0
            }
        }

        impl From<String> for $name {
            fn from(s: String) -> Self {
                Self(s)
            }
        }

        impl From<&str> for $name {
            fn from(s: &str) -> Self {
                Self(s.to_string())
            }
        }

        impl From<&String> for $name {
            fn from(s: &String) -> Self {
                Self(s.clone())
            }
        }

        impl From<$name> for String {
            fn from(v: $name) -> Self {
                v.0
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }

        impl AsRef<OsStr> for $name {
            fn as_ref(&self) -> &OsStr {
                OsStr::new(&self.0)
            }
        }

        impl Borrow<str> for $name {
            fn borrow(&self) -> &str {
                &self.0
            }
        }

        impl Deref for $name {
            type Target = str;
            fn deref(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                fmt::Display::fmt(&self.0, f)
            }
        }

        impl PartialEq<str> for $name {
            fn eq(&self, other: &str) -> bool {
                self.0 == other
            }
        }

        impl PartialEq<&str> for $name {
            fn eq(&self, other: &&str) -> bool {
                self.0.as_str() == *other
            }
        }

        impl PartialEq<String> for $name {
            fn eq(&self, other: &String) -> bool {
                &self.0 == other
            }
        }

        impl PartialEq<$name> for str {
            fn eq(&self, other: &$name) -> bool {
                self == other.0.as_str()
            }
        }

        impl PartialEq<$name> for &str {
            fn eq(&self, other: &$name) -> bool {
                *self == other.0.as_str()
            }
        }

        impl PartialEq<$name> for String {
            fn eq(&self, other: &$name) -> bool {
                self.as_str() == other.0.as_str()
            }
        }
    };
}

string_id!(
    /// Display name of a worker / spawned agent managed by this broker
    /// (e.g. `"lead"`, `"reviewer-1"`).
    WorkerName
);
string_id!(
    /// Relaycast workspace identifier (e.g. `"ws_abc123"`).
    WorkspaceId
);
string_id!(
    /// Human-readable workspace alias for display.
    WorkspaceAlias
);
string_id!(
    /// Per-delivery identifier assigned by the broker when queueing an
    /// inbound relay message for a worker.
    DeliveryId
);
string_id!(
    /// Inbound relay event identifier carried end-to-end for dedup,
    /// telemetry, and ack matching.
    EventId
);
string_id!(
    /// Thread / conversation identifier used to scope replies.
    ThreadId
);
string_id!(
    /// Relaycast agent identifier (the API-server-side agent record id,
    /// distinct from the local [`WorkerName`]).
    AgentId
);
string_id!(
    /// Per-request correlation identifier on the SDK ↔ broker protocol.
    RequestId
);
string_id!(
    /// Channel name as it appears in subscribe / unsubscribe payloads
    /// and `AgentSpec::channels` — the raw identifier without the
    /// leading `#` (e.g. `"general"`, `"ops"`). The `#`-prefixed form
    /// is the [`MessageTarget`] convention for routing a message *to*
    /// a channel, not the channel's own name.
    ChannelName
);

string_id!(
    /// Destination of a relay message — overloaded at the string level
    /// across channels (`"#general"`), the thread sentinel
    /// (`"thread"`), DM / conversation identifiers (`"dm_..."`,
    /// `"conv_..."`), or a bare worker name.
    ///
    /// Use [`MessageTarget::kind`] to dispatch exhaustively instead of
    /// hand-rolling prefix checks.
    MessageTarget
);

/// Discriminated view of [`MessageTarget`]'s overloaded shape.
///
/// The variants reflect the on-wire conventions used by relaycast and
/// the broker's routing layer. Match this rather than calling
/// `starts_with('#')` / `== "thread"` at every site.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageTargetKind<'a> {
    /// `#name` channel target. The slice is the name without `#`.
    Channel(&'a str),
    /// The literal `"thread"` sentinel — a thread reply whose specific
    /// recipient is resolved by the broker's thread-routing pass.
    Thread,
    /// A direct-message conversation identifier (`dm_*`).
    DirectMessage(&'a str),
    /// A group-DM / conversation identifier (`conv_*`).
    Conversation(&'a str),
    /// A bare worker display name.
    Worker(&'a str),
}

impl MessageTarget {
    /// Classify the target string into its semantic shape.
    ///
    /// Parsing precedence (kept identical to the historical inline
    /// prefix checks; do not reorder):
    ///
    /// 1. leading `#` → [`MessageTargetKind::Channel`]
    /// 2. the exact string `"thread"` → [`MessageTargetKind::Thread`]
    /// 3. `dm_` prefix → [`MessageTargetKind::DirectMessage`]
    /// 4. `conv_` prefix → [`MessageTargetKind::Conversation`]
    /// 5. anything else → [`MessageTargetKind::Worker`]
    ///
    /// Consequence of (2)–(5): a worker literally named `thread`,
    /// `dm_x`, or `conv_x` cannot be addressed by bare name — the wire
    /// convention reserves those shapes. This is a property of the wire
    /// protocol, not of this classifier; keep the convention audited
    /// here rather than re-deriving it at call sites.
    pub fn kind(&self) -> MessageTargetKind<'_> {
        let s = self.0.as_str();
        if let Some(channel) = s.strip_prefix('#') {
            MessageTargetKind::Channel(channel)
        } else if s == "thread" {
            MessageTargetKind::Thread
        } else if s.starts_with("dm_") {
            MessageTargetKind::DirectMessage(s)
        } else if s.starts_with("conv_") {
            MessageTargetKind::Conversation(s)
        } else {
            MessageTargetKind::Worker(s)
        }
    }

    /// `true` when the target is a `#channel` broadcast.
    pub fn is_channel(&self) -> bool {
        self.0.starts_with('#')
    }

    /// `true` when the target is the `"thread"` sentinel used for
    /// thread-reply routing.
    pub fn is_thread_sentinel(&self) -> bool {
        self.0 == "thread"
    }

    /// The thread sentinel value (`"thread"`).
    pub fn thread_sentinel() -> Self {
        Self("thread".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serde_transparent_string_roundtrip() {
        let w = WorkerName::new("lead");
        let json = serde_json::to_string(&w).unwrap();
        assert_eq!(json, r#""lead""#);
        let back: WorkerName = serde_json::from_str(&json).unwrap();
        assert_eq!(back, w);
    }

    #[test]
    fn deref_and_eq_against_str_work() {
        let id = DeliveryId::new("del_1");
        // Deref<Target=str> means &str methods are callable.
        assert_eq!(id.len(), 5);
        assert!(id.starts_with("del_"));
        // PartialEq impls cover the natural comparison directions.
        assert!(id == "del_1");
        assert!("del_1" == id);
    }

    #[test]
    fn message_target_classifies_channel_thread_dm_conv_and_worker() {
        assert_eq!(
            MessageTarget::new("#general").kind(),
            MessageTargetKind::Channel("general")
        );
        assert_eq!(
            MessageTarget::new("thread").kind(),
            MessageTargetKind::Thread
        );
        assert_eq!(
            MessageTarget::new("dm_abc").kind(),
            MessageTargetKind::DirectMessage("dm_abc")
        );
        assert_eq!(
            MessageTarget::new("conv_xy").kind(),
            MessageTargetKind::Conversation("conv_xy")
        );
        assert_eq!(
            MessageTarget::new("Lead").kind(),
            MessageTargetKind::Worker("Lead")
        );
    }

    #[test]
    fn message_target_helpers_match_kind() {
        let t = MessageTarget::new("#ops");
        assert!(t.is_channel());
        assert!(!t.is_thread_sentinel());

        let t = MessageTarget::thread_sentinel();
        assert!(t.is_thread_sentinel());
        assert_eq!(t.kind(), MessageTargetKind::Thread);
    }

    #[test]
    fn hashmap_lookup_by_str_via_borrow() {
        let mut m = std::collections::HashMap::<WorkerName, u32>::new();
        m.insert(WorkerName::new("lead"), 1);
        // Borrow<str> means we can look up by &str without allocating.
        assert_eq!(m.get("lead").copied(), Some(1));
    }
}
