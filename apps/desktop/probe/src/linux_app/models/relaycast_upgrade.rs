use crate::relay::request_log::RequestEntry;

pub const RELAYCAST_UPGRADE_TITLE: &str = "Agent Relay plan limit reached";
pub const RELAYCAST_UPGRADE_MESSAGE: &str =
    "Review upgrade options in Cloud Billing to raise your workspace’s limit.";
pub const RELAYCAST_UPGRADE_ACTION: &str = "Review upgrade";
pub const RELAYCAST_CAPACITY_TITLE: &str = "Workspace at capacity";
/// Busy answers that must occur close together before the capacity notice
/// shows: one busy write is ordinary contention, a run is not.
pub const RELAYCAST_CAPACITY_THRESHOLD: usize = 3;

/// Why a workspace is offered an upgrade: a quota it hit, or a Free or Pro
/// plan's write capacity that stays saturated.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RelaycastUpgradeReason {
    PlanLimit,
    Capacity { plan: String },
}

impl RelaycastUpgradeReason {
    pub fn title(&self) -> &'static str {
        match self {
            Self::PlanLimit => RELAYCAST_UPGRADE_TITLE,
            Self::Capacity { .. } => RELAYCAST_CAPACITY_TITLE,
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::PlanLimit => RELAYCAST_UPGRADE_MESSAGE.into(),
            Self::Capacity { plan } => format!(
                "Your team is using all of the {} plan’s write capacity, so messages may be delayed while Agent Relay retries. Upgrade to raise your workspace’s capacity.",
                plan_name(plan)
            ),
        }
    }

    fn billing_reason(&self) -> &'static str {
        match self {
            Self::PlanLimit => "relaycast-plan-limit",
            Self::Capacity { .. } => "relaycast-capacity",
        }
    }
}

/// A Relay Connect room's request is that room's workspace, not the team's.
fn body(entry: &RequestEntry) -> Option<serde_json::Value> {
    (entry.service == "Relaycast"
        && entry.failed
        && entry.connect != Some(true)
        && entry.status == Some(429))
    .then(|| serde_json::from_str(&entry.response).ok())
    .flatten()
}

/// Plans whose write capacity an upgrade raises.
pub const RELAYCAST_UPGRADABLE_PLANS: [&str; 2] = ["free", "pro"];
/// Calls on lanes whose capacity no plan raises (connection tokens,
/// heartbeats, delivery acknowledgements and agent or node lifecycle). SDK
/// rows log the operation as their method and only the origin as endpoint.
const FIXED_LANE_SDK_METHODS: [&str; 4] = [
    "SDK: heartbeat",
    "SDK: ack",
    "SDK: delete_agent",
    "SDK: join_channel",
];
const FIXED_LANE_PATH_PREFIXES: [&str; 3] =
    ["/v1/agent/node-token", "/v1/agents/heartbeat", "/v1/nodes"];
const FIXED_LANE_PATH_SUFFIXES: [&str; 3] = ["/ack", "/takeover", "/release"];

fn fixed_lane(entry: &RequestEntry) -> bool {
    let path = url::Url::parse(&entry.endpoint)
        .map(|url| url.path().to_owned())
        .unwrap_or_else(|_| entry.endpoint.clone());
    FIXED_LANE_SDK_METHODS.contains(&entry.method.as_str())
        || (entry.method == "POST" && path == "/v1/agents")
        || FIXED_LANE_PATH_PREFIXES
            .iter()
            .any(|lane| path.starts_with(lane))
        || FIXED_LANE_PATH_SUFFIXES
            .iter()
            .any(|lane| path.ends_with(lane))
}

pub fn is_relaycast_plan_limit(entry: &RequestEntry) -> bool {
    body(entry).is_some_and(|body| body["error_code"] == "plan_limit_exceeded")
}

/// A busy answer for a write an upgrade would admit. Relaycast's own
/// `upgrade_available` decides when the answer carries it.
pub fn is_relaycast_capacity_busy(entry: &RequestEntry) -> bool {
    let Some(body) = body(entry).filter(|body| body["error_code"] == "workspace_busy") else {
        return false;
    };
    match body["upgrade_available"].as_bool() {
        Some(available) => available,
        None => !fixed_lane(entry),
    }
}

