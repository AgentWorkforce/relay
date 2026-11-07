use super::Core;
use std::sync::Arc;
use tokio::task::JoinHandle;

/// Background session work has one shutdown boundary.
pub(super) struct Watchers(Vec<JoinHandle<()>>);

pub(super) fn start(core: &Arc<Core>) -> Watchers {
    Watchers(vec![
        tokio::spawn(crate::relay::local_methods::watch(core.clone())),
        tokio::spawn(crate::relay::files::store::sweeper(
            core.config.app_data_dir.clone(),
        )),
    ])
}

impl Drop for Watchers {
    fn drop(&mut self) {
        for task in &self.0 {
            task.abort();
        }
    }
}
