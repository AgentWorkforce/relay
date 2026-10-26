//! The bridge methods for what runs on this computer: its sessions and its
//! broker's fleet workers. See `docs/relay-core.md` for the contract.

use crate::relay::agents::suggested_name;
use crate::relay::contract::agents::{
    ExistingRegisterParams, LocalSession, LocalSessions, ManagedLaunchParams,
    ManagedSessionStarted, SessionRegistration,
};
use crate::relay::contract::{answer, method};
use crate::relay::daemon::Core;
use crate::relay::existing_session::enablement::OpenLeaderRequest;
use crate::relay::fleet::{self, Fleet};
use crate::relay::managed_sessions::{ManagedAuthority, ManagedLaunch};
use crate::relay::protocol::RpcError;
use crate::relay::sessions::DiscoveredSession;
use crate::relay::state::Listing;
use crate::relay::store::Target;
use crate::relay::workspace;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;

/// Answers `method`, or `None` when this module has no such method.
pub async fn call(core: &Arc<Core>, method: &str, raw: Value) -> Option<Result<Value, RpcError>> {
    if let Some(result) = crate::relay::spawn::control::call(core, method, raw.clone()).await {
        return Some(result);
    }
    if let Some(result) = crate::relay::openclaw::relay_tools::call(core, method, raw.clone()).await
    {
        return Some(result);
    }
    match method {
        method::SessionsTitleCapability::NAME => Some(
            answer::<method::SessionsTitleCapability, _>(raw, |params| async move {
                crate::relay::session_titles::validate_identity(
                    &params.source,
                    &params.session_id,
                )?;
                let sessions = core.plugins.sessions.clone();
                tokio::task::spawn_blocking(move || {
                    sessions.title_capability(&params.source, &params.session_id)
                })
                .await
                .map_err(|_| {
                    RpcError::new(
                        crate::relay::protocol::ErrorKind::Internal,
                        "Could not check session title editing.",
                    )
                })
            })
            .await,
        ),
        method::SessionsTitleSet::NAME => Some(
            answer::<method::SessionsTitleSet, _>(raw, |params| async move {
                crate::relay::session_titles::set_native_title(core, params).await
            })
            .await,
        ),
        method::SessionsList::NAME => Some(
            answer::<method::SessionsList, _>(raw, |_| async { Ok(sessions_list(core).await) })
                .await,
        ),
        method::SessionsManagedLaunch::NAME => Some(
            answer::<method::SessionsManagedLaunch, _>(raw, |params| async move {
                managed_launch(core, params).await
            })
            .await,
        ),
        method::SessionsExistingRegister::NAME => Some(
            answer::<method::SessionsExistingRegister, _>(raw, |params| async move {
                existing_register(core, params).await
            })
            .await,
        ),
        _ => match crate::relay::spawn::handover::call(core, method, raw.clone()).await {
            Some(answer) => Some(answer),
            None => fleet::call(&this_fleet(core), method, raw).await,
        },
    }
}

/// The signed-in workspace and owner a probe-owned binding is minted for.
async fn binding_authority(core: &Arc<Core>) -> Result<ManagedAuthority, RpcError> {
    core.refresh_workspace().await;
    let workspace_id = core.verified_workspace_id().ok_or_else(|| {
        RpcError::new(
            crate::relay::protocol::ErrorKind::NotSignedIn,
            "A verified Agent Relay workspace is required for managed sessions.",
        )
    })?;
    let owner_id = core
        .agent_owner()
        .map(|owner| owner.user_id)
        .ok_or_else(|| {
            RpcError::new(
                crate::relay::protocol::ErrorKind::NotSignedIn,
                "A signed-in owner is required for managed sessions.",
            )
        })?;
    Ok(ManagedAuthority {
        workspace_id,
        owner_id,
        owner_uid: crate::relay::peer::current_uid(),
    })
}

async fn existing_register(
    core: &Arc<Core>,
    params: ExistingRegisterParams,
) -> Result<ManagedSessionStarted, RpcError> {
    if params.kind != crate::relay::store::SessionKind::GrokOpen {
        return Err(RpcError::invalid_params(
            "Only Grok supports already-open session registration.",
        ));
    }
    let authority = binding_authority(core).await?;
    let request = OpenLeaderRequest {
        session_id: params.session_id,
        directory: PathBuf::from(params.directory),
        workspace_id: authority.workspace_id,
        owner_id: authority.owner_id,
        owner_uid: authority.owner_uid,
    };
    let directory = core.plugins.sessions.clone();
    let session = tokio::task::spawn_blocking(move || directory.register_existing(request))
        .await
        .map_err(|_| {
            RpcError::new(
                crate::relay::protocol::ErrorKind::Internal,
                "Already-open session registration did not complete.",
            )
        })?
        .map_err(|message| RpcError::new(crate::relay::protocol::ErrorKind::Refused, message))?;
    {
        let mut snapshot = core.session_snapshot.lock().unwrap();
        snapshot.0 += 1;
        snapshot.1.retain(|row| row.target != session.target);
        snapshot.1.push(session.clone());
    }
    core.hub.invalidated(Listing::Sessions);
    Ok(ManagedSessionStarted {
        target: session.target,
        title: session.title,
        directory: session.directory,
    })
}

