//! Workspace, integration defaults and automatic MCP setup refresh.
use super::*;

pub(super) async fn run(core: Arc<Core>) {
    let mut ticks = tokio::time::interval(core.config.rediscover_every);
    // A slow verification delays the next refresh rather than queueing
    // missed ticks to fire back to back.
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticks.tick().await;
        // The workspace, then the hosted MCP links that pick reply hints.
        core.refresh_pass().await;
        if let Some(account) = &core.plugins.account {
            account.maintain().await;
        }
        // A tool installed since the last pass gets its integration default,
        // unless the relay CLI manages this core and chose the tools itself.
        let defaults = core.clone();
        let _ = tokio::task::spawn_blocking(move || {
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
