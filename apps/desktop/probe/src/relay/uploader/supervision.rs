//! The 60 s supervision pass: restarts a stopped collector, replaces one
//! running an older build, and defers to a claim a live newer build holds.

use super::*;

impl Uploader {
    /// The 60 s check: brings the collector back when it stopped, or
    /// replaces one running an older build. An install a newer probe runs
    /// is left alone. Returns the status read, when one was, with the
    /// attachment revision it belongs to.
    pub async fn supervise(&self) -> Option<(u64, Value)> {
        let install = self.install()?;
        let revision = self.revision.load(Ordering::SeqCst);
        let status = match self.status().await {
            Ok(status) => status,
            Err(_) => {
                // A status read fails before the liveness gate when the store
                // is unreadable and no cycle report carries the failure — the
                // shape a dead newer build can leave behind. The collector
                // survives that same open failure and reports it as its own
                // cycle, so attempt the start: `start` re-checks the live
                // claim and the store, and no-ops when a collector runs.
                // The attachment can change while the failed read is in
                // flight (sign-out, a workspace switch); starting the captured
                // install then relaunches the former collector, so the
                // revision gate the success path uses applies here too.
                if self.revision.load(Ordering::SeqCst) == revision {
                    self.attempt_start(&install).await;
                }
                return None;
            }
        };
        if self.revision.load(Ordering::SeqCst) != revision {
            return None;
        }
        // A newer build's claim suppresses restart only while its process is
        // live: `upgrade_required_live` is computed per status read, so a
        // claim left by an exited collector — or a corrected runtime record —
        // cannot wedge supervision the way the attach-cached flag would.
        // Older probes do not report it; their installs keep the cached flag.
        let upgrade_live = status["upgrade_required_live"]
            .as_bool()
            .unwrap_or(install.upgrade_required);
        if status["needs_start"] == Value::Bool(true) && !upgrade_live {
            self.attempt_start(&install).await;
        }
        Some((revision, status))
    }

    async fn attempt_start(&self, install: &Install) {
        if let Ok(_one) = self.starting.try_lock() {
            let _changing = self.changing();
            let _ = self
                .runner
                .run(
                    command::simple("start", &install.target),
                    Some(timeouts::START),
                )
                .await;
        }
    }
}
