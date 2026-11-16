//! The relaygate client against a live relaygate, end to end. It runs only
//! when `RELAYGATE_URL` names a gate (a bare https origin) and
//! `RELAYGATE_DEVICE_TOKEN_FILE` names a file holding a desktop device token
//! (`sh_at_…` with `cli:auth`); without `RELAYGATE_URL` it passes without
//! doing anything. The token is read from the file only and never printed.
//!
//! The gate's certificate must chain to a root in the operating system's
//! trust store: the relay core refuses `SSL_CERT_FILE` and `SSL_CERT_DIR`
//! overrides, so this test does too.
//!
//! ```text
//! RELAYGATE_URL=https://gate.example.com \
//! RELAYGATE_DEVICE_TOKEN_FILE=/path/to/device-token \
//!   cargo test -p agent-relay-node --test relaygate_live -- --nocapture
//! ```

use agent_relay_node::relay::sdk_gaps::{
    self, gate_delete_self, gate_patch_self, gate_register, new_recovery, GateError, GateSelfPatch,
};
use agent_relay_node::relay::workspace::Secret;
use serde_json::{json, Map, Value};

/// The live gate and the device token, or `None` when no gate is named.
fn live_gate() -> Option<(String, Secret)> {
    let url = std::env::var("RELAYGATE_URL").ok()?.trim().to_string();
    if url.is_empty() {
        return None;
    }
    for name in ["SSL_CERT_FILE", "SSL_CERT_DIR"] {
        assert!(
            std::env::var_os(name).is_none_or(|value| value.is_empty()),
            "{name} is set, and the relay core refuses certificate file overrides: unset it and \
             install the gate's CA in the operating system trust store"
        );
    }
    let path = std::env::var_os("RELAYGATE_DEVICE_TOKEN_FILE")
        .filter(|path| !path.is_empty())
        .expect(
            "RELAYGATE_URL is set, so RELAYGATE_DEVICE_TOKEN_FILE must name the device token file",
        );
    let token = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read RELAYGATE_DEVICE_TOKEN_FILE: {error}"));
    let token = token.trim();
    assert!(
        token.starts_with("sh_at_"),
        "RELAYGATE_DEVICE_TOKEN_FILE does not hold an sh_at_ device token"
    );
    Some((url, Secret::new(token)))
}

/// `ci-` and 8 random lower-case letters and digits.
fn fresh_name() -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut bytes = [0u8; 8];
    getrandom::getrandom(&mut bytes).unwrap();
    let suffix: String = bytes
        .iter()
        .map(|byte| ALPHABET[usize::from(*byte) % ALPHABET.len()] as char)
        .collect();
    format!("ci-{suffix}")
}

fn step(name: &str, outcome: impl std::fmt::Display) {
    println!("relaygate {name:<24} {outcome}");
}

#[tokio::test]
async fn relaygate_enrolment_end_to_end() {
    let Some((gate, device)) = live_gate() else {
        return;
    };
    let name = fresh_name();
    let recovery = new_recovery().unwrap();
    step("gate", &gate);

    let first = gate_register(&gate, &device, &name, recovery.expose())
        .await
        .unwrap_or_else(|error| panic!("register {name}: {error}"));
    assert!(first.token.expose().starts_with("rg_"));
    assert!(first.expires_at > chrono::Utc::now(), "{first:?}");
    step(
        "register",
        format_args!(
            "ok name={name} agent_id={} gid={} expires_at={}",
            first.agent_id, first.gid, first.expires_at
        ),
    );

    let second = gate_register(&gate, &device, &name, recovery.expose())
        .await
        .unwrap_or_else(|error| panic!("register {name} again: {error}"));
    assert_eq!(second.agent_id, first.agent_id);
    assert_ne!(second.token, first.token);
    assert!(second.token.expose().starts_with("rg_"));
    step(
        "register again",
        format_args!(
            "ok same agent_id, new token, expires_at={}",
            second.expires_at
        ),
    );

    let old = gate_patch_self(&gate, &first.token, &GateSelfPatch::default()).await;
    assert!(
        matches!(old, Err(GateError::Unauthenticated)),
        "the replaced token still works: {old:?}"
    );
    step("replaced token", "ok 401 relaygate_unauthenticated");

    let agent = sdk_gaps::http(&gate, &second.token).unwrap();
    let deliveries = sdk_gaps::deliveries(&agent, 10)
        .await
        .unwrap_or_else(|error| panic!("GET /v1/deliveries: {error}"));
    step(
        "GET /v1/deliveries",
        format_args!("ok {} deliveries", deliveries.len()),
    );

    let node: Value = agent
        .post("/v1/agent/node-token", Some(json!({})), None)
        .await
        .unwrap_or_else(|error| panic!("POST /v1/agent/node-token: {error}"));
    let node_token = node.get("token").and_then(Value::as_str).unwrap_or("");
    assert!(
        node_token.starts_with("rgn_"),
        "POST /v1/agent/node-token answered no rgn_ token"
    );
    step("POST /v1/agent/node-token", "ok rgn_ token");

    let patch = GateSelfPatch {
        metadata: Some(Map::from_iter([("ci".to_string(), json!(true))])),
        ..GateSelfPatch::default()
    };
    gate_patch_self(&gate, &second.token, &patch)
        .await
        .unwrap_or_else(|error| panic!("PATCH /v1/agent: {error}"));
    step("PATCH /v1/agent", "ok");

    gate_delete_self(&gate, &second.token)
        .await
        .unwrap_or_else(|error| panic!("DELETE /v1/agent: {error}"));
    step("DELETE /v1/agent", "ok");

    // The token current until the DELETE is the one it must revoke (the
    // first was revoked by re-registration already, checked above).
    let revoked = gate_patch_self(&gate, &second.token, &GateSelfPatch::default()).await;
    assert!(
        matches!(revoked, Err(GateError::Unauthenticated)),
        "the deleted agent's token still works: {revoked:?}"
    );
    step("deleted agent's token", "ok 401 relaygate_unauthenticated");
}
