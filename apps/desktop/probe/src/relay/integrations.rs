//! Provider events (GitHub, Linear, Slack, Jira) for an agent, through
//! relayfile-cloud, with the signed-in person's own Agent Relay session:
//! nothing is installed or run on this computer.
//!
//! ```text
//! relayfile-cloud ─webhook─▶ Relaycast inbound target ─▶ #agent-events-<agent id> ─▶ session
//! session's thread reply ─▶ Relaycast thread.reply subscription ─▶ relayfile writeback ─▶ provider
//! ```
//!
//! Every step is journaled in the agent's `integrations` before anything
//! external is created, and each external URL carries the attempt's id
//! (`desktopSubscription=<id>`), so a cleanup finds and removes what a lost
//! response or a failed save left behind without touching another
//! subscriber's resources. Cleanup treats "already gone" as done.

use crate::relay::client;
use crate::relay::cloud_session::segment;
use crate::relay::contract::agents::IntegrationChange;
use crate::relay::daemon::Core;
use crate::relay::delivery::policy::{relayfile_glob, IntegrationEvent};
use crate::relay::protocol::{ErrorKind, RpcError};
use crate::relay::sdk_gaps;
use crate::relay::state::Listing;
use crate::relay::store::{Integration, Registration};
use crate::relay::workspace::{validated_base_url, Secret};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::Duration;
use url::Url;

pub const PROVIDERS: [&str; 4] = ["github", "linear", "slack", "jira"];

/// How long a subscription waits for a person to connect the provider in
/// the browser, and how often it looks. A client waiting on the
/// subscription must wait longer than this.
pub(crate) const CONNECT_WAIT: Duration = Duration::from_secs(300);
const CONNECT_POLL: Duration = Duration::from_secs(3);

/// Integration statuses that mean a provider is connected.
const CONNECTED: [&str; 5] = [
    "connected",
    "oauth_connected",
    "sync_queued",
    "syncing",
    "ready",
];

/// `url` with this attempt's id added, so cleanup can tell its resources
/// from anyone else's. Only https, with a host and no credentials.
pub fn attempt_url(url: &str, id: &str) -> Option<String> {
    let mut url = Url::parse(url).ok()?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    url.query_pairs_mut().append_pair("desktopSubscription", id);
    Some(url.into())
}

fn failed(message: impl Into<String>) -> RpcError {
    RpcError::new(ErrorKind::CloudFailed, message)
}

fn relaycast(error: &relaycast::RelayError, what: &str) -> RpcError {
    let mut mapped = RpcError::from_relaycast(error);
    mapped.message = format!("{what} {}", mapped.message);
    mapped
}

/// relayfile-cloud for one workspace, with a delegated credential. Requests
/// never follow a redirect, so the credential stays with its origin.
struct Relayfile {
    base_url: String,
    token: Secret,
    workspace: String,
}

impl Relayfile {
    async fn call(
        &self,
        method: &'static str,
        path: String,
        body: Option<Value>,
    ) -> Result<Value, RpcError> {
        let url = format!(
            "{}/v1/workspaces/{}{path}",
            self.base_url,
            segment(&self.workspace)
        );
        let token = self.token.clone();
        tokio::task::spawn_blocking(move || {
            let agent = ureq::AgentBuilder::new()
                .redirects(0)
                .timeout(Duration::from_secs(30))
                .build();
            let request = agent
                .request(method, &url)
                .set("Authorization", &format!("Bearer {}", token.expose()))
                .set(
                    "User-Agent",
                    &format!("AgentRelayDesktop/{}", crate::VERSION),
                );
            let response = match body {
                Some(body) => request.send_json(body),
                None => request.call(),
            };
            match response {
                Ok(response) => {
                    let text = response.into_string().unwrap_or_default();
                    if text.trim().is_empty() {
                        Ok(Value::Null)
                    } else {
                        serde_json::from_str(&text)
                            .map_err(|_| failed("Unreadable response from relayfile."))
                    }
                }
                Err(ureq::Error::Status(404, _)) => Err(RpcError::new(
                    ErrorKind::NotFound,
                    "relayfile has no such resource.",
                )),
                Err(ureq::Error::Status(status, _)) => {
                    let kind = if (400..500).contains(&status) && status != 429 {
                        ErrorKind::CloudRefused
                    } else {
                        ErrorKind::CloudFailed
                    };
                    Err(RpcError::new(
                        kind,
                        format!("relayfile returned HTTP {status}."),
                    ))
                }
                Err(_) => Err(failed("relayfile could not be reached.")),
            }
        })
        .await
        .unwrap_or_else(|_| Err(failed("relayfile could not be reached.")))
    }

