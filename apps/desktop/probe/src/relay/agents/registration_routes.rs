use super::*;

impl Core {
    pub(super) async fn registration_route_binding(
        &self,
        session: &DiscoveredSession,
    ) -> Result<Option<String>, RpcError> {
        let target = &session.target;
        Ok(if target.kind == SessionKind::GrokOpen {
            let mut binding = self.live_route_binding(target).await;
            if binding.is_none() {
                self.bind_open_grok(session).await?;
                binding = self.live_route_binding(target).await;
            }
            Some(binding.ok_or_else(|| {
                RpcError::new(
                    ErrorKind::Refused,
                    "This already-open Grok session has no live binding.",
                )
            })?)
        } else if target.kind == SessionKind::Pi {
            Some(self.live_route_binding(target).await.ok_or_else(|| {
                RpcError::new(
                    ErrorKind::Refused,
                    "Pi is not connected. Run /reload in the Pi session.",
                )
            })?)
        } else if target.kind == SessionKind::MuseOpen {
            // Only Relay-owned Muse spawns reach this branch. Delivery also
            // rechecks the saved spawn process before using the courier.
            Some(crate::relay::harness::muse::courier::courier_reference(&target.id))
        } else if target.kind == SessionKind::OpenCodeOpen {
            // Like a Muse session, an open OpenCode session needs no stored
            // binding: delivery finds the one live process holding it and
            // proves that process and its socket before every request. The
            // registration pins the session so only its agent may send.
            Some(crate::relay::opencode::route_reference(&target.id))
        } else {
            None
        })
    }
}
