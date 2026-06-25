use std::collections::HashSet;

use crate::runtime::normalize_channel;

#[derive(Clone)]
pub(crate) struct RoutingWorker<'a> {
    pub(crate) name: &'a str,
    pub(crate) channels: &'a [crate::ids::ChannelName],
    pub(crate) workspace_id: Option<&'a str>,
}

/// Returns true if a worker is eligible to receive events from the given workspace.
/// A worker with no workspace_id (legacy/SDK-spawned) matches all workspaces.
/// A worker with a workspace_id only matches events from that same workspace.
fn worker_matches_workspace(worker: &RoutingWorker<'_>, event_workspace_id: Option<&str>) -> bool {
    match (worker.workspace_id, event_workspace_id) {
        (Some(worker_ws), Some(event_ws)) => worker_ws == event_ws,
        _ => true,
    }
}

pub(crate) fn worker_names_for_channel_delivery(
    workers: &[RoutingWorker<'_>],
    channel: &str,
    from: &str,
    workspace_id: Option<&str>,
) -> Vec<String> {
    let normalized = normalize_channel(channel);
    workers
        .iter()
        .filter_map(|worker| {
            if worker.name.eq_ignore_ascii_case(from) {
                return None;
            }
            if !worker_matches_workspace(worker, workspace_id) {
                return None;
            }
            let joined: HashSet<String> = worker
                .channels
                .iter()
                .map(|channel_name| normalize_channel(channel_name))
                .collect();
            if joined.contains(&normalized) {
                Some(worker.name.to_string())
            } else {
                None
            }
        })
        .collect()
}

pub(crate) fn worker_names_for_direct_target(
    workers: &[RoutingWorker<'_>],
    target: &str,
    from: &str,
    workspace_id: Option<&str>,
) -> Vec<String> {
    let trimmed = target.trim();
    workers
        .iter()
        .filter_map(|worker| {
            if worker.name.eq_ignore_ascii_case(from) {
                return None;
            }
            if !worker_matches_workspace(worker, workspace_id) {
                return None;
            }
            if trimmed.eq_ignore_ascii_case(worker.name)
                || trimmed.eq_ignore_ascii_case(&format!("@{}", worker.name))
            {
                Some(worker.name.to_string())
            } else {
                None
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{worker_names_for_channel_delivery, worker_names_for_direct_target, RoutingWorker};

    #[derive(Debug)]
    struct WorkerFixture {
        name: String,
        channels: Vec<crate::ids::ChannelName>,
    }

    impl WorkerFixture {
        fn new(name: &str, channels: &[&str]) -> Self {
            Self {
                name: name.to_string(),
                channels: channels
                    .iter()
                    .map(|channel| crate::ids::ChannelName::from(*channel))
                    .collect(),
            }
        }
    }

    fn routing_workers<'a>(workers: &'a [WorkerFixture]) -> Vec<RoutingWorker<'a>> {
        workers
            .iter()
            .map(|worker| RoutingWorker {
                name: &worker.name,
                channels: &worker.channels,
                workspace_id: None,
            })
            .collect()
    }

    #[test]
    fn channel_delivery_excludes_sender_and_non_members() {
        let workers = vec![
            WorkerFixture::new("Alpha", &["general"]),
            WorkerFixture::new("Bravo", &["ops"]),
            WorkerFixture::new("Charlie", &["general", "ops"]),
        ];
        let routing_workers = routing_workers(&workers);

        let targets =
            worker_names_for_channel_delivery(&routing_workers, "#general", "Alpha", Some("ws_test"));

        assert_eq!(targets, vec!["Charlie".to_string()]);
    }

    #[test]
    fn direct_target_routing_is_case_insensitive() {
        let workers = vec![
            WorkerFixture::new("Lead", &["general"]),
            WorkerFixture::new("AgentOne", &["general"]),
        ];
        let routing_workers = routing_workers(&workers);

        let targets =
            worker_names_for_direct_target(&routing_workers, "@agentone", "Lead", Some("ws_test"));

        assert_eq!(targets, vec!["AgentOne".to_string()]);
    }

    #[test]
    fn channel_delivery_filters_by_workspace_id() {
        let workers = [
            WorkerFixture::new("Alpha", &["general"]),
            WorkerFixture::new("Bravo", &["general"]),
        ];
        // Alpha belongs to ws_a, Bravo belongs to ws_b.
        let routing_workers: Vec<RoutingWorker<'_>> = vec![
            RoutingWorker {
                name: &workers[0].name,
                channels: &workers[0].channels,
                workspace_id: Some("ws_a"),
            },
            RoutingWorker {
                name: &workers[1].name,
                channels: &workers[1].channels,
                workspace_id: Some("ws_b"),
            },
        ];

        // Event from ws_a should only reach Alpha.
        let targets =
            worker_names_for_channel_delivery(&routing_workers, "#general", "External", Some("ws_a"));
        assert_eq!(targets, vec!["Alpha".to_string()]);

        // Event from ws_b should only reach Bravo.
        let targets =
            worker_names_for_channel_delivery(&routing_workers, "#general", "External", Some("ws_b"));
        assert_eq!(targets, vec!["Bravo".to_string()]);
    }

    #[test]
    fn legacy_workers_without_workspace_match_all() {
        let workers = [
            WorkerFixture::new("Alpha", &["general"]),
            WorkerFixture::new("Bravo", &["general"]),
        ];
        // Alpha has no workspace (legacy), Bravo belongs to ws_b.
        let routing_workers: Vec<RoutingWorker<'_>> = vec![
            RoutingWorker {
                name: &workers[0].name,
                channels: &workers[0].channels,
                workspace_id: None,
            },
            RoutingWorker {
                name: &workers[1].name,
                channels: &workers[1].channels,
                workspace_id: Some("ws_b"),
            },
        ];

        // Event from ws_a: Alpha matches (no ws filter), Bravo doesn't (ws_b != ws_a).
        let targets =
            worker_names_for_channel_delivery(&routing_workers, "#general", "External", Some("ws_a"));
        assert_eq!(targets, vec!["Alpha".to_string()]);

        // Event from ws_b: both match.
        let targets =
            worker_names_for_channel_delivery(&routing_workers, "#general", "External", Some("ws_b"));
        assert_eq!(targets, vec!["Alpha".to_string(), "Bravo".to_string()]);
    }
}