    fn inner(value: &Value) -> &Value {
        value.get("data").filter(|d| d.is_object()).unwrap_or(value)
    }

    /// Where Relaycast posts the agent's thread replies so they go back to
    /// the provider, and the secret it signs them with.
    async fn writeback_secret(&self, channel: &str) -> Result<(String, Secret), RpcError> {
        let value = self
            .call(
                "GET",
                format!(
                    "/integrations/relay/writeback-secret?channel={}",
                    segment(channel)
                ),
                None,
            )
            .await?;
        let inner = Relayfile::inner(&value);
        match (inner["url"].as_str(), inner["secret"].as_str()) {
            (Some(url), Some(secret)) => Ok((url.into(), Secret::new(secret))),
            _ => Err(failed("Unreadable writeback details from relayfile.")),
        }
    }

    /// Sends provider events under `globs` to `url`; returns its id.
    async fn create_subscription(
        &self,
        url: &str,
        globs: &[String],
        secret: &Secret,
    ) -> Result<String, RpcError> {
        let value = self
            .call(
                "POST",
                "/webhooks".into(),
                Some(json!({"url": url, "pathGlobs": globs, "secret": secret.expose()})),
            )
            .await?;
        let inner = Relayfile::inner(&value);
        inner["subscriptionId"]
            .as_str()
            .or(inner["id"].as_str())
            .map(str::to_string)
            .ok_or_else(|| failed("Unreadable subscription from relayfile."))
    }

    async fn subscriptions(&self) -> Result<Vec<Value>, RpcError> {
        let value = self.call("GET", "/webhooks".into(), None).await?;
        let rows = match &value {
            Value::Array(rows) => Some(rows),
            Value::Object(_) => value["subscriptions"]
                .as_array()
                .or(value["data"].as_array()),
            _ => None,
        };
        rows.cloned()
            .ok_or_else(|| failed("Unreadable subscription list from relayfile."))
    }

    async fn delete_subscription(&self, id: &str) -> Result<(), RpcError> {
        match self
            .call("DELETE", format!("/webhooks/{}", segment(id)), None)
            .await
        {
            Err(error) if error.data.kind == ErrorKind::NotFound => Ok(()),
            other => other.map(drop),
        }
    }
}

fn row_id(row: &Value) -> Option<String> {
    row["id"]
        .as_str()
        .or(row["subscriptionId"].as_str())
        .map(str::to_string)
}

/// Refuses a subscription the agent cannot take now.
fn can_subscribe(registration: &Registration, provider: &str, glob: &str) -> Result<(), RpcError> {
    let existing = registration.integrations.as_deref().unwrap_or_default();
    if existing.iter().any(|i| {
        i.provider == provider && i.path_glob.as_deref() == Some(glob) && i.ready != Some(true)
    }) {
        return Err(RpcError::new(
            ErrorKind::Refused,
            "That subscription is still being cleaned up. Try again shortly.",
        ));
    }
    if existing
        .iter()
        .any(|i| i.provider == provider && i.path_glob.as_deref() == Some(glob))
    {
        return Err(RpcError::new(
            ErrorKind::Conflict,
            format!(
                "@{} is already subscribed to that {provider} resource.",
                registration.name
            ),
        ));
    }
    Ok(())
}

