use agent_relay_node::relay::{contract::agents::IntegrationParams, store::Integration};
use serde_json::{json, Value};

#[test]
fn exact_provider_event_contract_probe() {
    let request = json!({"name":"proof", "provider":"jira", "resource":"/jira/issues/**", "event_types":["comment.created"]});
    let parsed: IntegrationParams = serde_json::from_value(request).unwrap();
    let echoed = serde_json::to_value(parsed).unwrap();
    let mut stored =
        serde_json::to_value(Integration::new("jira", "/jira/issues/**", "rw_proof")).unwrap();
    stored["eventTypes"] = json!(["comment.created"]);
    let parsed: Integration = serde_json::from_value(stored).unwrap();
    let restored = serde_json::to_value(parsed).unwrap();
    let retained = echoed.get("event_types") == Some(&json!(["comment.created"]))
        && restored.get("eventTypes") == Some(&json!(["comment.created"]));
    println!(
        "PROVIDER_EVENT_FILTER_PROBE={}",
        json!({"retained":retained, "request":echoed.get("event_types").unwrap_or(&Value::Null), "stored":restored.get("eventTypes").unwrap_or(&Value::Null)})
    );
}