async fn managed_launch(
    core: &Arc<Core>,
    params: ManagedLaunchParams,
) -> Result<ManagedSessionStarted, RpcError> {
    if !matches!(
        params.kind,
        crate::relay::store::SessionKind::Grok | crate::relay::store::SessionKind::OpenCode
    ) {
        return Err(RpcError::invalid_params(
            "Only Grok and OpenCode support managed launch.",
        ));
    }
    let launch = ManagedLaunch {
        kind: params.kind,
        executable: PathBuf::from(params.executable),
        directory: PathBuf::from(params.directory),
        session_id: params.session_id,
        authority: binding_authority(core).await?,
    };
    let directory = core.plugins.sessions.clone();
    let session = tokio::task::spawn_blocking(move || directory.launch_managed(launch))
        .await
        .map_err(|_| {
            RpcError::new(
                crate::relay::protocol::ErrorKind::Internal,
                "Managed provider launch did not complete.",
            )
        })?
        .map_err(|message| RpcError::new(crate::relay::protocol::ErrorKind::Refused, message))?;
    {
        let mut snapshot = core.session_snapshot.lock().unwrap();
        snapshot.0 += 1;
        snapshot.1.retain(|row| row.target != session.target);
        snapshot.1.push(session.clone());
    }
    core.hub.invalidated(Listing::Sessions);
    Ok(ManagedSessionStarted {
        target: session.target,
        title: session.title,
        directory: session.directory,
    })
}

/// The fleet of this computer's relay home (`$AGENT_RELAY_HOME`, default
/// `~/.agentworkforce/relay`).
pub fn this_fleet(core: &Core) -> Fleet {
    let config = core.config();
    let env = |key: &str| config.env.get(key).cloned();
    Fleet::new(workspace::relay_home(&env, &config.home))
}

/// Every session discovery finds, plus every registered session it does
/// not (shown offline), each with its registration.
pub async fn sessions_list(core: &Arc<Core>) -> LocalSessions {
    let found = core.session_snapshot.lock().unwrap().1.clone();
    let store = core.store.snapshot();
    let status = core.status();
    let machine_prefix = core.machine_prefix.clone();
    let projects = core
        .project_names
        .list(
            found
                .iter()
                .filter_map(|session| session.directory.as_deref()),
        )
        .await;
    let row = |session: &DiscoveredSession, running: bool| {
        let registration = store
            .registration_for(&session.target)
            .map(|r| SessionRegistration {
                name: r.name.clone(),
                alias: r.alias_name().map(str::to_owned),
                address: r.current_address(&machine_prefix),
                added_by_session: r.added_by_session == Some(true),
                push: crate::relay::agents::agent_push(&status.push, r),
                spawn: core.session_spawn(r),
            });
        LocalSession {
            target: session.target.clone(),
            title: session.title.clone(),
            project: session
                .directory
                .as_ref()
                .and_then(|directory| projects.get(directory).cloned().flatten()),
            directory: session.directory.clone(),
            live: session.live,
            running: Some(running),
            holder: session.holder,
            updated_at_ms: session.updated_at_ms,
            host: session
                .host
                .clone()
                .or_else(|| crate::relay::conductor::host(session.directory.as_deref())),
            registration,
            suggested_name: suggested_name(session),
        }
    };
    // A session archived while on the relay is gone: it is not listed while
    // its agent's removal is pending, so it never shows as on the relay.
    let archived: Vec<&Target> = store
        .registrations
        .iter()
        .filter(|r| r.archived_at.is_some())
        .map(|r| &r.target)
        .collect();
    let mut rows: Vec<LocalSession> = found
        .iter()
        .filter(|session| !archived.contains(&&session.target))
        .map(|session| row(session, true))
        .collect();
    for registration in &store.registrations {
        if registration.archived_at.is_some()
            || found.iter().any(|s| s.target == registration.target)
        {
            continue;
        }
        rows.push(row(
            &DiscoveredSession {
                target: registration.target.clone(),
                title: registration.title.clone(),
                directory: None,
                updated_at_ms: None,
                host: None,
                live: false,
                // Registered but not found: no process holds it.
                holder: None,
            },
            false,
        ));
    }
    LocalSessions { sessions: rows }
}