/// A ready GitHub pull-request subscription ended by this event. GitHub uses
/// `pull_request.closed` for both closed and merged pull requests. The close
/// record itself lives below the titled pull directory, so it can be matched
/// without trusting event text to name a subscription.
pub(crate) fn terminal_integration(
    registration: &Registration,
    text: &str,
    relayfile_path: Option<&str>,
) -> Option<(String, String, String)> {
    let event = IntegrationEvent::parse(text);
    if !event
        .provider
        .as_deref()
        .is_some_and(|provider| provider.eq_ignore_ascii_case("github"))
        || event.kind.as_deref() != Some("pull_request.closed")
    {
        return None;
    }
    let path: Vec<&str> = relayfile_path
        .or(event.path.as_deref())?
        .split('/')
        .filter(|p| !p.is_empty())
        .collect();
    if path.len() < 6 || path[0] != "github" || path[1] != "repos" || path[4] != "pulls" {
        return None;
    }
    registration
        .integrations
        .iter()
        .flatten()
        .filter(|entry| entry.provider == "github" && entry.ready == Some(true))
        .find_map(|entry| {
            let glob: Vec<&str> = entry
                .path_glob
                .as_deref()?
                .split('/')
                .filter(|p| !p.is_empty())
                .collect();
            let same_pull = glob.len() == 7
                && glob[0] == "github"
                && glob[1] == "repos"
                && glob[2] == path[2]
                && glob[3] == path[3]
                && glob[4] == "pulls"
                && glob[5].chars().all(|c| c.is_ascii_digit())
                && glob[6] == "**"
                && (path[5] == glob[5]
                    || path[5]
                        .strip_prefix(glob[5])
                        .is_some_and(|suffix| suffix.starts_with("__")));
            same_pull.then(|| {
                (
                    entry.id.clone(),
                    entry.provider.clone(),
                    entry.resource.clone(),
                )
            })
        })
}

fn needs_cleanup(entry: &Integration) -> bool {
    entry.ready != Some(true) || entry.terminal == Some(true)
}

impl Core {
    /// Retries recovery records left by interrupted or failed setup/cleanup.
    /// This makes cleanup self-healing; a different unfinished resource never
    /// prevents a new subscription while this retry waits for a cloud service.
    pub(crate) async fn retry_unfinished_integrations(&self) {
        let pending: Vec<(String, String, String)> = self.store.read(|store| {
            store
                .registrations
                .iter()
                .flat_map(|registration| {
                    registration
                        .integrations
                        .iter()
                        .flatten()
                        .filter_map(|entry| {
                            needs_cleanup(entry).then(|| {
                                (
                                    registration.name.clone(),
                                    entry.provider.clone(),
                                    entry.resource.clone(),
                                )
                            })
                        })
                })
                .collect()
        });
        for (name, provider, resource) in pending {
            if let Err(error) = self
                .unsubscribe_integration(&name, &provider, &resource)
                .await
            {
                if error.data.kind != ErrorKind::Busy {
                    self.hub.activity(
                        crate::relay::state::Level::Warning,
                        format!(
                            "Will retry cleanup of @{name}'s {provider} subscription: {}",
                            error.message
                        ),
                    );
                }
            }
        }
    }

    /// The relayfile workspace an agent's integrations live in. Agent
    /// Relay's unified registry gives a workspace one id across Relaycast
    /// and relayfile, so it is the agent's Relaycast workspace.
    async fn relayfile_workspace(
        &self,
        registration: &Registration,
        key: &Secret,
    ) -> Result<String, RpcError> {
        match self
            .relaycast_workspace_id(&registration.base_url, key)
            .await
        {
            Ok(id) => Ok(id),
            Err(error) => {
                // Offline or refused: the account's own workspace, when this
                // agent was registered in it.
                let account = self.store.read(|s| {
                    s.cloud
                        .as_ref()
                        .filter(|cloud| &cloud.key == key)
                        .and_then(|cloud| {
                            cloud
                                .relayfile_workspace_id
                                .clone()
                                .or(cloud.workspace_id.clone())
                        })
                });
                account
                    .ok_or_else(|| relaycast(&error, "Could not look up this agent's workspace."))
            }
        }
    }

