//! Ties the broker's relay types into relay-pty's generic delivery
//! primitives: `RelayPriority` becomes the queue's priority scheme and
//! `InjectRequest` becomes a queueable, injectable item.

use crate::{
    inject::RequestId,
    queue::{Prioritized, PriorityScheme},
    types::{InjectRequest, RelayPriority},
};

impl PriorityScheme for RelayPriority {
    /// P0 through P4.
    const LEVELS: usize = 5;
    /// Overflow may evict P2–P4; P0 and P1 are never dropped.
    const FIRST_DROPPABLE: usize = 2;

    fn index(self) -> usize {
        self.as_u8() as usize
    }
}

impl Prioritized for InjectRequest {
    type Priority = RelayPriority;

    fn priority(&self) -> RelayPriority {
        self.priority
    }
}

impl RequestId for InjectRequest {
    fn id(&self) -> &str {
        &self.id
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{InjectRequest, RelayPriority};

    fn req(priority: RelayPriority) -> InjectRequest {
        InjectRequest {
            workspace_id: "ws_test".into(),
            workspace_alias: Some("test".into()),
            id: "x".into(),
            from: "a".into(),
            target: "b".into(),
            body: "c".into(),
            priority,
            attempts: 0,
        }
    }

    #[test]
    fn inject_request_priority() {
        for p in [
            RelayPriority::P0,
            RelayPriority::P1,
            RelayPriority::P2,
            RelayPriority::P3,
            RelayPriority::P4,
        ] {
            assert_eq!(req(p).priority(), p);
        }
    }

    #[test]
    fn relay_priority_indexes_match_levels() {
        for (idx, p) in [
            RelayPriority::P0,
            RelayPriority::P1,
            RelayPriority::P2,
            RelayPriority::P3,
            RelayPriority::P4,
        ]
        .into_iter()
        .enumerate()
        {
            assert_eq!(p.index(), idx);
        }
    }

    #[test]
    fn inject_request_exposes_id() {
        assert_eq!(req(RelayPriority::P2).id(), "x");
    }
}
