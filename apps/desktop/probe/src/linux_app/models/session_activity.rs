//! Look up activity without scanning the roster for every table sort comparison.
use super::LocalSessionRow;
use crate::relay::contract::agents::ArchivedAgent;
use crate::relay::people::{Liveness, RosterAgent};
use crate::relay::store::Target;
use std::collections::HashSet;

pub struct SessionActivityIndex {
    archived_targets: HashSet<Target>,
    archived_uploads: HashSet<String>,
    idle_names: HashSet<String>,
}

impl SessionActivityIndex {
    pub fn new(archived: &[ArchivedAgent], roster: &[RosterAgent]) -> Self {
        Self {
            archived_targets: archived.iter().map(|agent| agent.target.clone()).collect(),
            archived_uploads: archived
                .iter()
                .filter_map(|agent| agent.target.upload_key())
                .collect(),
            idle_names: roster
                .iter()
                .filter(|agent| agent.liveness == Liveness::Idle)
                .map(|agent| agent.name.clone())
                .collect(),
        }
    }

    pub fn activity(&self, session: &LocalSessionRow) -> &'static str {
        if self.archived_uploads.contains(&session.key())
            || session
                .relay
                .as_ref()
                .is_some_and(|local| self.archived_targets.contains(&local.target))
        {
            return "Archived";
        }
        match session.relay.as_ref() {
            Some(local) if local.running != Some(false) => {
                let idle = local.registration.as_ref().is_some_and(|registration| {
                    self.idle_names.contains(registration.name.as_str())
                });
                if local.live && !idle {
                    "Active"
                } else {
                    "Idle"
                }
            }
            _ => "Finished",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::contract::agents::LocalSession;
    use serde_json::json;

    fn local() -> LocalSession {
        serde_json::from_value(json!({"target": {"kind": "codex", "id": "a"},
            "title": "Local", "live": true, "registration": {
                "name": "worker", "address": "worker@relay", "added_by_session": false},
            "suggested_name": "worker"}))
        .unwrap()
    }

    #[test]
    fn activity_refreshes_with_roster_archive_and_running_changes() {
        let mut row = LocalSessionRow {
            upload: None,
            relay: Some(local()),
        };
        assert_eq!(SessionActivityIndex::new(&[], &[]).activity(&row), "Active");
        let mut roster: Vec<RosterAgent> = serde_json::from_value(json!([{
            "name": "worker", "kind": "agent", "where": "this_computer",
            "status": "idle", "liveness": "idle", "description": "", "is_self": true
        }]))
        .unwrap();
        assert_eq!(
            SessionActivityIndex::new(&[], &roster).activity(&row),
            "Idle"
        );
        roster[0].liveness = Liveness::Live;
        assert_eq!(
            SessionActivityIndex::new(&[], &roster).activity(&row),
            "Active"
        );
        row.relay.as_mut().unwrap().running = Some(false);
        assert_eq!(
            SessionActivityIndex::new(&[], &roster).activity(&row),
            "Finished"
        );
        let archived = vec![ArchivedAgent {
            name: "worker".into(),
            address: "worker@relay".into(),
            target: local().target,
            title: "Local".into(),
            archived_at: "2026-10-14T00:00:00Z".into(),
        }];
        assert_eq!(
            SessionActivityIndex::new(&archived, &roster).activity(&row),
            "Archived"
        );
        row.upload = Some(
            serde_json::from_value(json!({"source": "codex", "session_id": "a",
            "title": "Upload", "included": false, "is_agent": false, "status": "not_shared"}))
            .unwrap(),
        );
        row.relay = None;
        assert_eq!(
            SessionActivityIndex::new(&archived, &[]).activity(&row),
            "Archived"
        );
        assert_eq!(
            SessionActivityIndex::new(&[], &[]).activity(&row),
            "Finished"
        );
    }
}
