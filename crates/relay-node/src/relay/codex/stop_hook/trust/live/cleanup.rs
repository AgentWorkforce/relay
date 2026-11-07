//! Disk ownership survives a failed live-state reconciliation.

use crate::relay::codex::stop_hook::{CodexStopHookSettings, StopHookInbox, CONFIG_CREATED};
use std::sync::Arc;

#[test]
fn codex_hook_upgrade_failure_keeps_created_config_cleanup() -> anyhow::Result<()> {
    let temp = tempfile::tempdir()?;
    let home = temp.path().join(".codex");
    let state = temp.path().join("core-data");
    std::fs::create_dir_all(&home)?;
    let inbox = Arc::new(StopHookInbox::default());
    let mut settings = CodexStopHookSettings::new(
        home.clone(),
        "'/test/agent-relay-node' codex-stop-hook".into(),
        None,
        inbox.clone(),
    )
    .with_state_dir(state.clone())
    .with_trust(|home, _| {
        std::fs::write(home.join("config.toml"), "[hooks]\n").map_err(|e| e.to_string())
    })
    .with_untrust(|home, _, edit| {
        edit()?;
        std::fs::write(home.join("config.toml"), "").map_err(|e| e.to_string())
    });
    settings.live_refresh = Box::new(|_, _| Err("live owner unavailable".into()));
    assert!(settings.install().is_err());
    assert!(!inbox.is_ready());
    assert!(
        state.join(CONFIG_CREATED).exists(),
        "created config ownership must survive live failure"
    );
    settings.live_refresh = Box::new(|_, _| Ok(()));
    settings.install().map_err(anyhow::Error::msg)?;
    assert!(state.join(CONFIG_CREATED).exists());
    settings.remove().map_err(anyhow::Error::msg)?;
    assert!(!home.join("config.toml").exists());
    assert!(!state.join(CONFIG_CREATED).exists());
    Ok(())
}
