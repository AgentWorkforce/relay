//! A registration's saved workspace key that Relaycast rejects. Each
//! registration keeps the key it registered with, and a rotation is only
//! rewritten into those copies when the core sees both keys verify to one
//! workspace; a key rotated while the core was elsewhere (another sign-in,
//! a rotation whose grace lapsed while it was off) strands them: every
//! removal, presence and marker write fails with 401 on each pass, and the
//! registration can never leave. The core's current key settles it: when
//! that key's workspace holds this very agent (the same Relaycast agent
//! id), the saved key was rotated and every saved copy moves to the current
//! one; when it holds no such agent, the rejected key's workspace is out of
//! this computer's reach, and nothing it would write there can land.

use crate::relay::daemon::Core;
use crate::relay::sdk_gaps;
use crate::relay::state::Level;
use crate::relay::store::Registration;
use crate::relay::workspace::{Secret, Workspace};

/// What the core's current key says of a rejected saved key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum KeyProof {
    /// The current key's workspace holds this agent: the saved key was
    /// rotated, and the current key now stands in every saved copy.
    Current(Secret),
    /// The current key's workspace holds no such agent: the saved key's
    /// workspace cannot be written to from here any more.
    Unreachable,
    /// Nothing is proved: not a rejected credential, no other key at this
    /// origin, or the check itself failed. Try again later.
    Unknown,
}

/// Only a 401 says the key itself is no longer valid; a 403 is a valid key
/// refused one action, which no other key should be tried for.
fn rejects_the_key(error: &relaycast::RelayError) -> bool {
    matches!(error, relaycast::RelayError::Api { status: 401, .. })
}

/// The Relaycast id of the agent `name` in the workspace `key` belongs to,
/// or `None` when that workspace has no agent of the name.
async fn agent_id(current: &Workspace, name: &str) -> relaycast::Result<Option<String>> {
    // `GET /v1/agents/{name}`: brokered by Control for a node credential.
    let workspace = sdk_gaps::workspace_http(current)?;
    let agent = sdk_gaps::get_agent(&workspace, name).await?;
    match agent {
        None => Ok(None),
        // An answer without a readable id proves nothing either way.
        Some(agent) => agent["id"]
            .as_str()
            .map(|id| Some(id.to_owned()))
            .ok_or_else(|| relaycast::RelayError::InvalidResponse("agent without an id".into())),
    }
}

impl Core {
    /// Settles a write `registration` made with its saved key `rejected`
    /// that failed with `error`. Asks once, with the current key, whether
    /// its workspace holds this agent; a rotation found is saved for every
    /// copy of the rejected key, pending cleanups included.
    pub(crate) async fn prove_rejected_key(
        &self,
        registration: &Registration,
        rejected: &Secret,
        error: &relaycast::RelayError,
    ) -> KeyProof {
        if !rejects_the_key(error) {
            return KeyProof::Unknown;
        }
        let Some(current) = self
            .workspace()
            .filter(|w| w.base_url == registration.base_url && w.key != *rejected)
        else {
            return KeyProof::Unknown;
        };
        let checked = agent_id(&current, &registration.name).await;
        match checked {
            Ok(Some(id)) if id == registration.agent_id => {
                self.adopt_rotation(registration, rejected, current)
            }
            // Another agent holds the name there, or none does.
            Ok(_) => KeyProof::Unreachable,
            Err(_) => KeyProof::Unknown,
        }
    }

    /// Runs `write` with `registration`'s saved `key`, recording the
    /// outcome; when that key is rejected and proved rotated, once more
    /// with the current key. Also says whether the key's workspace is out
    /// of reach, so the caller stops retrying a write that cannot land.
    pub(crate) async fn write_with_saved_key<F, Fut>(
        &self,
        registration: &Registration,
        key: &Secret,
        write: F,
    ) -> (relaycast::Result<()>, bool)
    where
        F: Fn(Secret) -> Fut,
        Fut: std::future::Future<Output = relaycast::Result<()>>,
    {
        let base = &registration.base_url;
        let result = write(key.clone()).await;
        self.observe_relaycast_write_result(&self.relaycast_scope(base, key), &result);
        let Err(error) = &result else {
            return (result, false);
        };
        match self.prove_rejected_key(registration, key, error).await {
            KeyProof::Current(current) => {
                let retried = write(current.clone()).await;
                self.observe_relaycast_write_result(
                    &self.relaycast_scope(base, &current),
                    &retried,
                );
                (retried, false)
            }
            KeyProof::Unreachable => (result, true),
            KeyProof::Unknown => (result, false),
        }
    }

    fn adopt_rotation(
        &self,
        registration: &Registration,
        rejected: &Secret,
        current: Workspace,
    ) -> KeyProof {
        let base = registration.base_url.clone();
        let control_url = current.control_url.clone();
        let current = current.key;
        let saved = self.store.update(|store| {
            store.rotate_workspace_key(&base, rejected, &current, control_url.as_deref())
        });
        match saved {
            // An earlier proof already moved every saved copy: nothing new.
            Ok(0) => KeyProof::Current(current),
            Ok(_) => {
                self.hub.activity(
                    Level::Info,
                    format!(
                        "@{}'s saved workspace key was replaced since it registered; this computer's agents in that workspace now use the current one.",
                        registration.name
                    ),
                );
                KeyProof::Current(current)
            }
            Err(error) => {
                self.hub.activity(
                    Level::Warning,
                    format!(
                        "@{}'s saved workspace key was replaced, but this computer could not save the current one: {error}",
                        registration.name
                    ),
                );
                KeyProof::Unknown
            }
        }
    }
}

#[cfg(test)]
#[path = "rejected_keys_tests.rs"]
mod tests;
