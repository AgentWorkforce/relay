//! Fixed native Relaycast operations authenticated inside the same-user core.
//! This is deliberately not an HTTP proxy: callers supply no URL, token, headers or output schema.
use crate::relay::contract::spawn_control::*;
use crate::relay::contract::{answer, method};
use crate::relay::daemon::Core;
use crate::relay::diagnostic_http::HttpClient;
use crate::relay::protocol::{ErrorKind, RpcError};
use crate::relay::sdk_gaps;
use crate::relay::store::{Registration, Store};
use crate::relay::workspace::{Secret, Workspace};
use relaycast::RequestOptions;
use serde_json::{json, Value};
use std::sync::Arc;
mod claims;

pub(crate) async fn call(
    core: &Arc<Core>,
    name: &str,
    raw: Value,
) -> Option<Result<Value, RpcError>> {
    match name {
        method::SpawnTargets::NAME => Some(
            answer::<method::SpawnTargets, _>(raw, |_| async {
                targets(&workspace_http(core)?).await
            })
            .await,
        ),
        method::SpawnInvoke::NAME => Some(
            answer::<method::SpawnInvoke, _>(raw, |params| async { invoke(core, params).await })
                .await,
        ),
        method::SpawnInvocation::NAME => Some(
            answer::<method::SpawnInvocation, _>(raw, |params| async {
                invocation(core, params).await
            })
            .await,
        ),
        method::SpawnRelease::NAME => Some(
            answer::<method::SpawnRelease, _>(raw, |params| async { release(core, params).await })
                .await,
        ),
        method::SpawnClaimRetry::NAME => Some(
            answer::<method::SpawnClaimRetry, _>(raw, |_| async {
                core.retry_spawn_claim();
                Ok(crate::relay::contract::Done {})
            })
            .await,
        ),
        _ => None,
    }
}

fn invalid() -> RpcError {
    RpcError::invalid_params("Native spawn input is invalid.")
}
fn refused() -> RpcError {
    RpcError::new(
        ErrorKind::Refused,
        "The exact active local spawn identity is required.",
    )
}
fn malformed() -> RpcError {
    RpcError::new(
        ErrorKind::Internal,
        "Agent Relay returned an unreadable native spawn result.",
    )
}

fn segment(value: &str) -> Result<(), RpcError> {
    if value.is_empty()
        || value.len() > 200
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    {
        return Err(invalid());
    }
    Ok(())
}

fn key(value: &str) -> Result<(), RpcError> {
    segment(value)?;
    if value.len() < 16 {
        return Err(invalid());
    }
    Ok(())
}

fn active(registration: &Registration, workspace: &Workspace) -> bool {
    registration.archived_at.is_none()
        && registration.missing_since.is_none()
        && in_workspace(registration, workspace)
}

/// Whether `registration` belongs to `workspace`, running or not. A spawned
/// worker that crashed or ended keeps its registration and name until it
/// is released, so its exact identity must stay readable and releasable.
fn in_workspace(registration: &Registration, workspace: &Workspace) -> bool {
    registration.base_url == workspace.base_url
        && registration.workspace_key.as_ref() == Some(&workspace.key)
}

fn caller_token(store: &Store, workspace: &Workspace, name: &str) -> Result<Secret, RpcError> {
    segment(name)?;
    if !store
        .registrations
        .iter()
        .any(|r| r.name == name && active(r, workspace))
    {
        return Err(refused());
    }
    store
        .tokens
        .get(name)
        .filter(|token| !token.expose().is_empty())
        .cloned()
        .ok_or_else(refused)
}

fn workspace(core: &Core) -> Result<Workspace, RpcError> {
    core.workspace().ok_or_else(|| {
        RpcError::new(
            ErrorKind::NotSignedIn,
            "An active Agent Relay workspace is required.",
        )
    })
}
fn workspace_http(core: &Core) -> Result<HttpClient, RpcError> {
    let workspace = workspace(core)?;
    sdk_gaps::http(&workspace.base_url, &workspace.key).map_err(|e| RpcError::from_relaycast(&e))
}
fn caller_http_in(core: &Core, workspace: &Workspace, name: &str) -> Result<HttpClient, RpcError> {
    let token = core
        .store
        .read(|store| caller_token(store, workspace, name))?;
    sdk_gaps::http(&workspace.base_url, &token).map_err(|e| RpcError::from_relaycast(&e))
}

fn field(value: &Value, name: &str) -> Result<String, RpcError> {
    let value = value[name].as_str().ok_or_else(malformed)?;
    segment(value).map_err(|_| malformed())?;
    Ok(value.to_string())
}

