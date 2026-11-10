//! Workspace, integration defaults and automatic MCP setup refresh.
use super::*;

pub(super) async fn run(core: Arc<Core>) {
    let mut ticks = tokio::time::interval(core.config.rediscover_every);
    // A slow verification delays the next refresh rather than queueing
    // missed ticks to fire back to back.
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticks.tick().await;
        core.refresh_workspace().await;
        if let Some(account) = &core.plugins.account {
            account.maintain().await;
        }
        // A tool installed since the last pass gets its integration default,
        // unless the relay CLI manages this core and chose the tools itself.
        let defaults = core.clone();
        let _ = tokio::task::spawn_blocking(move || {
            defaults.reclaim_own_integrations();
            if defaults
                .integration_defaults
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                defaults.apply_integration_defaults();
            }
            if let Some(account) = &defaults.plugins.account {
                for warning in account.refresh_tools(&defaults) {
                    defaults
                        .hub
                        .activity(crate::relay::state::Level::Warning, warning);
                }
            }
        })
        .await;
    }
}

impl Core {
    /// Puts back this build's own relay-send pointer and session hooks when
    /// another process displaced them: on every rediscovery tick and when
    /// setup (`workspace.verify`) runs. Only this build's pointer file and
    /// hooks are written; another build's are never touched
    /// (`SettingsExtension::reclaim`, `ServingPath::reclaim_pointer`).
    pub fn reclaim_own_integrations(&self) {
        if let Some(send) = &self.plugins.relay_send {
            match send.serving.reclaim_pointer() {
                crate::relay::outbound::Reclaimed::Rewritten => self.hub.activity(
                    crate::relay::state::Level::Info,
                    "Another process had replaced this app's session socket pointer; it was put back.",
                ),
                crate::relay::outbound::Reclaimed::Failed => self.hub.activity(
                    crate::relay::state::Level::Warning,
                    "This app's session socket pointer could not be put back.",
                ),
                _ => {}
            }
        }
        for extension in &self.plugins.settings {
            extension.reclaim();
        }
    }
}
