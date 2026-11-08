//! Fixed native Relaycast operations authenticated inside the same-user core.
//! This is deliberately not an HTTP proxy: callers supply no URL, token, headers or output schema.
use crate::relay::contract::spawn_control::*;
use crate::relay::contract::{answer, method};
use crate::relay::daemon::{
    CallContext, Core, ExternalCaller, SpawnCall, SpawnCallerResolution, SpawnCallers, SpawnRequest,
};
use crate::relay::diagnostic_http::HttpClient;
use crate::relay::protocol::{ErrorKind, RefusalReason, RpcError};
use crate::relay::sdk_gaps;
use crate::relay::store::{Registration, Store};
use crate::relay::workspace::{Secret, Workspace};
use relaycast::RequestOptions;
use serde_json::{json, Value};
use std::sync::Arc;
mod claims;

pub(crate) async fn call(
    core: &Arc<Core>,
    context: &CallContext,
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
        method::SpawnCallerChallenge::NAME => Some(
            answer::<method::SpawnCallerChallenge, _>(raw, |params| async {
                caller_challenge(core, context, params).await
            })
            .await,
        ),
        method::SpawnCallerAuthenticate::NAME => Some(
            answer::<method::SpawnCallerAuthenticate, _>(raw, |params| async {
                caller_authenticate(core, context, params).await
            })
            .await,
        ),
        method::SpawnInvoke::NAME => Some(
            answer::<method::SpawnInvoke, _>(raw, |params| async {
                invoke(core, context, params).await
            })
            .await,
        ),
        method::SpawnInvocation::NAME => Some(
            answer::<method::SpawnInvocation, _>(raw, |params| async {
                invocation(core, context, params).await
            })
            .await,
        ),
        method::SpawnRelease::NAME => Some(
            answer::<method::SpawnRelease, _>(raw, |params| async {
                release(core, context, params).await
            })
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
fn not_owner() -> RpcError {
    RpcError::refused_because(
        RefusalReason::NotOwner,
        "This caller did not start that agent.",
    )
}
fn outside_scope() -> RpcError {
    RpcError::refused_because(
        RefusalReason::OutsideScope,
        "That harness or folder is outside this caller's limits.",
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

/// Who calls a native spawn control: a session registration, named alone,
/// or a caller the [`SpawnCallers`] plugin bound to this connection.
enum Caller {
    Session {
        agent_id: String,
        token: Secret,
    },
    External {
        caller: ExternalCaller,
        plugin: Arc<dyn SpawnCallers>,
    },
}

impl Caller {
    fn agent_id(&self) -> &str {
        match self {
            Caller::Session { agent_id, .. } => agent_id,
            Caller::External { caller, .. } => &caller.agent_id,
        }
    }

    fn http(&self, workspace: &Workspace) -> Result<HttpClient, RpcError> {
        let token = match self {
            Caller::Session { token, .. } => token,
            Caller::External { caller, .. } => &caller.token,
        };
        sdk_gaps::http(&workspace.base_url, token).map_err(|e| RpcError::from_relaycast(&e))
    }

    fn external(&self) -> Option<&ExternalCaller> {
        match self {
            Caller::Session { .. } => None,
            Caller::External { caller, .. } => Some(caller),
        }
    }

    /// Runs `run` as `call`: a session caller's directly, an external
    /// caller's only once the plugin admits it, recording what came of it.
    async fn admitted<F>(
        &self,
        call: SpawnCall<'_>,
        run: F,
    ) -> Result<SpawnControlInvocation, RpcError>
    where
        F: std::future::Future<Output = Result<SpawnControlInvocation, RpcError>>,
    {
        let Caller::External { caller, plugin } = self else {
            return run.await;
        };
        let permit = plugin.admit(caller, &call)?;
        let outcome = run.await;
        plugin.record(permit, &outcome);
        outcome
    }
}

async fn caller_challenge(
    core: &Core,
    context: &CallContext,
    params: SpawnCallerChallengeParams,
) -> Result<SpawnCallerChallenge, RpcError> {
    segment(&params.caller_name)?;
    let workspace = workspace(core)?;
    let connection_id = context.connection_id.ok_or_else(refused)?;
    let plugin = core.plugins.spawn_callers.clone().ok_or_else(refused)?;
    let challenge = plugin.challenge(&workspace, connection_id, &params.caller_name)?;
    const PREFIX: &str = "agent-relay/spawn-caller/v1:";
    let Some(nonce) = challenge.challenge.strip_prefix(PREFIX) else {
        return Err(malformed());
    };
    if nonce.len() != 43
        || !nonce
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(malformed());
    }
    Ok(challenge)
}

async fn caller_authenticate(
    core: &Core,
    context: &CallContext,
    params: SpawnCallerAuthenticateParams,
) -> Result<SpawnCallerAuthenticated, RpcError> {
    segment(&params.caller_name)?;
    if params.challenge.is_empty()
        || params.challenge.len() > 512
        || params.authenticator.len() != 64
        || !params
            .authenticator
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(invalid());
    }
    let workspace = workspace(core)?;
    let connection_id = context.connection_id.ok_or_else(refused)?;
    let plugin = core.plugins.spawn_callers.clone().ok_or_else(refused)?;
    plugin.authenticate(&workspace, connection_id, &params)
}

/// Resolves an external caller first on every request. Only an explicit
/// `NotExternal` falls through to the legacy active-session lookup; a known
/// but unbound, stale, disabled, expired or revoked external caller is refused.
fn caller_in(
    core: &Core,
    workspace: &Workspace,
    context: &CallContext,
    name: &str,
) -> Result<Caller, RpcError> {
    segment(name)?;
    if let Some(plugin) = core.plugins.spawn_callers.clone() {
        match plugin.resolve(workspace, context.connection_id, name) {
            SpawnCallerResolution::BoundExternal(caller) => {
                if caller.token.expose().is_empty()
                    || segment(&caller.agent_id).is_err()
                    || caller.name != name
                {
                    return Err(refused());
                }
                return Ok(Caller::External { caller, plugin });
            }
            SpawnCallerResolution::Refused(error) => return Err(error),
            SpawnCallerResolution::NotExternal => {}
        }
    }
    let (agent_id, token) = core.store.read(|store| {
        let token = caller_token(store, workspace, name)?;
        let agent_id = store
            .registrations
            .iter()
            .find(|r| r.name == name && active(r, workspace))
            .map(|r| r.agent_id.clone())
            .ok_or_else(refused)?;
        Ok::<_, RpcError>((agent_id, token))
    })?;
    Ok(Caller::Session { agent_id, token })
}

/// The directory an external caller may launch in. Restricted paths are
/// resolved once and the resolved path is the one sent to Relaycast, so a
/// caller cannot swap an allowed symlink while the node lookup is in flight.
fn scoped_directory(
    caller: &ExternalCaller,
    harness: &str,
    directory: &str,
) -> Result<std::path::PathBuf, RpcError> {
    if let Some(harnesses) = &caller.harnesses {
        if !harnesses.iter().any(|allowed| allowed == harness) {
            return Err(outside_scope());
        }
    }
    let Some(roots) = &caller.directory_roots else {
        return Ok(directory.into());
    };
    let directory = std::fs::canonicalize(directory).map_err(|_| outside_scope())?;
    let allowed = roots
        .iter()
        .any(|root| std::fs::canonicalize(root).is_ok_and(|root| directory.starts_with(root)));
    allowed.then_some(directory).ok_or_else(outside_scope)
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
        released: output["released"] == true,
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
    context: &CallContext,
    params: SpawnInvokeParams,
) -> Result<SpawnControlInvocation, RpcError> {
    for value in [&params.node_id, &params.node_name, &params.name] {
        segment(value)?;
    }
    key(&params.idempotency_key)?;
    let workspace = workspace(core)?;
    // Only this computer's own node, under the name it enrolled with (an
    // alternate when another node held its own): status and release bind a
    // worker to the exact identity its local registration saved, which a
    // spawn on another computer never leaves here.
    let own = super::node::enrolled_name(
        &core.config.app_data_dir,
        &workspace.base_url,
        &super::node_name(&core.machine_prefix),
    );
    if params.node_name != own {
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
    let caller = caller_in(core, &workspace, context, &params.caller_name)?;
    let call = SpawnCall {
        peer_pid: context.peer_pid,
        connection_id: context.connection_id,
        workspace: &workspace,
        request: SpawnRequest::Invoke(&params),
    };
    caller
        .admitted(call, invoke_as(&caller, &workspace, harness, &params))
        .await
}

async fn invoke_as(
    caller: &Caller,
    workspace: &Workspace,
    harness: crate::relay::harness::HarnessId,
    params: &SpawnInvokeParams,
) -> Result<SpawnControlInvocation, RpcError> {
    let directory = match caller.external() {
        Some(external) => scoped_directory(external, &params.harness, &params.directory)?,
        None => params.directory.clone().into(),
    };
    let directory = directory.to_str().ok_or_else(outside_scope)?;
    let http = caller.http(workspace)?;
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
    let body = json!({"input": {"name": params.name, "cli": params.harness, "task": params.task, "target_node": params.node_name, "worker_cwd": directory, "verify_ready": true}});
    let result: Value = http
        .post(
            "/v1/actions/spawn/invoke",
            Some(body),
            Some(RequestOptions::with_idempotency_key(
                params.idempotency_key.clone(),
            )),
        )
        .await
        .map_err(|e| RpcError::from_relaycast(&e))?;
    receipt(&result)
}

async fn invocation(
    core: &Core,
    context: &CallContext,
    params: SpawnInvocationParams,
) -> Result<SpawnControlInvocation, RpcError> {
    segment(&params.invocation_id)?;
    let workspace = workspace(core)?;
    let caller = caller_in(core, &workspace, context, &params.caller_name)?;
    let call = SpawnCall {
        peer_pid: context.peer_pid,
        connection_id: context.connection_id,
        workspace: &workspace,
        request: SpawnRequest::Status(&params),
    };
    caller
        .admitted(call, invocation_as(core, &caller, &workspace, &params))
        .await
}

async fn invocation_as(
    core: &Core,
    caller: &Caller,
    workspace: &Workspace,
    params: &SpawnInvocationParams,
) -> Result<SpawnControlInvocation, RpcError> {
    let action = match params.action {
        SpawnControlAction::Spawn => "spawn",
        SpawnControlAction::Release => "release",
    };
    let path = format!("/v1/actions/{action}/invocations/{}", params.invocation_id);
    let data: Value = caller
        .http(workspace)?
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
            .read(|store| local_spawn_identity(receipt, store, workspace));
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
    release_targets(store, workspace, params).next().is_some()
}

/// [`release_target`], narrowed to a worker whose recorded requester (as
/// Relaycast reported it, never the caller's word) is `requester_id`. Only
/// external callers that may release just their own agents are held to it.
#[derive(Clone, Debug, PartialEq, Eq)]
enum ReleaseOwnership {
    Owned,
    Other,
    Unknown(String),
}

fn release_target_ownership(
    store: &Store,
    workspace: &Workspace,
    params: &SpawnReleaseParams,
    requester_id: &str,
) -> Option<ReleaseOwnership> {
    let spawn = release_targets(store, workspace, params)
        .next()?
        .spawn
        .as_ref()?;
    Some(match spawn.requester.as_ref() {
        Some(requester) if requester.agent_id == requester_id => ReleaseOwnership::Owned,
        Some(_) => ReleaseOwnership::Other,
        None => ReleaseOwnership::Unknown(spawn.invocation_id.clone()),
    })
}

fn release_targets<'a>(
    store: &'a Store,
    workspace: &'a Workspace,
    params: &'a SpawnReleaseParams,
) -> impl Iterator<Item = &'a Registration> {
    store.registrations.iter().filter(move |r| {
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
    context: &CallContext,
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
    let caller = caller_in(core, &workspace, context, &params.caller_name)?;
    let call = SpawnCall {
        peer_pid: context.peer_pid,
        connection_id: context.connection_id,
        workspace: &workspace,
        request: SpawnRequest::Release(&params),
    };
    caller
        .admitted(call, release_as(core, &caller, &workspace, &params))
        .await
}

async fn release_as(
    core: &Core,
    caller: &Caller,
    workspace: &Workspace,
    params: &SpawnReleaseParams,
) -> Result<SpawnControlInvocation, RpcError> {
    let http = caller.http(workspace)?;
    let (exact, ownership) = core.store.read(|store| {
        let ownership = caller
            .external()
            .filter(|external| external.owns_only)
            .and_then(|external| {
                release_target_ownership(store, workspace, params, &external.agent_id)
            });
        (release_target(store, workspace, params), ownership)
    });
    let owns_only = caller.external().is_some_and(|caller| caller.owns_only);
    let owner_verified = match ownership {
        Some(ReleaseOwnership::Owned) => true,
        Some(ReleaseOwnership::Other) => return Err(not_owner()),
        Some(ReleaseOwnership::Unknown(invocation_id)) => {
            crate::relay::spawn::report_back::requester(workspace, &invocation_id)
                .await
                .is_some_and(|requester| requester.agent_id == caller.agent_id())
        }
        None => false,
    };
    if exact && owns_only && !owner_verified {
        return Err(not_owner());
    }
    let ownership = match (owns_only, owner_verified) {
        (false, _) => claims::Ownership::Unrestricted,
        (true, true) => claims::Ownership::Verified,
        (true, false) => claims::Ownership::ClaimOnly,
    };
    claims::release(
        &core.config.app_data_dir,
        workspace,
        caller.agent_id(),
        params,
        exact,
        ownership,
    )?;
    let body = json!({"name": params.name, "expected_agent_id": params.expected_agent_id, "delete_agent": true, "reason": "Released through native desktop spawn controls"});
    let data: Value = http
        .post(
            "/v1/agents/release-exact",
            Some(body),
            Some(RequestOptions::with_idempotency_key(
                params.idempotency_key.clone(),
            )),
        )
        .await
        .map_err(|e| RpcError::from_relaycast(&e))?;
    receipt(&data)
}

#[cfg(test)]
mod tests;
