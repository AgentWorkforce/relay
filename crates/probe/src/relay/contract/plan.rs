//! The workspace's Agent Relay plan: its limits, how much of them is used,
//! and the refusal Relaycast answers when one is reached.
//!
//! Cloud's `GET /api/v1/auth/whoami` carries `currentWorkspace.plan`
//! (`null` when the organization has no plan); Relaycast answers HTTP 429
//! `{"ok":false,"error":{"code":"plan_limit_exceeded","limit","max","current","plan","upgrade_url"}}`
//! when a device, agent or human past the plan's cap is refused. Older
//! servers send neither, and every reader here tolerates that.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The plan Cloud reports for the account's workspace.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema, Deserialize)]
pub struct WorkspacePlan {
    /// `intro`, `pro` or `enterprise`.
    pub key: String,
    /// The plan's display name (`Intro`).
    pub name: String,
    pub limits: PlanLimits,
    /// Where to change the plan; absent when Cloud sent none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upgrade_url: Option<String>,
}

/// A plan's caps; `null` is unlimited.
#[derive(Clone, Debug, PartialEq, Eq, Default, Serialize, JsonSchema, Deserialize)]
pub struct PlanLimits {
    #[serde(default)]
    pub devices: Option<u64>,
    #[serde(default)]
    pub agents: Option<u64>,
    #[serde(default)]
    pub humans: Option<u64>,
    #[serde(default)]
    pub session_retention_days: Option<u64>,
}

/// How much of the plan the workspace uses, as far as this core has read:
/// agents from the full roster, humans from the member list. Absent
/// counters were not read yet.
#[derive(Clone, Debug, PartialEq, Eq, Default, Serialize, JsonSchema, Deserialize)]
pub struct WorkspaceUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agents: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub humans: Option<u64>,
}

/// Which cap a refusal names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, JsonSchema, Deserialize)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-fallback" = "other"))]
pub enum PlanLimitKind {
    Devices,
    Agents,
    Humans,
    /// A cap this build does not know.
    Other,
}

impl PlanLimitKind {
    fn parse(value: &Value) -> Option<PlanLimitKind> {
        Some(match value.as_str()? {
            "devices" => PlanLimitKind::Devices,
            "agents" => PlanLimitKind::Agents,
            "humans" => PlanLimitKind::Humans,
            _ => PlanLimitKind::Other,
        })
    }

    /// The things the cap counts, for a sentence (`agents`).
    pub fn noun(self) -> &'static str {
        match self {
            PlanLimitKind::Devices => "devices",
            PlanLimitKind::Agents => "agents",
            PlanLimitKind::Humans => "humans",
            PlanLimitKind::Other => "items",
        }
    }
}

/// Relaycast refused something because the plan's cap is reached.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema, Deserialize)]
pub struct PlanLimitExceeded {
    pub limit: PlanLimitKind,
    /// The cap.
    pub max: u64,
    /// How many the workspace has now.
    pub current: u64,
    /// The plan's key (`intro`).
    pub plan: String,
}

impl PlanLimitExceeded {
    /// The structured refusal in a 429 body, when it carries one: the
    /// counters ride on the `error` object beside its `code`. A body with
    /// the error code but without the counters is not a refusal this type
    /// can describe.
    pub fn from_body(status: u16, body: &Value) -> Option<PlanLimitExceeded> {
        let error = &body["error"];
        if status != 429 || error["code"].as_str() != Some("plan_limit_exceeded") {
            return None;
        }
        Some(PlanLimitExceeded {
            limit: PlanLimitKind::parse(&error["limit"])?,
            max: error["max"].as_u64()?,
            current: error["current"].as_u64()?,
            plan: error["plan"].as_str()?.to_lowercase(),
        })
    }

    /// The refusal in an SDK error, from the body it kept.
    pub fn from_relaycast(error: &relaycast::RelayError) -> Option<PlanLimitExceeded> {
        match error {
            relaycast::RelayError::Api {
                status,
                details: Some(details),
                ..
            } => PlanLimitExceeded::from_body(*status, details),
            _ => None,
        }
    }

    /// The plan's name for a sentence.
    pub fn plan_name(&self) -> String {
        plan_name(&self.plan)
    }

