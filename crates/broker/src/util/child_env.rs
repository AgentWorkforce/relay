use tokio::process::Command;

/// Broker-only credential-authority inputs that must not cross into an agent
/// harness process.
///
/// A workspace key is intentionally available to workers for ordinary Relay
/// operations. The sponsor grant and work-unit root are different: together
/// they authorize the broker to create or reclaim agent identities. Letting a
/// spawned harness inherit them would hand that agent the broker's registration
/// authority instead of only the already-issued `RELAY_AGENT_TOKEN` scoped to
/// its own identity.
pub(crate) const REGISTRATION_AUTHORITY_ENV_KEYS: &[&str] = &[
    "RELAYAUTH_SPONSOR_PROOF",
    "RELAYAUTH_SPONSOR_ID",
    "RELAYAUTH_SPONSOR_ORG_ID",
    "RELAYAUTH_ISSUER",
    "RELAYAUTH_SIGNING_KEY_PEM_PUBLIC",
    "RELAYAUTH_SIGNING_KEY_PEM_PRIVATE",
    "RELAYAUTH_SIGNING_KEY_PEM",
    "RELAYAUTH_TEST_SPONSOR_FIXTURE",
    "RELAY_AGENT_IDENTITY_KEY",
    "RELAYCAST_AGENT_CREDENTIAL_AUTHORITY_PUBLIC_KEY_PEM",
    "RELAYCAST_AGENT_CREDENTIAL_AUTHORITY_ISSUER",
    "RELAYCAST_AGENT_CREDENTIAL_AUTHORITY_AUDIENCE",
];

/// Remove broker registration authority after all caller-supplied environment
/// has been applied. Keeping this as the final environment step prevents a
/// harness-specific `env` block from adding the capability back.
pub(crate) fn scrub_registration_authority(command: &mut Command) {
    for key in REGISTRATION_AUTHORITY_ENV_KEYS {
        command.env_remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrub_overrides_explicit_child_environment() {
        let mut command = Command::new("unused");
        for key in REGISTRATION_AUTHORITY_ENV_KEYS {
            command.env(key, "must-not-reach-agent");
        }

        scrub_registration_authority(&mut command);

        let overrides = command
            .as_std()
            .get_envs()
            .collect::<std::collections::HashMap<_, _>>();
        for key in REGISTRATION_AUTHORITY_ENV_KEYS {
            assert_eq!(
                overrides.get(std::ffi::OsStr::new(key)).copied(),
                Some(None),
                "{key} must be explicitly removed from the child environment"
            );
        }
    }
}