/// Tells clients when the sessions on this computer (with their
/// registrations) or the fleet's workers change, for the daemon's life.
pub async fn watch(core: Arc<Core>) {
    let mut sessions: Option<Value> = None;
    let mut fleet: Option<Value> = None;
    loop {
        // This is the only discovery pass used by presentation. Delivery and
        // registration still perform their own fresh authority checks.
        let generation = core.session_snapshot.lock().unwrap().0;
        let directory = core.plugins.sessions.clone();
        if let Ok(found) = tokio::task::spawn_blocking(move || directory.sessions()).await {
            let mut snapshot = core.session_snapshot.lock().unwrap();
            // A launch/register that completed during discovery is newer.
            if snapshot.0 == generation {
                snapshot.1 = found;
            }
        }
        let listed =
            sessions_shape(&serde_json::to_value(sessions_list(&core).await).unwrap_or_default());
        if sessions.as_ref().is_none_or(|previous| *previous != listed) {
            core.hub.invalidated(Listing::Sessions);
        }
        sessions = Some(listed);
        let listed =
            fleet_shape(&serde_json::to_value(this_fleet(&core).list().await).unwrap_or_default());
        if fleet.as_ref().is_some_and(|previous| *previous != listed) {
            core.hub.invalidated(Listing::Fleet);
        }
        fleet = Some(listed);
        // Relay-attributed items left in Codex's queue past their lifetime
        // are withdrawn, so Codex never runs a message the relay gave up on.
        let config = core.config();
        let env = |key: &str| config.env.get(key).cloned();
        let codex = crate::relay::codex::CodexConfig::from_env(&env, &config.home);
        let _ = tokio::task::spawn_blocking(move || {
            crate::relay::codex::cleanup_expired_queue(&codex, crate::relay::state::now_ms())
        })
        .await;
        tokio::time::sleep(WATCH_EVERY).await;
    }
}

/// History/status refreshes do not queue behind live-agent discovery.
/// Keep this task alive across sign-in and account changes; the uploader
/// rejects late results with the previous attachment/mutation generation.
pub async fn watch_uploads(core: Arc<Core>) {
    let Some(account) = &core.plugins.account else {
        return;
    };
    let uploader = account.uploader.clone();
    let mut refreshes = tokio::task::JoinSet::new();
    let mut ticks = tokio::time::interval(WATCH_EVERY);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _ = ticks.tick() => {
                let (uploader, core) = (uploader.clone(), core.clone());
                refreshes.spawn(async move {
                    uploader.refresh_background_snapshots_with(&|| core.hub.invalidated(Listing::Uploader)).await
                });
            }
            Some(_) = refreshes.join_next(), if !refreshes.is_empty() => {}
        }
    }
}

/// What of `sessions.list` a client shows changing: everything but when a
/// session last wrote its state, and push state, which has its own
/// `status` events.
fn sessions_shape(listing: &Value) -> Value {
    let mut listing = listing.clone();
    for row in listing["sessions"].as_array_mut().into_iter().flatten() {
        if let Some(row) = row.as_object_mut() {
            row.remove("updated_at_ms");
        }
        if let Some(registration) = row["registration"].as_object_mut() {
            registration.remove("push");
        }
    }
    listing
}

/// How often sessions and the fleet are compared.
const WATCH_EVERY: std::time::Duration = std::time::Duration::from_secs(5);

/// What of a fleet listing a client shows changing: brokers, their errors,
/// and each worker's identity, state, generation and queue (not its
/// last-activity time, which moves on every read).
fn fleet_shape(listing: &Value) -> Value {
    let brokers = listing["brokers"].as_array().cloned().unwrap_or_default();
    Value::Array(
        brokers
            .iter()
            .map(|broker| {
                let workers: Vec<Value> = broker["workers"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|w| json!([w["id"], w["state"], w["generation"], w["pending_messages"]]))
                    .collect();
                json!([
                    broker["node_id"],
                    broker["name"],
                    broker["workspace_id"],
                    broker["error"],
                    workers
                ])
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // Review: a session's write time and push state are not changes a
    // listing is re-fetched for; a registration is.
    #[test]
    fn the_sessions_shape_ignores_volatile_fields() {
        let row = |at: i64, push: &str, name: Option<&str>| {
            json!({"sessions": [{"target": {"kind": "codex", "id": "x"}, "live": true, "updated_at_ms": at,
                "registration": name.map(|n| json!({"name": n, "push": {"state": push}}))}]})
        };
        assert_eq!(
            sessions_shape(&row(1, "live", Some("a"))),
            sessions_shape(&row(2, "waiting", Some("a")))
        );
        assert_ne!(
            sessions_shape(&row(1, "live", Some("a"))),
            sessions_shape(&row(1, "live", None))
        );
    }

    #[test]
    fn the_fleet_shape_ignores_activity_times_but_not_brokers() {
        let listing = |at: i64, name: &str| {
            json!({"brokers": [{"node_id": "n", "name": name, "workers": [
                {"id": "n|w", "state": "idle", "generation": "1", "pending_messages": 0, "last_activity_ms": at}]}]})
        };
        assert_eq!(
            fleet_shape(&listing(1, "mac")),
            fleet_shape(&listing(9, "mac"))
        );
        assert_ne!(
            fleet_shape(&listing(1, "mac")),
            fleet_shape(&listing(1, "mini"))
        );
    }
}