    /// Why it was refused, safe to show.
    pub fn message(&self) -> String {
        format!(
            "This workspace is using {} of {} {} on the {} plan. Upgrade the plan to add more.",
            self.current,
            self.max,
            self.limit.noun(),
            self.plan_name()
        )
    }
}

/// A plan key's display name: `intro` is `Intro`.
pub fn plan_name(key: &str) -> String {
    let key = key.trim();
    let mut chars = key.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// `current_workspace.plan` as whoami sends it; `None` for `null`, for an
/// older Cloud that sends nothing, and for a value without the key.
pub fn parse_workspace_plan(value: &Value) -> Option<WorkspacePlan> {
    let text = |key: &str| {
        value[key]
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };
    let key = text("key")?.to_lowercase();
    let limits = &value["limits"];
    let limit = |field: &str| limits[field].as_u64();
    Some(WorkspacePlan {
        name: text("name").unwrap_or_else(|| plan_name(&key)),
        key,
        limits: PlanLimits {
            devices: limit("devices"),
            agents: limit("agents"),
            humans: limit("humans"),
            session_retention_days: limit("session_retention_days"),
        },
        upgrade_url: text("upgrade_url").filter(|url| url.starts_with("https://")),
    })
}

/// What a history listing says when older sessions were left out: the
/// plan keeps `days` of history, from `cutoff` (ISO-8601) on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema, Deserialize)]
pub struct HistoryRetention {
    pub days: u64,
    pub cutoff: String,
}

impl HistoryRetention {
    /// `retention` on a history page, when the server truncated it.
    pub fn parse(value: &Value) -> Option<HistoryRetention> {
        Some(HistoryRetention {
            days: value["days"].as_u64()?,
            cutoff: value["cutoff"]
                .as_str()
                .filter(|cutoff| !cutoff.is_empty())?
                .to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn whoami_plan_reads_the_contract_shape_and_tolerates_its_absence() {
        let plan = parse_workspace_plan(&json!({
            "key": "intro", "name": "Intro",
            "limits": {"devices": 5, "agents": 15, "humans": 2, "session_retention_days": 7},
            "upgrade_url": "https://agentrelay.com/cloud/dashboard/settings#billing"
        }))
        .unwrap();
        assert_eq!(plan.key, "intro");
        assert_eq!(plan.name, "Intro");
        assert_eq!(plan.limits.agents, Some(15));
        assert_eq!(plan.limits.humans, Some(2));
        assert_eq!(plan.limits.devices, Some(5));
        assert_eq!(plan.limits.session_retention_days, Some(7));
        assert_eq!(
            plan.upgrade_url.as_deref(),
            Some("https://agentrelay.com/cloud/dashboard/settings#billing")
        );
        // Enterprise: unlimited counters are null; retention stays a number.
        let enterprise = parse_workspace_plan(&json!({
            "key": "enterprise", "name": "Enterprise",
            "limits": {"devices": null, "agents": null, "humans": null, "session_retention_days": 365}
        }))
        .unwrap();
        assert_eq!(
            enterprise.limits,
            PlanLimits {
                session_retention_days: Some(365),
                ..Default::default()
            }
        );
        assert_eq!(enterprise.upgrade_url, None);
        // No plan, an older Cloud, and junk all read as no plan.
        assert_eq!(parse_workspace_plan(&Value::Null), None);
        assert_eq!(parse_workspace_plan(&json!({})), None);
        assert_eq!(parse_workspace_plan(&json!({"name": "Intro"})), None);
        // A name is derived from the key when Cloud sends none; only https
        // upgrade links are kept.
        let bare =
            parse_workspace_plan(&json!({"key": "pro", "upgrade_url": "javascript:alert(1)"}))
                .unwrap();
        assert_eq!(bare.name, "Pro");
        assert_eq!(bare.upgrade_url, None);
        assert_eq!(bare.limits, PlanLimits::default());
    }

    /// A refusal as Relaycast renders it: the host's details beside the
    /// code on `error`, nothing else on the top level.
    fn denial_body(limit: &str, max: u64, current: u64, plan: &str) -> Value {
        json!({
            "ok": false,
            "error": {
                "code": "plan_limit_exceeded",
                "message": "limit reached",
                "limit": limit, "max": max, "current": current, "plan": plan,
                "upgrade_url": "https://agentrelay.com/cloud/dashboard/settings#billing"
            }
        })
    }

    #[test]
    fn a_structured_429_reads_as_a_typed_refusal() {
        let body = denial_body("agents", 15, 15, "intro");
        let refusal = PlanLimitExceeded::from_body(429, &body).unwrap();
        assert_eq!(refusal.limit, PlanLimitKind::Agents);
        assert_eq!((refusal.max, refusal.current), (15, 15));
        assert_eq!(refusal.plan, "intro");
        assert_eq!(
            refusal.message(),
            "This workspace is using 15 of 15 agents on the Intro plan. Upgrade the plan to add more."
        );
        assert_eq!(PlanLimitExceeded::from_body(200, &body), None);
        assert_eq!(
            PlanLimitExceeded::from_body(
                429,
                &json!({"ok": false, "error": {"code": "plan_limit_exceeded", "message": "limit"}})
            ),
            None,
            "a body without counters is not typed"
        );
        let mut throttled = denial_body("agents", 1, 1, "intro");
        throttled["error"]["code"] = "rate_limit_exceeded".into();
        assert_eq!(PlanLimitExceeded::from_body(429, &throttled), None);
        // Counters on the top level, where no server puts them, are not read.
        assert_eq!(
            PlanLimitExceeded::from_body(
                429,
                &json!({"ok": false, "error": {"code": "plan_limit_exceeded"}, "limit": "agents", "max": 1, "current": 1, "plan": "intro"})
            ),
            None
        );
        let unknown =
            PlanLimitExceeded::from_body(429, &denial_body("channels", 3, 3, "pro")).unwrap();
        assert_eq!(unknown.limit, PlanLimitKind::Other);
        assert_eq!(
            unknown.message(),
            "This workspace is using 3 of 3 items on the Pro plan. Upgrade the plan to add more."
        );
    }

    #[test]
    fn the_sdk_error_keeps_the_body_the_refusal_is_read_from() {
        let error = relaycast::RelayError::Api {
            code: "plan_limit_exceeded".into(),
            message: "limit".into(),
            status: 429,
            request_id: None,
            attempts: 1,
            retry_after_ms: None,
            details: Some(denial_body("humans", 2, 2, "intro")),
        };
        let refusal = PlanLimitExceeded::from_relaycast(&error).unwrap();
        assert_eq!(refusal.limit, PlanLimitKind::Humans);
        assert_eq!((refusal.max, refusal.current), (2, 2));
        assert_eq!(
            PlanLimitExceeded::from_relaycast(&relaycast::RelayError::api(
                "plan_limit_exceeded",
                "x",
                429
            )),
            None
        );
    }

    #[test]
    fn retention_reads_days_and_cutoff() {
        let retention =
            HistoryRetention::parse(&json!({"days": 7, "cutoff": "2026-10-18T00:00:00Z"})).unwrap();
        assert_eq!(retention.days, 7);
        assert_eq!(retention.cutoff, "2026-10-18T00:00:00Z");
        assert_eq!(HistoryRetention::parse(&Value::Null), None);
        assert_eq!(HistoryRetention::parse(&json!({"cutoff": "x"})), None);
        assert_eq!(HistoryRetention::parse(&json!({"days": 7})), None);
        assert_eq!(
            HistoryRetention::parse(&json!({"days": 7, "cutoff": ""})),
            None
        );
    }

    #[test]
    fn every_type_round_trips_and_reads_older_shapes() {
        let plan: WorkspacePlan =
            serde_json::from_value(json!({"key": "intro", "name": "Intro", "limits": {}})).unwrap();
        assert_eq!(plan.limits, PlanLimits::default());
        assert_eq!(plan.upgrade_url, None);
        let usage: WorkspaceUsage = serde_json::from_value(json!({})).unwrap();
        assert_eq!(usage, WorkspaceUsage::default());
        let refusal = PlanLimitExceeded {
            limit: PlanLimitKind::Devices,
            max: 5,
            current: 5,
            plan: "intro".into(),
        };
        let wire = serde_json::to_value(&refusal).unwrap();
        assert_eq!(wire["limit"], "devices");
        assert_eq!(
            serde_json::from_value::<PlanLimitExceeded>(wire).unwrap(),
            refusal
        );
        assert_eq!(plan_name("enterprise"), "Enterprise");
        assert_eq!(plan_name(""), "");
    }
}