/// Why to offer an upgrade for `entries` (the failures recent enough to count
/// for this workspace) on `plan`, if at all. At least one must be `unseen`,
/// so a notice is offered for new failures only.
pub fn relaycast_upgrade_reason<'a>(
    entries: impl IntoIterator<Item = &'a RequestEntry>,
    plan: Option<&str>,
    unseen: impl Fn(&RequestEntry) -> bool,
) -> Option<RelaycastUpgradeReason> {
    let entries: Vec<_> = entries.into_iter().collect();
    if entries
        .iter()
        .any(|entry| unseen(entry) && is_relaycast_plan_limit(entry))
    {
        return Some(RelaycastUpgradeReason::PlanLimit);
    }
    let busy: Vec<_> = entries
        .iter()
        .filter(|entry| is_relaycast_capacity_busy(entry))
        .collect();
    // The plan Relaycast names in its answer, else the one verification read.
    let plan = busy
        .iter()
        .find_map(|entry| body(entry)?["plan"].as_str().map(str::to_owned))
        .or_else(|| plan.map(str::to_owned))?
        .to_lowercase();
    if !RELAYCAST_UPGRADABLE_PLANS.contains(&plan.as_str()) {
        return None;
    }
    (busy.len() >= RELAYCAST_CAPACITY_THRESHOLD && busy.iter().any(|entry| unseen(entry)))
        .then_some(RelaycastUpgradeReason::Capacity { plan })
}

/// The notice a request-log read offers: failures this workspace saw (after
/// `identity_started_at_ms`) in the last five minutes, any of them unseen.
pub fn relaycast_upgrade_from_log(
    entries: &[RequestEntry],
    plan: Option<&str>,
    identity_started_at_ms: u64,
    now_ms: u64,
    seen: &std::collections::HashSet<String>,
) -> Option<RelaycastUpgradeReason> {
    let recent = entries.iter().filter(|entry| {
        entry.failed
            && entry.started_at_ms >= identity_started_at_ms
            && now_ms.abs_diff(entry.started_at_ms) < 300_000
    });
    relaycast_upgrade_reason(recent, plan, |entry| !seen.contains(&entry.id))
}

/// Cloud Billing for `reason` on `site` (the default site when unknown).
pub fn relaycast_upgrade_url(
    site: Option<&str>,
    reason: Option<&RelaycastUpgradeReason>,
) -> Option<String> {
    relaycast_billing_url(
        site.unwrap_or(crate::relay::links::DEFAULT_SITE_URL),
        reason.unwrap_or(&RelaycastUpgradeReason::PlanLimit),
    )
}

pub fn relaycast_billing_url(site: &str, reason: &RelaycastUpgradeReason) -> Option<String> {
    let mut url = url::Url::parse(site).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
    }
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_path("/cloud/dashboard/settings");
    url.set_query(Some(&format!("reason={}", reason.billing_reason())));
    url.set_fragment(Some("billing"));
    Some(url.into())
}

