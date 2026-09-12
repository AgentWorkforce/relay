//! Fresh registration and channel I/O run outside the serial runtime actor.
//! Continuations retain the original request and immutable custody, never a
//! caller-supplied token masquerading as permission to bypass a reservation.
use super::*;
use crate::fleet_wire::ActionInvoke;
use crate::spawn_registration::{AdmissionGuard, SpawnRegistration};
use futures_util::{future::BoxFuture, stream::FuturesUnordered};

// The actor alone polls/mutates these futures. The mutex makes immutable
// runtime references Send without requiring network futures themselves to be
// Sync; no lock guard is held across a poll or await.
#[derive(Default)]
pub(super) struct PendingSpawns(
    std::sync::Mutex<FuturesUnordered<BoxFuture<'static, PreparedSpawn>>>,
);
impl PendingSpawns {
    pub(super) fn len(&self) -> usize {
        self.0.lock().unwrap().len()
    }
    pub(super) fn is_empty(&self) -> bool {
        self.len() == 0
    }
    fn push(&mut self, future: BoxFuture<'static, PreparedSpawn>) {
        self.0.get_mut().unwrap().push(future);
    }
    pub(super) fn clear(&mut self) {
        self.0.get_mut().unwrap().clear();
    }
}
impl futures_util::Stream for PendingSpawns {
    type Item = PreparedSpawn;
    fn poll_next(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        std::pin::Pin::new(self.get_mut().0.get_mut().unwrap()).poll_next(cx)
    }
}

enum Request {
    Api(Box<ListenApiRequest>, SpawnCaller),
    Fleet(ActionInvoke),
}

type SpawnReply = tokio::sync::oneshot::Sender<Result<Value, String>>;
#[derive(Clone)]
struct SpawnCaller(Arc<std::sync::Mutex<Option<SpawnReply>>>);
impl SpawnCaller {
    fn eligible(&self) -> bool {
        self.0
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|reply| !reply.is_closed())
    }
    async fn closed(&self) {
        futures_util::future::poll_fn(|cx| {
            let mut slot = self.0.lock().unwrap();
            match slot.as_mut() {
                Some(reply) => reply.poll_closed(cx),
                None => std::task::Poll::Ready(()),
            }
        })
        .await;
    }
    fn attach(req: &mut ListenApiRequest) -> Self {
        let ListenApiRequest::Spawn { reply, .. } = req else {
            unreachable!()
        };
        let (forward, outcome) = tokio::sync::oneshot::channel();
        let caller = Self(Arc::new(std::sync::Mutex::new(Some(std::mem::replace(
            reply, forward,
        )))));
        let target = caller.clone();
        // Response forwarding owns no product mutations. Dropping any queued
        // continuation closes its proxy and therefore completes this task.
        tokio::spawn(async move {
            let response = outcome
                .await
                .unwrap_or_else(|_| Err("spawn admission canceled".into()));
            if let Some(reply) = target.0.lock().unwrap().take() {
                let _ = reply.send(response);
            }
        });
        caller
    }
}

pub(super) struct PreparedSpawn {
    request: Request,
    guard: AdmissionGuard,
    result: Result<(), String>,
}

pub(super) fn owns_resume(
    workers: &WorkerRegistry,
    name: &WorkerName,
    custody: Option<&Arc<SpawnRegistration>>,
) -> bool {
    custody.is_some_and(|custody| {
        workers
            .spawn_registrations
            .entries
            .get(name)
            .is_some_and(|entry| Arc::ptr_eq(entry, custody))
    })
}

impl BrokerRuntime {
    /// Keep legacy direct-handler tests available; the event loop uses this
    /// entry point so a pending network exchange never borrows the actor.
    pub(super) async fn dispatch_api_request(&mut self, mut req: ListenApiRequest) {
        if self.degraded.is_some()
            || !matches!(
                &req,
                ListenApiRequest::Spawn {
                    agent_token: None,
                    ..
                }
            )
        {
            self.handle_api_request(req).await;
            return;
        }
        let caller = SpawnCaller::attach(&mut req);
        let eligibility = caller.clone();
        let preparation = (|| -> Result<_, String> {
            let ListenApiRequest::Spawn {
                name,
                cli,
                transport,
                model,
                args,
                channels,
                cwd,
                team,
                shadow_of,
                shadow_mode,
                restart_policy,
                harness_config,
                reply,
                ..
            } = &req
            else {
                unreachable!()
            };
            if reply.is_closed() || !caller.eligible() {
                return Err("spawn caller disconnected".into());
            }
            self.check_pending_spawn_name(name)?;
            let channels = super::relaycast_events::relaycast_spawn_channels(
                &json!({"channels": channels.clone().unwrap_or_else(default_spawn_channels)}),
                None,
            )
            .map_err(|e| e.to_string())?;
            let spec = build_http_api_spawn_spec(
                name.clone(),
                cli.clone(),
                transport.clone(),
                model.clone(),
                args.clone(),
                channels.clone(),
                cwd.clone(),
                team.clone(),
                shadow_of.clone(),
                shadow_mode.clone(),
                *restart_policy.clone(),
                harness_config.clone(),
            )
            .map_err(|e| e.to_string())?;
            let custody = super::fleet::begin_owned_node_registration(
                &mut self.workers,
                &self.relaycast_http,
                &self.fleet_control_tx,
                name,
                &channels,
                None,
                super::fleet::fleet_initial_session_ref(&spec),
                Some(Arc::new(move || eligibility.eligible())),
            )?;
            Ok((custody, cli.clone(), channels))
        })();
        match preparation {
            Ok((custody, cli, channels)) => {
                self.enqueue_spawn(Request::Api(Box::new(req), caller), custody, cli, channels)
            }
            Err(error) => {
                if let ListenApiRequest::Spawn { reply, .. } = req {
                    let _ = reply.send(Err(error));
                }
            }
        }
    }

