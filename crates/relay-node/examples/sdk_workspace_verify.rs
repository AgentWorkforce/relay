//! Verify an existing workspace through the production SDK transport.
//! Read credentials only from bounded standard input; emit no server payload.
use agent_relay_node::relay::{
    client,
    workspace::{is_workspace_key, validated_base_url, Secret, Workspace, WorkspaceSource},
};
use serde::Deserialize;
use std::io::Read;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    origin: String,
    key: String,
    expected_workspace_id: String,
}

#[tokio::main]
async fn main() {
    let mut bytes = Vec::new();
    if std::io::stdin()
        .take(16_385)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() > 16_384
    {
        refused();
    }
    let input: Input = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => refused(),
    };
    let origin = match validated_base_url(&input.origin) {
        Some(value) => value,
        None => refused(),
    };
    if !is_workspace_key(&input.key) || input.expected_workspace_id.is_empty() {
        refused();
    }
    let workspace = Workspace {
        key: Secret::new(input.key),
        base_url: origin,
        workspace_id: Some(input.expected_workspace_id.clone()),
        source: WorkspaceSource::Cloud,
        control_url: None,
    };
    match client::workspace_info(&workspace).await {
        Ok(info) if info.id == input.expected_workspace_id => {
            println!("{{\"result\":\"PASS\",\"workspaceMatches\":true}}")
        }
        Ok(_) => {
            println!("{{\"result\":\"REFUSED_WORKSPACE_MISMATCH\"}}");
            std::process::exit(2);
        }
        Err(_) => {
            println!("{{\"result\":\"SDK_REQUEST_FAILED\"}}");
            std::process::exit(1);
        }
    }
}
fn refused() -> ! {
    println!("{{\"result\":\"REFUSED_INPUT\"}}");
    std::process::exit(2)
}
