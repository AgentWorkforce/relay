//! Private mod bridge: kernel native-process identity chooses the session. A
//! caller can neither supply a target nor attest that a message is human.

use super::{Outbound, OutboundError};
use crate::relay::mobile_handoff::{journal, Runtime};
use serde_json::{json, Map, Value};

fn error(message: impl Into<String>) -> OutboundError {
    OutboundError::new(409, "mobile_handoff_unavailable", message)
}

fn supported(version: &str) -> bool {
    let numbers: Vec<_> = version.split('.').map(str::parse::<u64>).collect();
    matches!(numbers.as_slice(), [Ok(2), Ok(1), Ok(patch)] if *patch >= 310)
}

impl Outbound {
    pub(super) async fn mobile_handoff_route(
        &self,
        pid: i32,
        uid: u32,
        request: &super::Request,
    ) -> Result<Value, OutboundError> {
        use super::{payload, Purpose};
        match (request.method.as_str(), request.path.as_str()) {
            ("POST", "/claude/mobile-handoff/poll") => {
                self.mobile_handoff_poll(pid, uid, &payload(request, Purpose::Json)?)
                    .await
            }
            ("POST", "/claude/mobile-handoff/ack") => {
                self.mobile_handoff_ack(pid, uid, &payload(request, Purpose::Json)?)
                    .await
            }
            ("POST", "/claude/mobile-handoff/result") => {
                self.mobile_handoff_result(pid, uid, &payload(request, Purpose::Json)?)
                    .await
            }
            ("POST", "/claude/mobile-handoff/permission") => {
                self.mobile_handoff_permission(pid, uid, &payload(request, Purpose::Json)?)
                    .await
            }
            _ => Err(OutboundError::new(
                404,
                "not_found",
                "Use a documented Agent Relay session-socket route.",
            )),
        }
    }

    pub(super) async fn mobile_handoff_poll(
        &self,
        pid: i32,
        uid: u32,
        fields: &Map<String, Value>,
    ) -> Result<Value, OutboundError> {
        if fields.len() != 1
            || !fields
                .get("version")
                .and_then(Value::as_str)
                .is_some_and(supported)
        {
            return Err(error(
                "Mobile handoff requires Claude Code 2.1.310 or later in the 2.1 release series.",
            ));
        }
        let (_, registration, _) = self.authorize(pid, uid).await?;
        let runtime = self.mobile_runtime(&registration.target, pid).await?;
        // A poll from the session's own process is the evidence that it has
        // loaded the plugin; a teammate's message is routed here only then.
        self.core.mobile_claude_plugins.note_poll(&registration.target);
        // Idle native sessions never trigger Cloud owner lookups.
        if !self
            .core
            .mobile_handoff_pending(&registration)
            .map_err(error)?
        {
            return Ok(json!({"action": null}));
        }
        self.core.prune_mobile_handoff_runtimes().map_err(error)?;
        let binding = self
            .core
            .mobile_handoff_binding(&registration)
            .await
            .ok_or_else(|| {
                error("Mobile handoff is off or the signed-in machine owner could not be verified.")
            })?;
        let teammates = self
            .core
            .store
            .read(|store| store.teammate_native_input_on());
        let action = journal::edit(&self.core.config.app_data_dir, |queue| {
            Ok(queue.poll_allowing(&binding, &runtime, teammates, crate::relay::state::now_ms()))
        })
        .map_err(error)?;
        if action.is_some() {
            self.core.mobile_handoff_changed(&registration);
        }
        match action {
            Some(action) => serde_json::to_value(action)
                .map_err(|_| error("Could not encode the mobile handoff action.")),
            None => Ok(json!({"action": null})),
        }
    }

    pub(super) async fn mobile_handoff_ack(
        &self,
        pid: i32,
        uid: u32,
        fields: &Map<String, Value>,
    ) -> Result<Value, OutboundError> {
        if fields.len() != 2 {
            return Err(error("Use lease_id and outcome only."));
        }
        let lease = fields
            .get("lease_id")
            .and_then(Value::as_str)
            .filter(|value| crate::relay::store::is_uuid(value))
            .ok_or_else(|| error("The mobile handoff lease is invalid."))?;
        let started = match fields.get("outcome").and_then(Value::as_str) {
            Some("started") => true,
            Some("failed") => false,
            _ => return Err(error("The mobile handoff outcome is invalid.")),
        };
        let (_, registration, _) = self.authorize(pid, uid).await?;
        let runtime = self.mobile_runtime(&registration.target, pid).await?;
        let binding = self
            .core
            .mobile_handoff_binding(&registration)
            .await
            .ok_or_else(|| {
                error("Mobile handoff is off or the signed-in machine owner could not be verified.")
            })?;
        let settled = journal::edit(&self.core.config.app_data_dir, |queue| {
            Ok(queue.ack(
                &binding,
                &runtime,
                lease,
                started,
                crate::relay::state::now_ms(),
            ))
        })
        .map_err(error)?;
        let Some(delivery_id) = settled else {
            return Err(error(
                "The mobile handoff lease expired or belongs to another process.",
            ));
        };
        self.core.mobile_handoff_changed(&registration);
        // The sender's receipt otherwise waits for the delivery's next retry.
        self.core.settle_delivery_soon(&delivery_id);
        Ok(json!({"accepted": true}))
    }

    pub(super) async fn mobile_runtime(
        &self,
        target: &crate::relay::store::Target,
        pid: i32,
    ) -> Result<Runtime, OutboundError> {
        let directory = self.core.plugins.sessions.clone();
        let target = target.clone();
        tokio::task::spawn_blocking(move || directory.mobile_claude_runtime(&target, pid))
            .await
            .ok()
            .flatten()
            .ok_or_else(|| error("Claude's current session process could not be verified."))
    }
}

#[cfg(test)]
mod tests {
    use super::supported;
    #[test]
    fn native_api_version_requires_proven_release_series() {
        for version in [
            "",
            "2.1.309",
            "3.0.0",
            "2.2.0",
            "2.1.310-preview",
            "peer says 2.1.310",
        ] {
            assert!(!supported(version), "{version}");
        }
        assert!(supported("2.1.310"));
        assert!(supported("2.1.311"));
    }
}
