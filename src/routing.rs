use std::collections::HashSet;

use relay_broker::types::{InboundKind, InboundRelayEvent};

use crate::normalize_channel;

#[derive(Clone, Copy)]
pub(crate) struct RoutingWorker<'a> {
    pub(crate) name: &'a str,
    pub(crate) channels: &'a [String],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DeliveryPlan {
    pub(crate) targets: Vec<String>,
    pub(crate) display_target: String,
    pub(crate) needs_dm_resolution: bool,
}

pub(crate) fn is_self_echo(
    event: &InboundRelayEvent,
    self_names: &HashSet<String>,
    self_agent_ids: &HashSet<String>,
    has_local_target: bool,
) -> bool {
    let from_self = self_names.contains(&event.from)
        || event
            .sender_agent_id
            .as_ref()
            .is_some_and(|id| self_agent_ids.contains(id));
    if !from_self {
        return false;
    }

    // Messages emitted under our own identity but targeting local workers/channels
    // are dashboard-originated and should be delivered.
    if has_local_target {
        tracing::debug!(
            target = "broker::routing",
            from = %event.from,
            target_field = %event.target,
            "self-echo allowed — local target detected"
        );
        return false;
    }

    tracing::debug!(
        target = "broker::routing",
        from = %event.from,
        event_id = %event.event_id,
        "filtering self-echo"
    );
    true
}