    /// A short-lived relayfile credential for `workspace`, minted by Cloud.
    async fn relayfile(&self, workspace: &str) -> Result<Relayfile, RpcError> {
        let body = self
            .plugins
            .cloud
            .request(
                "POST",
                format!("/workspaces/{}/relayfile/delegated-token", segment(workspace)),
                Some(json!({"agentName": "relay-desktop", "scopes": ["fs:read", "fs:write"]})),
            )
            .await
            .map_err(|error| match error {
                crate::relay::cloud_session::CloudError::Status {
                    status: 403 | 404, ..
                } => RpcError::new(
                    ErrorKind::CloudRefused,
                    "This agent's workspace isn't your current Agent Relay workspace. Switch to it in Agent Relay, or register the agent in your current workspace.",
                ),
                error => RpcError::cloud(&error),
            })?;
        let token = body["relayfileToken"].as_str().filter(|t| !t.is_empty());
        let base = body["relayfileUrl"].as_str().and_then(validated_base_url);
        let (Some(token), Some(base_url)) = (token, base) else {
            return Err(failed("Agent Relay did not return relayfile credentials."));
        };
        let issued = body["relayfileWorkspaceId"].as_str().unwrap_or(workspace);
        if issued != workspace {
            return Err(failed(
                "Agent Relay issued credentials for a different workspace than this agent's.",
            ));
        }
        Ok(Relayfile {
            base_url,
            token: Secret::new(token),
            workspace: workspace.into(),
        })
    }

    /// Waits for `provider` to be connected to the workspace, asking the UI
    /// once to open Agent Relay's connect page. Gives up after five minutes.
    async fn ensure_connected(&self, provider: &str, workspace: &str) -> Result<(), RpcError> {
        let connected = || async {
            let value = self
                .plugins
                .cloud
                .request(
                    "GET",
                    format!("/workspaces/{}/integrations", segment(workspace)),
                    None,
                )
                .await
                .map_err(|e| RpcError::cloud(&e))?;
            let rows = match &value {
                Value::Array(rows) => rows.clone(),
                _ => value["integrations"]
                    .as_array()
                    .or(value["data"].as_array())
                    .cloned()
                    .ok_or_else(|| failed("Unreadable integration list from Agent Relay."))?,
            };
            Ok::<bool, RpcError>(rows.iter().any(|row| {
                row["provider"].as_str().map(str::to_lowercase).as_deref() == Some(provider)
                    && CONNECTED.contains(
                        &row["status"]
                            .as_str()
                            .unwrap_or_default()
                            .to_lowercase()
                            .as_str(),
                    )
            }))
        };
        if connected().await? {
            return Ok(());
        }
        let body = self
            .plugins
            .cloud
            .request(
                "POST",
                format!(
                    "/workspaces/{}/integrations/connect-session",
                    segment(workspace)
                ),
                Some(json!({"allowedIntegrations": [provider]})),
            )
            .await
            .map_err(|e| RpcError::cloud(&e))?;
        let inner = body.get("data").filter(|d| d.is_object()).unwrap_or(&body);
        let link = inner["connectLink"]
            .as_str()
            .or(inner["url"].as_str())
            .filter(|link| link.starts_with("https://"))
            .ok_or_else(|| {
                failed(format!(
                    "Agent Relay did not return a link to connect {provider}."
                ))
            })?;
        self.hub.notify(
            &format!("Connect {provider}"),
            &format!("Finish connecting {provider} to Agent Relay in your browser."),
            Some(link),
        );
        for _ in 0..CONNECT_WAIT.as_secs() / CONNECT_POLL.as_secs() {
            tokio::time::sleep(CONNECT_POLL).await;
            if connected().await? {
                return Ok(());
            }
        }
        Err(RpcError::new(
            ErrorKind::Refused,
            format!("{provider} wasn't connected in time. Finish connecting it in the browser, then subscribe again."),
        ))
    }

