//! Gate, claim and settle one provider delivery under the route lock.
use super::{
    printable, Adapter, Claim, Eligibility, Failure, Gate, Journal, Outcome, Provider, Request,
};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

pub struct Coordinator {
    gate: Gate,
    pub(super) journal: Journal,
    adapters: HashMap<Provider, Arc<dyn Adapter>>,
}

impl Coordinator {
    pub fn new(gate: Gate, journal: Journal, adapters: Vec<Arc<dyn Adapter>>) -> Option<Self> {
        let mut routes = HashMap::new();
        for adapter in adapters {
            if routes.insert(adapter.provider(), adapter).is_some() {
                return None;
            }
        }
        Some(Self {
            gate,
            journal,
            adapters: routes,
        })
    }

    pub fn inject(&self, request: &Request<'_>) -> Outcome {
        match self.gate.eligibility(request.binding) {
            Eligibility::Eligible => {}
            Eligibility::Disabled => return Outcome::Refused(Failure::Disabled),
            Eligibility::UnsupportedTransport => {
                return Outcome::Refused(Failure::UnsupportedRoute)
            }
            Eligibility::AmbiguousIdentity => return Outcome::Refused(Failure::IdentityMismatch),
            Eligibility::MissingAuthentication => {
                return Outcome::Refused(Failure::AuthenticationUnavailable)
            }
        }
        if !printable(request.delivery_id, 256)
            || !printable(request.message_id, 256)
            || request.text.is_empty()
            || request.text.len() > 65_536
            || !(Duration::from_secs(1)..=Duration::from_secs(30)).contains(&request.timeout)
        {
            return Outcome::Refused(Failure::ProviderRefused);
        }
        let Some(adapter) = self.adapters.get(&request.binding.provider) else {
            return Outcome::Refused(Failure::UnsupportedRoute);
        };
        let result = self.journal.with_route_lock(request.binding, || {
            let claim = self.journal.claim(request);
            match claim {
                Ok(Claim::Delivered(receipt_id)) => Outcome::Delivered { receipt_id },
                Ok(Claim::InDoubt) => Outcome::InDoubt(Failure::PriorAttemptUncertain),
                Ok(Claim::RequestConflict) => Outcome::Refused(Failure::RequestConflict),
                Ok(Claim::Unclaimed) => Outcome::Retry(Failure::JournalUnavailable),
                Ok(Claim::Send(command_id)) => {
                    let outcome = adapter.inject(request, &command_id);
                    if self
                        .journal
                        .settle(request, &command_id, &outcome, false)
                        .is_err()
                    {
                        Outcome::InDoubt(Failure::JournalUnavailable)
                    } else if matches!(&outcome, Outcome::Delivered { receipt_id } if !printable(receipt_id, 256)) {
                        Outcome::InDoubt(Failure::PriorAttemptUncertain)
                    } else {
                        outcome
                    }
                }
                Ok(Claim::Replay(command_id)) => {
                    let outcome = adapter.replay(request, &command_id);
                    if self
                        .journal
                        .settle(request, &command_id, &outcome, true)
                        .is_err()
                    {
                        Outcome::InDoubt(Failure::JournalUnavailable)
                    } else if matches!(&outcome, Outcome::Delivered { receipt_id } if !printable(receipt_id, 256)) {
                        Outcome::InDoubt(Failure::PriorAttemptUncertain)
                    } else {
                        outcome
                    }
                }
                Err(_) => Outcome::InDoubt(Failure::JournalUnavailable),
            }
        });
        // The route lock could not be taken (`with_route_lock` returns `Err`
        // only before `body`): the provider was not contacted, and a later
        // attempt still claims this delivery's record first.
        result.unwrap_or(Outcome::Retry(Failure::JournalUnavailable))
    }
}
