use std::{fs, path::Path};

use relay_broker::fleet_wire::{NodeToServer, ServerToNode};
use serde_json::Value;

const FIXTURE_DIR: &str = "tests/fixtures/fleet-wire";

const NODE_TO_SERVER_TYPES: &[&str] = &[
    "node.register",
    "node.heartbeat",
    "node.deregister",
    "agent.register",
    "agent.deregister",
    "delivery.ack",
    "action.result",
    "inventory.sync",
];

const SERVER_TO_NODE_TYPES: &[&str] = &["deliver", "action.invoke", "ping"];

#[test]
fn fleet_wire_fixtures_round_trip_semantically() {
    let fixture_dir = Path::new(FIXTURE_DIR);
    let mut fixture_paths = fs::read_dir(fixture_dir)
        .unwrap_or_else(|error| panic!("failed to read {FIXTURE_DIR}: {error}"))
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    fixture_paths.sort();

    assert!(
        !fixture_paths.is_empty(),
        "expected at least one fixture in {FIXTURE_DIR}"
    );

    for path in fixture_paths {
        let raw = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));
        let fixture: Value = serde_json::from_str(&raw)
            .unwrap_or_else(|error| panic!("invalid json in {}: {error}", path.display()));
        let msg_type = fixture
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("missing string type in {}", path.display()));

        let encoded = if NODE_TO_SERVER_TYPES.contains(&msg_type) {
            let decoded: NodeToServer = serde_json::from_value(fixture.clone())
                .unwrap_or_else(|error| panic!("failed to decode {}: {error}", path.display()));
            serde_json::to_value(decoded)
                .unwrap_or_else(|error| panic!("failed to re-encode {}: {error}", path.display()))
        } else if SERVER_TO_NODE_TYPES.contains(&msg_type) {
            let decoded: ServerToNode = serde_json::from_value(fixture.clone())
                .unwrap_or_else(|error| panic!("failed to decode {}: {error}", path.display()));
            serde_json::to_value(decoded)
                .unwrap_or_else(|error| panic!("failed to re-encode {}: {error}", path.display()))
        } else {
            panic!("unknown fleet wire type {msg_type:?} in {}", path.display());
        };

        assert_eq!(encoded, fixture, "fixture drift in {}", path.display());
    }
}