    fn save_integration(&self, agent_id: &str, entry: &Integration) -> Result<(), RpcError> {
        self.store
            .update(|store| {
                let Some(registration) = store
                    .registrations
                    .iter()
                    .find(|r| r.agent_id == agent_id)
                    .cloned()
                else {
                    return false;
                };
                let mut updated = registration;
                let list = updated.integrations.get_or_insert_with(Vec::new);
                list.retain(|existing| existing.id != entry.id);
                list.push(entry.clone());
                store.update(updated);
                true
            })
            .map_err(|e| RpcError::store(&e))?
            .then_some(())
            .ok_or_else(|| {
                RpcError::new(
                    ErrorKind::NotFound,
                    "The agent was removed during integration setup.",
                )
            })
    }

    fn integration_target(&self, name: &str) -> Result<(Registration, Secret), RpcError> {
        let registration = self
            .store
            .read(|s| s.registration_named(name).cloned())
            .ok_or_else(|| {
                RpcError::new(
                    ErrorKind::NotFound,
                    format!("No agent named @{name} is on the relay from this computer."),
                )
            })?;
        let key = self.key_for(&registration).ok_or_else(|| {
            RpcError::new(
                ErrorKind::Refused,
                "This agent's Agent Relay workspace key is missing.",
            )
        })?;
        Ok((registration, key))
    }