fn target(value: &Value) -> Result<SpawnControlTarget, RpcError> {
    let count = |name| value[name].as_u64().ok_or_else(malformed);
    let capabilities = value["capabilities"]
        .as_array()
        .ok_or_else(malformed)?
        .iter()
        .filter_map(|v| v.as_str().or_else(|| v["name"].as_str()))
        .filter(|v| {
            v.strip_prefix("spawn:")
                .and_then(crate::relay::harness::HarnessId::from_name)
                .is_some()
        })
        .map(str::to_string)
        .collect();
    let reserved = value
        .get("reserved_agents")
        .map(Value::as_u64)
        .unwrap_or(Some(0));
    Ok(SpawnControlTarget {
        id: field(value, "id")?,
        name: field(value, "name")?,
        live: value["live"] == true,
        handlers_live: value["handlers_live"] == true,
        stale: value["live"] != true || value["active_agents_stale"] == true || reserved.is_none(),
        capabilities,
        active_agents: count("active_agents")?,
        reserved_agents: reserved.unwrap_or(0),
        max_agents: count("max_agents")?,
    })
}
async fn targets(http: &HttpClient) -> Result<SpawnTargets, RpcError> {
    let data: Value = http
        .get(
            "/v1/nodes",
            Some(&[("status", "online"), ("limit", "100")]),
            None,
        )
        .await
        .map_err(|e| RpcError::from_relaycast(&e))?;
    Ok(SpawnTargets {
        targets: data
            .as_array()
            .ok_or_else(malformed)?
            .iter()
            .map(target)
            .collect::<Result<_, _>>()?,
    })
}

