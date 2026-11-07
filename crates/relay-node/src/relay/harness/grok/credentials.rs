//! Only diagnose the simple, provably unconfigured case. Do not guess at
//! expiry, enterprise auth helpers, custom models, or unreadable config.
use std::collections::BTreeMap;
use std::path::Path;

pub(super) const MISSING: &str = "Grok has no saved login or configured API credentials. Run `grok login` or configure its model credentials, then try again.";

pub(super) fn missing(home: &Path, environment: &BTreeMap<String, String>) -> bool {
    // A managed Mac can supply auth outside the ordinary Grok home.
    if cfg!(target_os = "macos") && Path::new("/Library/Managed Preferences").exists() {
        return false;
    }
    missing_with_configs(
        home,
        environment,
        &[
            home.join("config.toml"),
            home.join("managed_config.toml"),
            home.join("requirements.toml"),
            Path::new("/etc/grok/managed_config.toml").to_owned(),
            Path::new("/etc/grok/requirements.toml").to_owned(),
        ],
    )
}

fn missing_with_configs(
    home: &Path,
    environment: &BTreeMap<String, String>,
    configs: &[std::path::PathBuf],
) -> bool {
    if !matches!(std::fs::metadata(home.join("auth.json")), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
    {
        return false;
    }
    if environment.iter().any(|(key, value)| {
        !value.is_empty()
            && (key == "XAI_API_KEY"
                || key == "GROK_API_KEY"
                || key == "GROK_TOKEN"
                || key.starts_with("GROK_AUTH")
                || key.starts_with("GROK_OIDC")
                || key.starts_with("GROK_CLI_CHAT_PROXY")
                || key.starts_with("GROK_MODELS"))
    }) {
        return false;
    }
    for path in configs {
        match std::fs::read_to_string(path) {
            Ok(config)
                if ["auth", "model", "api_key", "env_key", "endpoint"]
                    .iter()
                    .any(|key| config.to_ascii_lowercase().contains(key)) =>
            {
                return false
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return false,
            _ => {}
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_credentials_and_custom_auth_are_never_declared_missing() {
        let home = tempfile::tempdir().unwrap();
        let empty = BTreeMap::new();
        let configs = [home.path().join("config.toml")];
        let missing = |home: &Path, environment: &BTreeMap<String, String>| {
            missing_with_configs(home, environment, &configs)
        };
        assert!(missing(home.path(), &empty));
        std::fs::write(home.path().join("auth.json"), "{}").unwrap();
        assert!(!missing(home.path(), &empty));
        std::fs::remove_file(home.path().join("auth.json")).unwrap();
        assert!(!missing(
            home.path(),
            &[("XAI_API_KEY".into(), "fixture".into())].into()
        ));
        std::fs::write(
            home.path().join("config.toml"),
            "[model.custom]\nenv_key = 'CUSTOM_CREDENTIAL'\n",
        )
        .unwrap();
        assert!(!missing(home.path(), &empty));
    }
}