    /// Subscribes the agent to a provider resource: `owner/repo` or
    /// `owner/repo#123` on GitHub, or an explicit `/<provider>/…` relayfile
    /// path.
    pub async fn subscribe_integration(
        &self,
        name: &str,
        provider: &str,
        resource: &str,
    ) -> Result<IntegrationChange, RpcError> {
        let resource = resource.trim();
        if !PROVIDERS.contains(&provider) || resource.is_empty() {
            return Err(RpcError::invalid_params(
                "Choose a provider and a resource.",
            ));
        }
        let glob = relayfile_glob(provider, resource).ok_or_else(|| {
            RpcError::invalid_params(if provider == "github" {
                "Enter a repository as owner/repo or owner/repo#123, e.g. acme/api#42.".to_string()
            } else {
                format!("For {provider}, enter a path such as /{provider}/…/**.")
            })
        })?;
        let (registration, key) = self.integration_target(name)?;
        can_subscribe(&registration, provider, &glob)?;
        let workspace = self.relayfile_workspace(&registration, &key).await?;
        // Connecting the provider waits for the person in the browser (up to
        // minutes), so it runs before the agent is held: removing or
        // changing the agent meanwhile is not blocked behind it.
        self.ensure_connected(provider, &workspace).await?;
        let lock = self.target_locks.get(&registration.target.key());
        let (Ok(_changing), Ok(_integrating)) = (lock.try_lock(), self.integration_lock.try_lock())
        else {
            return Err(RpcError::new(
                ErrorKind::Busy,
                "Another integration or agent change is running.",
            ));
        };
        let held = registration;
        let (registration, key) = self.integration_target(name)?;
        if registration.agent_id != held.agent_id || registration.target != held.target {
            return Err(RpcError::new(
                ErrorKind::Busy,
                format!("@{name} changed while connecting {provider}. Subscribe again."),
            ));
        }
        can_subscribe(&registration, provider, &glob)?;
        let files = self.relayfile(&workspace).await?;
        let base = &registration.base_url;
        let agent_id = &registration.agent_id;
        let mut entry = Integration::new(provider, resource, &workspace);
        entry.path_glob = Some(glob.clone());
        // Journaled before even the shared channel is created; its name is
        // derived from the agent, so cleanup can recover a lost answer.
        self.save_integration(agent_id, &entry)?;
        let http = sdk_gaps::http(base, &key)
            .map_err(|e| relaycast(&e, "Could not reach Agent Relay."))?;
        let channel = sdk_gaps::subscription_channel(&http, name, agent_id)
            .await
            .map_err(|e| relaycast(&e, "The agent's event channel did not verify."))?;
        self.store
            .update(|store| {
                if let Some(mut current) = store.registration_named(name).cloned() {
                    current.integration_channel_id = Some(channel.id.clone());
                    current.integration_channel_name = Some(channel.name.clone());
                    store.update(current);
                }
            })
            .map_err(|e| RpcError::store(&e))?;
        let (writeback_url, writeback_secret) = files.writeback_secret(&channel.name).await?;
        let inbound = sdk_gaps::relayfile_inbound_target(&http, &channel.name, provider, &glob)
            .await
            .map_err(|e| relaycast(&e, "Could not create the inbound target."))?;
        let unsafe_url =
            || failed("relayfile or Agent Relay returned an address that is not https.");
        entry.inbound_url = Some(attempt_url(&inbound.url, &entry.id).ok_or_else(unsafe_url)?);
        entry.writeback_url = Some(attempt_url(&writeback_url, &entry.id).ok_or_else(unsafe_url)?);
        self.save_integration(agent_id, &entry)?;
        let inbound_url = entry.inbound_url.clone().unwrap_or_default();
        entry.cloud_subscription_id = Some(
            files
                .create_subscription(&inbound_url, std::slice::from_ref(&glob), &inbound.secret)
                .await?,
        );
        self.save_integration(agent_id, &entry)?;
        let writeback = entry.writeback_url.clone().unwrap_or_default();
        entry.subscription_id = Some(
            client::create_reply_subscription(
                base,
                &key,
                &channel.name,
                &writeback,
                &writeback_secret,
            )
            .await
            .map_err(|e| relaycast(&e, "Could not create the reply subscription."))?,
        );
        entry.ready = Some(true);
        self.save_integration(agent_id, &entry)?;
        self.request_drain(name);
        self.hub.invalidated(Listing::Agents);
        Ok(IntegrationChange {
            subscribed: true,
            provider: provider.into(),
            resource: resource.into(),
            path_glob: Some(glob),
            already_unsubscribed: false,
        })
    }