fn receipt(data: &Value) -> Result<SpawnControlInvocation, RpcError> {
    let id = data
        .get("invocation_id")
        .or_else(|| data.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(malformed)?;
    segment(id).map_err(|_| malformed())?;
    let status = data["status"]
        .as_str()
        .filter(|s| ["pending", "dispatched", "running", "completed", "failed"].contains(s))
        .ok_or_else(malformed)?;
    let output = &data["output"];
    let code = error_code(data);
    Ok(SpawnControlInvocation {
        id: id.into(),
        agent_id: None,
        status: status.into(),
        node_id: data
            .get("dispatched_node_id")
            .or_else(|| data.get("handler_node_id"))
            .and_then(Value::as_str)
            .filter(|s| segment(s).is_ok())
            .map(str::to_string),
        name: output["name"]
            .as_str()
            .filter(|s| segment(s).is_ok())
            .map(str::to_string),
        spawned: output["spawned"] == true,
        ready: output["ready"] == true,
        task_unconfirmed: output["warning"] == "spawn_task_unconfirmed"
            || output["warning"]["code"] == "spawn_task_unconfirmed",
        error_code: code,
    })
}

/// Only stable allowlisted codes cross the bridge. Legacy plain errors append
/// free-form reasons; structured details are projected to their code alone.
fn error_code(data: &Value) -> Option<String> {
    let known = |candidate: &str| {
        [
            "spawn_failed",
            "spawn_invalid_input",
            "spawn_harness_unavailable",
            "spawn_harness_unsupported",
            "spawn_capacity_exceeded",
            "capacity_changed",
            "spawn_target_unavailable",
            "spawn_target_offline",
            "spawn_agent_name_in_use",
            "spawn_disabled",
            "release_identity_mismatch",
            "release_failed",
            "handler_unavailable",
            "capability_mismatch",
        ]
        .contains(&candidate)
    };
    let plain = data["error"]
        .as_str()
        .map(|error| error.split(':').next().unwrap_or("").trim())
        .filter(|code| known(code));
    let structured = data["error_details"]["code"]
        .as_str()
        .filter(|code| known(code));
    plain.or(structured).map(str::to_string)
}

async fn invoke(
    core: &Core,
    params: SpawnInvokeParams,
) -> Result<SpawnControlInvocation, RpcError> {
    for value in [&params.node_id, &params.node_name, &params.name] {
        segment(value)?;
    }
    key(&params.idempotency_key)?;
    // Only this computer's own node: status and release bind a worker to
    // the exact identity its local registration saved, which a spawn on
    // another computer never leaves here.
    if params.node_name != super::node_name(&core.machine_prefix) {
        return Err(RpcError::new(
            ErrorKind::Refused,
            "Native spawn starts agents only on this computer's own spawn node.",
        ));
    }
    let harness =
        crate::relay::harness::HarnessId::from_name(&params.harness).ok_or_else(invalid)?;
    if params.task.trim().is_empty()
        || params.task.len() > 64 * 1024
        || !std::path::Path::new(&params.directory).is_absolute()
        || params.directory.contains('\0')
    {
        return Err(invalid());
    }
    let workspace = workspace(core)?;
    let http = caller_http_in(core, &workspace, &params.caller_name)?;
    let workspace_client = sdk_gaps::http(&workspace.base_url, &workspace.key)
        .map_err(|e| RpcError::from_relaycast(&e))?;
    let listed = targets(&workspace_client).await?;
    if !listed.targets.iter().any(|t| {
        t.id == params.node_id
            && t.name == params.node_name
            && t.live
            && t.handlers_live
            && !t.stale
            && t.capabilities.contains(&harness.capability())
    }) {
        return Err(refused());
    }
    let body = json!({"input": {"name": params.name, "cli": params.harness, "task": params.task, "target_node": params.node_name, "worker_cwd": params.directory, "verify_ready": true}});
    let result: Value = http
        .post(
            "/v1/actions/spawn/invoke",
            Some(body),
            Some(RequestOptions::with_idempotency_key(params.idempotency_key)),
        )
        .await
        .map_err(|e| RpcError::from_relaycast(&e))?;
    receipt(&result)
}

async fn invocation(
    core: &Core,
    params: SpawnInvocationParams,
) -> Result<SpawnControlInvocation, RpcError> {
    segment(&params.invocation_id)?;
    let workspace = workspace(core)?;
    let action = match params.action {
        SpawnControlAction::Spawn => "spawn",
        SpawnControlAction::Release => "release",
    };
    let path = format!("/v1/actions/{action}/invocations/{}", params.invocation_id);
    let data: Value = caller_http_in(core, &workspace, &params.caller_name)?
        .get(&path, None, None)
        .await
        .map_err(|e| RpcError::from_relaycast(&e))?;
    let receipt = receipt(&data)?;
    if receipt.id != params.invocation_id {
        return Err(malformed());
    }
    if action == "spawn" {
        return core
            .store
            .read(|store| local_spawn_identity(receipt, store, &workspace));
    }
    Ok(receipt)
}

fn local_spawn_identity(
    mut receipt: SpawnControlInvocation,
    store: &Store,
    workspace: &Workspace,
) -> Result<SpawnControlInvocation, RpcError> {
    let mut found = store.registrations.iter().filter(|registration| {
        in_workspace(registration, workspace)
            && registration
                .spawn
                .as_ref()
                .is_some_and(|spawn| spawn.invocation_id == receipt.id)
    });
    if let Some(registration) = found.next() {
        if found.next().is_some() {
            return Err(refused());
        }
        receipt.agent_id = Some(registration.agent_id.clone());
        receipt.name = Some(registration.name.clone());
        receipt.node_id = registration
            .spawn
            .as_ref()
            .map(|spawn| spawn.node_id.clone());
    }
    Ok(receipt)
}

/// Whether the worker to release is exactly one this computer saved, in
/// `workspace`; whether it still runs does not matter.
fn release_target(store: &Store, workspace: &Workspace, params: &SpawnReleaseParams) -> bool {
    store.registrations.iter().any(|r| {
        r.name == params.name
            && r.agent_id == params.expected_agent_id
            && in_workspace(r, workspace)
            && r.spawn
                .as_ref()
                .is_some_and(|s| s.node_id == params.node_id && s.node_name == params.node_name)
    })
}

async fn release(
    core: &Core,
    params: SpawnReleaseParams,
) -> Result<SpawnControlInvocation, RpcError> {
    for value in [
        &params.node_id,
        &params.node_name,
        &params.name,
        &params.expected_agent_id,
    ] {
        segment(value)?;
    }
    key(&params.idempotency_key)?;
    let workspace = workspace(core)?;
    let http = caller_http_in(core, &workspace, &params.caller_name)?;
    let caller_id = core
        .store
        .read(|store| {
            store
                .registrations
                .iter()
                .find(|r| r.name == params.caller_name && active(r, &workspace))
                .map(|r| r.agent_id.clone())
        })
        .ok_or_else(refused)?;
    let exact = core
        .store
        .read(|store| release_target(store, &workspace, &params));
    claims::release(
        &core.config.app_data_dir,
        &workspace,
        &caller_id,
        &params,
        exact,
    )?;
    let body = json!({"name": params.name, "expected_agent_id": params.expected_agent_id, "delete_agent": true, "reason": "Released through native desktop spawn controls"});
    let data: Value = http
        .post(
            "/v1/agents/release-exact",
            Some(body),
            Some(RequestOptions::with_idempotency_key(params.idempotency_key)),
        )
        .await
        .map_err(|e| RpcError::from_relaycast(&e))?;
    receipt(&data)
}

#[cfg(test)]
mod tests;
