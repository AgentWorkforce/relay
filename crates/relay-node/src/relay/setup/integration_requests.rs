//! Session-scoped integration subscription requests.
use super::{invalid_integration, OutboundError, Registration, Setup};
use crate::relay::delivery::policy::relayfile_glob;
use serde_json::{json, Map, Value};
impl Setup {
    /// Validate session-scoped subscription input and preserve specific filter errors.
    pub(super) async fn integration_request(
        &self,
        request: &Map<String, Value>,
        registration: Option<&Registration>,
        subscribing: bool,
    ) -> Result<Value, OutboundError> {
        let provider = request.get("provider").and_then(Value::as_str);
        let resource = request.get("resource").and_then(Value::as_str);
        let (Some(provider), Some(resource)) = (provider, resource) else {
            return Err(invalid_integration());
        };
        let resource = resource.trim();
        if request
            .keys()
            .any(|key| !["provider", "resource", "event_types"].contains(&key.as_str()))
            || resource.is_empty()
            || !crate::relay::integrations::PROVIDERS.contains(&provider)
        {
            return Err(invalid_integration());
        }
        let event_types: Vec<String> = request
            .get("event_types")
            .map(|value| serde_json::from_value(value.clone()))
            .transpose()
            .map_err(|_| invalid_integration())?
            .unwrap_or_default();
        let event_types = crate::relay::integrations::normalize_event_types(provider, &event_types)
            .map_err(|error| OutboundError::new(400, "invalid_integration", error.message))?;
        let registration = registration.ok_or_else(|| {
            OutboundError::new(
                403,
                "not_a_relay_session",
                "Register this session before subscribing it.",
            )
        })?;
        if !subscribing && !event_types.is_empty() {
            return Err(invalid_integration());
        }
        if subscribing {
            if let Some(glob) =
                held_subscription_events(registration, provider, resource, &event_types)
            {
                return Ok(json!({
                    "subscribed": true,
                    "provider": provider,
                    "resource": resource,
                    "path_glob": glob,
                    "already_subscribed": true,
                    "event_types": event_types,
                }));
            }
        }
        let result = if subscribing {
            self.core
                .subscribe_integration_events(&registration.name, provider, resource, &event_types)
                .await
        } else {
            self.core
                .unsubscribe_integration(&registration.name, provider, resource)
                .await
        };
        result
            .map(|change| serde_json::to_value(change).unwrap_or_default())
            .map_err(|error| OutboundError::from_rpc(&error, "integration_failed"))
    }
}

/// Treat a ready subscription as idempotent only when resource and exact filters agree.
pub(super) fn held_subscription_events(
    registration: &Registration,
    provider: &str,
    resource: &str,
    event_types: &[String],
) -> Option<String> {
    let glob = relayfile_glob(provider, resource)?;
    registration
        .integrations
        .iter()
        .flatten()
        .any(|held| {
            held.provider == provider
                && held.path_glob.as_deref() == Some(glob.as_str())
                && held.effective_event_types() == event_types
                && held.ready == Some(true)
                && held.terminal != Some(true)
        })
        .then_some(glob)
}