    pub(super) async fn dispatch_fleet_spawn(&mut self, invoke: ActionInvoke) {
        let preparation = (|| -> Result<_, String> {
            let name = super::fleet::action_invoke_agent_name(&invoke)
                .ok_or("spawn_missing_agent_name")?;
            let harness = super::relaycast_events::relaycast_harness_config(&invoke.input)?;
            let require_node = harness.as_ref().is_some_and(|config| {
                super::relaycast_events::harness_metadata_flag(
                    config,
                    "require_node_registration",
                    "requireNodeRegistration",
                )
            });
            if relaycast_ws_spawn_token(&invoke.input).is_some()
                && !require_node
                && !super::relaycast_events::relaycast_spawn_verifies_ready(&invoke.input)
            {
                return Ok(None);
            }
            self.check_pending_spawn_name(&name)?;
            let cli =
                super::fleet::action_invoke_string(&invoke.input, &["cli", "command", "provider"])
                    .ok_or("spawn_missing_cli")?;
            let channel = super::fleet::action_invoke_string(&invoke.input, &["channel"]);
            let channels = super::relaycast_events::relaycast_spawn_channels(
                &invoke.input,
                channel.as_deref(),
            )
            .map_err(|e| e.to_string())?;
            super::relaycast_events::relaycast_spawn_worker_cwd(&invoke.input)
                .map_err(|e| e.to_string())?;
            let workspace_id = self
                .default_workspace_id
                .clone()
                .or_else(|| self.workspaces.first().map(|w| w.workspace_id.clone()))
                .ok_or("no_workspace_available")?;
            let workspace = self
                .workspace_lookup
                .get(&workspace_id)
                .unwrap_or(&self.default_workspace);
            if is_relaycast_self_control_target(&name, &workspace.self_name, &workspace.self_names)
            {
                return Err("cannot spawn broker self".into());
            }
            let custody = super::fleet::begin_owned_node_registration(
                &mut self.workers,
                &workspace.http_client,
                &self.fleet_control_tx,
                &name,
                &channels,
                Some(invoke.invocation_id.clone()),
                super::relaycast_events::relaycast_spawn_session_ref(&invoke.input),
                None,
            )?;
            Ok(Some((custody, cli, channels)))
        })();
        match preparation {
            Ok(Some((custody, cli, channels))) => {
                self.enqueue_spawn(Request::Fleet(invoke), custody, cli, channels)
            }
            Ok(None) => self.finish_fleet_action_spawn(invoke, None).await,
            Err(error) => self.reply_action_error(&invoke.invocation_id, &error).await,
        }
    }

    fn check_pending_spawn_name(&self, name: &WorkerName) -> Result<(), String> {
        if self.pending_spawns.len() >= 256 {
            return Err("pending spawn capacity exhausted".into());
        }
        if self.workers.has_worker(name)
            || self.pending_verified_spawns.contains_key(name)
            || self.workers.identity_cleanups.contains_key(name)
            || self.workers.spawn_registrations.blocked(name)
        {
            return Err("spawn_agent_name_in_use: live or unresolved custody".into());
        }
        Ok(())
    }

    fn enqueue_spawn(
        &mut self,
        mut request: Request,
        custody: Arc<SpawnRegistration>,
        cli: String,
        channels: Vec<ChannelName>,
    ) {
        // Construct the guard outside the future: dropping even an unpolled
        // future cancels its reservation before node control may send it.
        let guard = AdmissionGuard(custody.clone());
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        self.pending_spawns.push(Box::pin(async move {
            let prepare = async {
                let token = custody.wait().await?;
                seed_supplied_agent_token(&custody.http, &WorkerName::new(custody.name()), &token.token);
                custody.http.ensure_agent_channels(&custody.name(), Some(&cli), &channels).await.map_err(|e|e.to_string())?;
                custody.http.verify_agent_channel_scope(&custody.name(), &channels).await.map_err(|e|e.to_string())?;
                Ok(())
            };
            let bounded = tokio::time::timeout_at(deadline, prepare);
            let result = match &mut request {
                Request::Api(_, caller) => {
                    tokio::select! {
                        biased;
                        _ = caller.closed() => Err("spawn caller disconnected".into()),
                        result = bounded => result.unwrap_or_else(|_|Err("spawn preparation timeout; name quarantined".into())),
                    }
                }
                Request::Fleet(_) => bounded.await.unwrap_or_else(|_|Err("spawn preparation timeout; name quarantined".into())),
            };
            PreparedSpawn { request, guard, result }
        }));
    }

    pub(super) async fn finish_prepared_spawn(&mut self, prepared: PreparedSpawn) {
        let PreparedSpawn {
            request,
            guard,
            result,
        } = prepared;
        match (request, result) {
            (Request::Api(req, _caller), Ok(())) => {
                self.handle_api_request_registered(*req, Some(guard.0.clone()))
                    .await
            }
            (Request::Fleet(invoke), Ok(())) => {
                self.finish_fleet_action_spawn(invoke, Some(guard.0.clone()))
                    .await
            }
            (Request::Api(req, _caller), Err(error)) => {
                if let ListenApiRequest::Spawn { reply, .. } = *req {
                    let _ = reply.send(Err(error));
                }
            }
            (Request::Fleet(invoke), Err(error)) => {
                self.reply_action_error(&invoke.invocation_id, &error).await
            }
        }
        // Running custody ignores abandonment; all failed/canceled admission
        // transfers to the existing exact-identity maintenance cleanup.
        drop(guard);
    }
}
