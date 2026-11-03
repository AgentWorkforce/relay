//! Shared Cloud Replicas RPC handlers for both desktop platforms.
use super::decode_cloud;
use crate::relay::cloud_session::segment;
use crate::relay::contract::replicas::*;
use crate::relay::contract::{answer, method};
use crate::relay::daemon::Core;
use crate::relay::protocol::{ErrorKind, RpcError};
use serde_json::{json, Value};
use std::sync::Arc;

fn replicas_path(core: &Arc<Core>, suffix: &str) -> Result<String, RpcError> {
    let account = core.plugins.cloud.account().ok_or_else(|| {
        RpcError::new(
            ErrorKind::NotSignedIn,
            "Sign in to Agent Relay Cloud to manage Replicas.",
        )
    })?;
    Ok(format!(
        "/workspaces/{}/replicas/{suffix}",
        segment(&account.workspace_id)
    ))
}

async fn replicas_request<T: serde::de::DeserializeOwned>(
    core: &Arc<Core>,
    method: &'static str,
    suffix: &str,
    body: Option<Value>,
) -> Result<T, RpcError> {
    let value = core
        .plugins
        .cloud
        .request(method, replicas_path(core, suffix)?, body)
        .await
        .map_err(|error| RpcError::cloud(&error))?;
    decode_cloud(value, "Replicas launch status")
}

fn replicas_spawn_suffix(request: &ReplicasSpawnGetParams) -> Result<String, RpcError> {
    let parts: Vec<&str> = request.spawn_id.split('-').collect();
    let valid = parts.len() == 5
        && parts.iter().zip([8, 4, 4, 4, 12]).all(|(part, size)| {
            part.len() == size && part.bytes().all(|byte| byte.is_ascii_hexdigit())
        });
    if !valid {
        return Err(RpcError::invalid_params(
            "Give the spawn_id returned by Replicas spawn.",
        ));
    }
    Ok(format!("spawns/{}", segment(&request.spawn_id)))
}

pub(super) async fn call(
    core: &Arc<Core>,
    method: &str,
    raw: &Value,
) -> Option<Result<Value, RpcError>> {
    Some(match method {
        method::ReplicasEnvironmentsList::NAME => {
            answer::<method::ReplicasEnvironmentsList, _>(raw.clone(), |_| async move {
                replicas_request::<ReplicasEnvironments>(core, "GET", "environments", None).await
            })
            .await
        }
        method::ReplicasSpawn::NAME => {
            answer::<method::ReplicasSpawn, _>(raw.clone(), |request| async move {
                replicas_request::<ReplicasSpawn>(core, "POST", "spawns", Some(json!(request)))
                    .await
            })
            .await
        }
        method::ReplicasSpawnGet::NAME => {
            answer::<method::ReplicasSpawnGet, _>(raw.clone(), |request| async move {
                replicas_request::<ReplicasSpawn>(
                    core,
                    "GET",
                    &replicas_spawn_suffix(&request)?,
                    None,
                )
                .await
            })
            .await
        }
        method::ReplicasRelease::NAME => {
            answer::<method::ReplicasRelease, _>(raw.clone(), |request| async move {
                replicas_request::<ReplicasReleased>(
                    core,
                    "DELETE",
                    &replicas_spawn_suffix(&request)?,
                    None,
                )
                .await
            })
            .await
        }
        _ => return None,
    })
}