pub(crate) fn resolve_delivery_targets(
    event: &InboundRelayEvent,
    workers: &[RoutingWorker<'_>],
) -> DeliveryPlan {
    if event.target.starts_with('#') {
        let targets = worker_names_for_channel_delivery(workers, &event.target, &event.from);
        tracing::debug!(
            target = "broker::routing",
            from = %event.from,
            channel = %event.target,
            recipients = ?targets,
            "resolved channel delivery"
        );
        return DeliveryPlan {
            targets,
            display_target: event.target.clone(),
            needs_dm_resolution: false,
        };
    }

    // Thread replies without a channel target are broadcast to all workers
    // (except the sender). The WS only delivers thread.reply to channel
    // subscribers so every local worker is a valid recipient.
    if matches!(event.kind, InboundKind::ThreadReply) && event.target == "thread" {
        let targets: Vec<String> = workers
            .iter()
            .filter(|w| !w.name.eq_ignore_ascii_case(&event.from))
            .map(|w| w.name.to_string())
            .collect();
        tracing::debug!(
            target = "broker::routing",
            from = %event.from,
            recipients = ?targets,
            "resolved thread reply broadcast"
        );
        return DeliveryPlan {
            targets,
            display_target: "thread".to_string(),
            needs_dm_resolution: false,
        };
    }

    let direct_targets = worker_names_for_direct_target(workers, &event.target, &event.from);
    let needs_dm_resolution = direct_targets.is_empty()
        && matches!(
            event.kind,
            InboundKind::DmReceived | InboundKind::GroupDmReceived
        );

    tracing::debug!(
        target = "broker::routing",
        from = %event.from,
        to = %event.target,
        kind = ?event.kind,
        recipients = ?direct_targets,
        needs_dm_resolution = needs_dm_resolution,
        "resolved direct/DM delivery"
    );

    DeliveryPlan {
        targets: direct_targets,
        display_target: event.target.clone(),
        needs_dm_resolution,
    }
}

pub(crate) fn worker_names_for_channel_delivery(
    workers: &[RoutingWorker<'_>],
    channel: &str,
    from: &str,
) -> Vec<String> {
    let normalized = normalize_channel(channel);
    workers
        .iter()
        .filter_map(|worker| {
            if worker.name.eq_ignore_ascii_case(from) {
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
) -> Vec<String> {
    let trimmed = target.trim();
    workers
        .iter()
        .filter_map(|worker| {
            if worker.name.eq_ignore_ascii_case(from) {
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

pub(crate) fn worker_names_for_dm_participants(
    workers: &[RoutingWorker<'_>],
    participants: &[String],
    from: &str,
) -> Vec<String> {
    workers
        .iter()
        .filter_map(|worker| {
            if worker.name.eq_ignore_ascii_case(from) {
                return None;
            }
            if participants
                .iter()
                .any(|participant| participant.eq_ignore_ascii_case(worker.name))
            {
                Some(worker.name.to_string())
            } else {
                None
            }
        })
        .collect()
}

pub(crate) fn display_target_for_dashboard(
    target: &str,
    self_names: &HashSet<String>,
    primary_name: &str,
) -> String {
    if self_names
        .iter()
        .any(|name| target.eq_ignore_ascii_case(name))
    {
        primary_name.to_string()
    } else {
        target.to_string()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use relay_broker::types::{InboundKind, InboundRelayEvent, RelayPriority, SenderKind};

    use super::{
        display_target_for_dashboard, is_self_echo, resolve_delivery_targets,
        worker_names_for_dm_participants, RoutingWorker,
    };

    #[derive(Debug)]
    struct WorkerFixture {
        name: String,
        channels: Vec<String>,
    }

    impl WorkerFixture {
        fn new(name: &str, channels: &[&str]) -> Self {
            Self {
                name: name.to_string(),
                channels: channels.iter().map(|channel| channel.to_string()).collect(),
            }
        }
    }

    fn routing_workers<'a>(workers: &'a [WorkerFixture]) -> Vec<RoutingWorker<'a>> {
        workers
            .iter()
            .map(|worker| RoutingWorker {
                name: &worker.name,
                channels: &worker.channels,
            })
            .collect()
    }

    fn inbound_event(kind: InboundKind, from: &str, target: &str) -> InboundRelayEvent {
        let priority = if matches!(kind, InboundKind::DmReceived | InboundKind::GroupDmReceived) {
            RelayPriority::P2
        } else {
            RelayPriority::P3
        };

        InboundRelayEvent {
            event_id: "evt_1".to_string(),
            kind,
            from: from.to_string(),
            sender_agent_id: None,
            sender_kind: SenderKind::Agent,
            target: target.to_string(),
            text: "hello".to_string(),
            thread_id: None,
            priority,
        }
    }

    #[test]
    fn self_echo_detected_by_name() {
        let mut self_names = HashSet::new();
        self_names.insert("Broker".to_string());
        let self_agent_ids = HashSet::new();
        let event = inbound_event(InboundKind::MessageCreated, "Broker", "#general");

        assert!(is_self_echo(&event, &self_names, &self_agent_ids, false));
    }

    #[test]
    fn self_echo_detected_by_agent_id() {
        let self_names = HashSet::new();
        let mut self_agent_ids = HashSet::new();
        self_agent_ids.insert("agt_self".to_string());
        let mut event = inbound_event(InboundKind::MessageCreated, "Other", "#general");
        event.sender_agent_id = Some("agt_self".to_string());

        assert!(is_self_echo(&event, &self_names, &self_agent_ids, false));
    }

    #[test]
    fn self_echo_not_filtered_when_target_is_local() {
        let mut self_names = HashSet::new();
        self_names.insert("Broker".to_string());
        let self_agent_ids = HashSet::new();
        let event = inbound_event(InboundKind::DmReceived, "Broker", "WorkerA");

        assert!(!is_self_echo(&event, &self_names, &self_agent_ids, true));
    }

    #[test]
    fn self_echo_not_filtered_when_channel_has_local_targets() {
        let mut self_names = HashSet::new();
        self_names.insert("Broker".to_string());
        let self_agent_ids = HashSet::new();
        let event = inbound_event(InboundKind::MessageCreated, "Broker", "#general");

        assert!(!is_self_echo(&event, &self_names, &self_agent_ids, true));
    }

    #[test]
    fn self_echo_filtered_when_target_is_not_local() {
        let mut self_names = HashSet::new();
        self_names.insert("Broker".to_string());
        let self_agent_ids = HashSet::new();
        let event = inbound_event(InboundKind::DmReceived, "Broker", "ExternalUser");

        assert!(is_self_echo(&event, &self_names, &self_agent_ids, false));
    }

    #[test]
    fn resolve_delivery_targets_for_channel_message() {
        let workers = vec![
            WorkerFixture::new("Alpha", &["general"]),
            WorkerFixture::new("Bravo", &["ops"]),
            WorkerFixture::new("Charlie", &["general", "ops"]),
        ];
        let routing_workers = routing_workers(&workers);
        let event = inbound_event(InboundKind::MessageCreated, "Alpha", "#general");

        let plan = resolve_delivery_targets(&event, &routing_workers);

        assert_eq!(plan.targets, vec!["Charlie".to_string()]);
        assert_eq!(plan.display_target, "#general".to_string());
        assert!(!plan.needs_dm_resolution);
    }

    #[test]
    fn resolve_delivery_targets_for_direct_message_is_case_insensitive() {
        let workers = vec![
            WorkerFixture::new("Lead", &["general"]),
            WorkerFixture::new("AgentOne", &["general"]),
        ];
        let routing_workers = routing_workers(&workers);
        let event = inbound_event(InboundKind::MessageCreated, "Lead", "@agentone");

        let plan = resolve_delivery_targets(&event, &routing_workers);

        assert_eq!(plan.targets, vec!["AgentOne".to_string()]);
        assert!(!plan.needs_dm_resolution);
    }

    #[test]
    fn dm_plan_marks_resolution_needed_when_direct_target_missing() {
        let workers = vec![
            WorkerFixture::new("Lead", &["general"]),
            WorkerFixture::new("AgentOne", &["general"]),
        ];
        let routing_workers = routing_workers(&workers);
        let event = inbound_event(InboundKind::DmReceived, "Lead", "conv_123");

        let plan = resolve_delivery_targets(&event, &routing_workers);

        assert!(plan.targets.is_empty());
        assert!(plan.needs_dm_resolution);
    }

    #[test]
    fn dm_participant_routing_is_case_insensitive() {
        let workers = vec![
            WorkerFixture::new("Alpha", &["general"]),
            WorkerFixture::new("Bravo", &["general"]),
            WorkerFixture::new("Charlie", &["general"]),
        ];
        let routing_workers = routing_workers(&workers);
        let participants = vec!["bravo".to_string(), "alpha".to_string()];

        let targets = worker_names_for_dm_participants(&routing_workers, &participants, "ALPHA");

        assert_eq!(targets, vec!["Bravo".to_string()]);
    }

    #[test]
    fn display_target_maps_self_name_case_insensitively() {
        let mut self_names = HashSet::new();
        self_names.insert("DashProbe".to_string());
        self_names.insert("broker-951762d5".to_string());

        assert_eq!(
            display_target_for_dashboard("dashprobe", &self_names, "my-project"),
            "my-project"
        );
    }

    #[test]
    fn display_target_keeps_non_self_target() {
        let mut self_names = HashSet::new();
        self_names.insert("DashProbe".to_string());

        assert_eq!(
            display_target_for_dashboard("Lead", &self_names, "my-project"),
            "Lead".to_string()
        );
    }
}