fn plan_name(plan: &str) -> String {
    match plan.to_lowercase().as_str() {
        "free" => "Free".into(),
        "pro" => "Pro".into(),
        _ => {
            let mut chars = plan.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().chain(chars).collect())
                .unwrap_or_default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_explicit_relaycast_quota_errors_offer_upgrade() {
        assert_eq!(RELAYCAST_UPGRADE_TITLE, "Agent Relay plan limit reached");
        let mut entry = RequestEntry {
            id: "1".into(),
            started_at_ms: 0,
            service: "Relaycast".into(),
            method: "GET".into(),
            endpoint: "https://cast.agentrelay.com/v1/workspace".into(),
            request: "null".into(),
            response: r#"{"error_code":"plan_limit_exceeded"}"#.into(),
            status: Some(429),
            duration_ms: Some(244),
            failed: true,
            connect: None,
        };
        assert!(is_relaycast_plan_limit(&entry));
        // A Relay Connect room's limit is that room's, not the team's.
        entry.connect = Some(true);
        assert!(!is_relaycast_plan_limit(&entry));
        entry.connect = None;
        entry.response = r#"{"error_code":"rate_limit_exceeded"}"#.into();
        assert!(!is_relaycast_plan_limit(&entry));
        entry.response = "plan_limit_exceeded".into();
        assert!(!is_relaycast_plan_limit(&entry));
        entry.response = r#"{"error_code":"plan_limit_exceeded"}"#.into();
        entry.service = "Cloud".into();
        assert!(!is_relaycast_plan_limit(&entry));
    }

    #[test]
    fn billing_preserves_environment_and_removes_credentials() {
        assert_eq!(relaycast_billing_url("http://user:secret@local.test:3000/old?token=x#old", &RelaycastUpgradeReason::PlanLimit).as_deref(),
            Some("http://local.test:3000/cloud/dashboard/settings?reason=relaycast-plan-limit#billing"));
        assert!(
            relaycast_billing_url("file:///tmp/test", &RelaycastUpgradeReason::PlanLimit).is_none()
        );
    }

    fn busy(id: &str, endpoint: &str, response: &str) -> RequestEntry {
        RequestEntry {
            id: id.into(),
            started_at_ms: 0,
            service: "Relaycast".into(),
            method: "POST".into(),
            endpoint: endpoint.into(),
            request: "{}".into(),
            response: response.into(),
            status: Some(429),
            duration_ms: Some(5046),
            failed: true,
            connect: None,
        }
    }

    #[test]
    fn sustained_busy_on_upgradable_plan_offers_capacity_notice() {
        let all = |_: &RequestEntry| true;
        let dm = |id: &str| {
            busy(
                id,
                "https://cast.agentrelay.com/v1/dm",
                r#"{"error_code":"workspace_busy"}"#,
            )
        };
        let three = [dm("1"), dm("2"), dm("3")];
        assert_eq!(
            relaycast_upgrade_reason(&three[..2], Some("free"), all),
            None
        );
        let reason = relaycast_upgrade_reason(&three, Some("free"), all).unwrap();
        assert_eq!(
            reason,
            RelaycastUpgradeReason::Capacity {
                plan: "free".into()
            }
        );
        assert_eq!(reason.title(), "Workspace at capacity");
        assert_eq!(reason.message(), "Your team is using all of the Free plan’s write capacity, so messages may be delayed while Agent Relay retries. Upgrade to raise your workspace’s capacity.");
        assert_eq!(
            relaycast_upgrade_reason(&three, Some("Pro"), all),
            Some(RelaycastUpgradeReason::Capacity { plan: "pro".into() })
        );
        assert_eq!(
            relaycast_upgrade_reason(&three, Some("enterprise"), all),
            None
        );
        assert_eq!(relaycast_upgrade_reason(&three, None, all), None);
        assert_eq!(
            relaycast_upgrade_reason(&three, Some("free"), |_: &RequestEntry| false),
            None
        );
        let tokens: Vec<_> = (1..=3)
            .map(|n| {
                busy(
                    &n.to_string(),
                    "https://cast.agentrelay.com/v1/agent/node-token",
                    r#"{"error_code":"workspace_busy"}"#,
                )
            })
            .collect();
        assert_eq!(relaycast_upgrade_reason(&tokens, Some("free"), all), None);
        let sdk = |method: &str| {
            let mut entry = busy(
                method,
                "https://cast.agentrelay.com",
                r#"{"error_code":"workspace_busy"}"#,
            );
            entry.method = method.into();
            entry
        };
        let control = [
            sdk("SDK: heartbeat"),
            sdk("SDK: ack"),
            sdk("SDK: join_channel"),
        ];
        assert_eq!(relaycast_upgrade_reason(&control, Some("free"), all), None);
        let writes = [
            sdk("SDK: send_dm"),
            sdk("SDK: reply"),
            sdk("SDK: send_channel"),
        ];
        assert_eq!(
            relaycast_upgrade_reason(&writes, Some("free"), all),
            Some(RelaycastUpgradeReason::Capacity {
                plan: "free".into()
            })
        );
        let declined: Vec<_> = (1..=3)
            .map(|n| {
                busy(
                    &n.to_string(),
                    "https://cast.agentrelay.com/v1/dm",
                    r#"{"error_code":"workspace_busy","upgrade_available":false}"#,
                )
            })
            .collect();
        assert_eq!(relaycast_upgrade_reason(&declined, Some("free"), all), None);
        assert_eq!(
            relaycast_billing_url("https://agentrelay.com", &reason).as_deref(),
            Some(
                "https://agentrelay.com/cloud/dashboard/settings?reason=relaycast-capacity#billing"
            )
        );
    }
}