    /// Undoes every step of a subscription (or of an unfinished one),
    /// including steps whose answer was lost. On failure the recovery
    /// record is kept, so cleaning up again continues where this stopped.
    pub async fn unsubscribe_integration(
        &self,
        name: &str,
        provider: &str,
        resource: &str,
    ) -> Result<IntegrationChange, RpcError> {
        let resource = resource.trim();
        let (registration, _) = self.integration_target(name)?;
        let lock = self.target_locks.get(&registration.target.key());
        let (Ok(_changing), Ok(_integrating)) = (lock.try_lock(), self.integration_lock.try_lock())
        else {
            return Err(RpcError::new(
                ErrorKind::Busy,
                "Another integration or agent change is running.",
            ));
        };
        // Read again under the lock: a change that finished meanwhile is
        // what this undoes.
        let held = registration;
        let (registration, key) = self.integration_target(name)?;
        if registration.target != held.target {
            return Err(RpcError::new(
                ErrorKind::Busy,
                format!("@{name} changed meanwhile. Try again."),
            ));
        }
        // The same subscription may be named another way than it was made:
        // `owner/repo#123` and that pull request's address are one resource.
        let glob = relayfile_glob(provider, resource);
        let Some(entry) = registration
            .integrations
            .iter()
            .flatten()
            .find(|i| {
                i.provider == provider
                    && (i.resource == resource
                        || i.path_glob.as_deref() == Some(resource)
                        || (glob.is_some() && i.path_glob == glob))
            })
            .cloned()
        else {
            return Ok(IntegrationChange {
                subscribed: false,
                provider: provider.into(),
                resource: resource.into(),
                path_glob: None,
                already_unsubscribed: true,
            });
        };
        let files = self.relayfile(&entry.workspace_id).await?;
        let base = &registration.base_url;
        let agent_id = &registration.agent_id;
        let mut pending = entry.clone();
        pending.ready = Some(false);
        self.save_integration(agent_id, &pending)?;
        let channel_name = registration
            .integration_channel_name
            .clone()
            .unwrap_or_else(|| format!("agent-events-{agent_id}"));
        // Lists recover creates whose answer or local save was lost.
        let cloud_rows = files.subscriptions().await?;
        let http = sdk_gaps::http(base, &key)
            .map_err(|e| relaycast(&e, "Cleanup could not reach Agent Relay."))?;
        let hooks = sdk_gaps::list_webhooks(&http)
            .await
            .map_err(|e| relaycast(&e, "Cleanup could not read the workspace's webhooks."))?;
        let outbound = client::list_subscriptions(base, &key)
            .await
            .map_err(|e| relaycast(&e, "Cleanup could not read the workspace's subscriptions."))?;
        let mut cloud_ids: HashSet<String> = cloud_rows
            .iter()
            .filter(|row| {
                entry.inbound_url.is_some() && row["url"].as_str() == entry.inbound_url.as_deref()
            })
            .filter_map(row_id)
            .collect();
        cloud_ids.extend(entry.cloud_subscription_id.clone());
        for id in &cloud_ids {
            files.delete_subscription(id).await?;
        }
        let mut outbound_ids: HashSet<String> = outbound
            .iter()
            .filter(|s| {
                entry.writeback_url.is_some()
                    && Some(s.url.as_str()) == entry.writeback_url.as_deref()
            })
            .map(|s| s.id.clone())
            .collect();
        outbound_ids.extend(entry.subscription_id.clone());
        for id in &outbound_ids {
            client::delete_subscription(base, &key, id)
                .await
                .map_err(|e| relaycast(&e, "Could not remove the reply subscription."))?;
        }
        // Subscriptions made by earlier versions also created a Relaycast
        // webhook per subscription.
        let mut hook_ids: HashSet<String> = hooks
            .iter()
            .filter(|hook| hook.name == entry.webhook_name())
            .map(|hook| hook.id.clone())
            .collect();
        hook_ids.extend(entry.webhook_id.clone());
        for id in &hook_ids {
            client::delete_webhook(base, &key, id)
                .await
                .map_err(|e| relaycast(&e, "Could not remove the integration webhook."))?;
        }
        let mut current = self
            .store
            .read(|s| {
                s.registrations
                    .iter()
                    .find(|r| &r.agent_id == agent_id)
                    .cloned()
            })
            .ok_or_else(|| RpcError::new(ErrorKind::NotFound, "The agent no longer exists."))?;
        if let Some(list) = current.integrations.as_mut() {
            list.retain(|i| i.id != entry.id);
        }
        // The shared channel stays while anything else still posts into it.
        let others_use_channel =
            current
                .integration_channel_id
                .as_ref()
                .is_some_and(|channel_id| {
                    let marker = format!("/inbound/{}/{channel_id}", entry.workspace_id);
                    cloud_rows.iter().any(|row| {
                        let (Some(url), Some(id)) = (row["url"].as_str(), row_id(row)) else {
                            return false;
                        };
                        Some(url) != entry.inbound_url.as_deref()
                            && !cloud_ids.contains(&id)
                            && url.contains(&marker)
                    })
                });
        if !current.has_integrations() && !others_use_channel {
            let token = self
                .store
                .read(|s| s.tokens.get(name).cloned())
                .ok_or_else(|| {
                    RpcError::new(
                        ErrorKind::Refused,
                        "The agent's token is missing; could not leave its integration channel.",
                    )
                })?;
            client::leave_channel(base, &token, &channel_name)
                .await
                .map_err(|e| relaycast(&e, "Could not leave the integration channel."))?;
            current.integration_channel_id = None;
            current.integration_channel_name = Some(channel_name);
            current.integrations = None;
        }
        self.store
            .update(|store| store.update(current))
            .map_err(|e| RpcError::store(&e))?;
        self.hub.invalidated(Listing::Agents);
        Ok(IntegrationChange {
            subscribed: false,
            provider: provider.into(),
            resource: resource.into(),
            path_glob: None,
            already_unsubscribed: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // InjectableIntegrationTests.testRecoveryURLsPreserveRouteAndRejectUnsafeOrigins.
    #[test]
    fn attempt_urls_keep_the_route_and_refuse_unsafe_origins() {
        let one = attempt_url(
            "https://example.com/inbound?path_glob=%2Fgithub%2F**",
            "one",
        )
        .unwrap();
        let two = attempt_url(
            "https://example.com/inbound?path_glob=%2Fgithub%2F**",
            "two",
        )
        .unwrap();
        assert_ne!(one, two);
        let parsed = Url::parse(&one).unwrap();
        let pairs: Vec<(String, String)> = parsed.query_pairs().into_owned().collect();
        assert!(pairs.contains(&("path_glob".into(), "/github/**".into())));
        assert!(pairs.contains(&("desktopSubscription".into(), "one".into())));
        assert_eq!(attempt_url("http://example.com", "one"), None);
        assert_eq!(
            attempt_url("https://user:password@example.com", "one"),
            None
        );
    }

    #[test]
    fn a_closed_or_merged_pull_expires_only_its_numeric_subscription() {
        let mut registration: Registration = serde_json::from_value(json!({
            "name": "reviewer",
            "agentID": "agent_1",
            "target": {"kind": "codex", "id": "s1"},
            "title": "reviewer",
            "baseURL": "https://relay.example",
            "registeredAt": "2026-10-01T00:00:00Z",
            "integrations": []
        }))
        .unwrap();
        let mut pull = Integration::new("github", "acme/api#42", "rw_1");
        pull.path_glob = Some("/github/repos/acme/api/pulls/42/**".into());
        pull.ready = Some(true);
        let pull_id = pull.id.clone();
        let mut repository = Integration::new("github", "acme/api", "rw_1");
        repository.path_glob = Some("/github/repos/acme/api/**".into());
        repository.ready = Some(true);
        registration.integrations = Some(vec![pull, repository]);

        assert_eq!(
            terminal_integration(
                &registration,
                "Github pull_request.closed\nRelayfile path: /github/repos/acme/api/pulls/42__done/meta.json",
                None
            ),
            Some((pull_id.clone(), "github".into(), "acme/api#42".into()))
        );
        assert_eq!(
            terminal_integration(
                &registration,
                "Github pull_request_review.submitted\nRelayfile path: /github/repos/acme/api/reviews/1.json",
                None
            ),
            None
        );
        assert_eq!(
            terminal_integration(
                &registration,
                "Github pull_request.closed\nMerged",
                Some("/github/repos/acme/api/pulls/42__done/meta.json")
            ),
            Some((pull_id, "github".into(), "acme/api#42".into()))
        );

        registration.integrations.as_mut().unwrap()[0].ready = Some(false);
        assert!(can_subscribe(
            &registration,
            "github",
            "/github/repos/acme/api/pulls/43/**"
        )
        .is_ok());
        assert_eq!(
            can_subscribe(
                &registration,
                "github",
                "/github/repos/acme/api/pulls/42/**"
            )
            .unwrap_err()
            .data
            .kind,
            ErrorKind::Refused
        );
        registration.integrations.as_mut().unwrap()[0].ready = Some(true);
        registration.integrations.as_mut().unwrap()[0].terminal = Some(true);
        assert!(needs_cleanup(
            &registration.integrations.as_ref().unwrap()[0]
        ));
    }
}
