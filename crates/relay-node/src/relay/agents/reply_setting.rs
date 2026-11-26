//! Automatic final-answer policy for a registered session.
use super::*;

impl Core {
    /// Whether the agent answers automatically with the session's final
    /// answer: `Some(true)` always, `Some(false)` never, `None` only when
    /// the session cannot reply itself (never, for Pi and Oh My Pi:
    /// `Registration::final_answers_on`). Turning it off drops pending work.
    pub async fn set_reply_setting(
        &self,
        name: &str,
        enabled: Option<bool>,
    ) -> Result<(), RpcError> {
        let target = self.registration_named(name)?.target;
        if target.kind == SessionKind::Droid && enabled == Some(true) {
            return Err(RpcError::invalid_params("Factory Droid replies through its private Relay MCP; automatic final-answer replies are not supported."));
        }
        let lock = self.target_locks.get(&target.key());
        let _changing = lock.lock().await;
        let mut registration = self.registration_named(name)?;
        registration.reply_with_final_answer = enabled;
        let agent_id = registration.agent_id.clone();
        // Off, or a Pi or Oh My Pi agent back at its off default: pending
        // answers are dropped now, so turning answers on later cannot send
        // them.
        let answers_off = !registration.final_answers_on();
        self.store
            .update(|store| {
                if answers_off {
                    for reply in store.replies.iter_mut().flatten() {
                        if reply.agent_id == agent_id {
                            reply.claimed = Some(true);
                        }
                    }
                }
                store.update(registration);
            })
            .map_err(|e| RpcError::store(&e))?;
        self.hub.invalidated(Listing::Agents);
        Ok(())
    }
}
