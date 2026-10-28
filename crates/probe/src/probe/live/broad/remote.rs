use super::*;

/// Remote acquisition has its own cadence/transport. A large local archive
/// cannot delay it; it still uses the existing source-intake and consent path.
pub(in crate::live) fn remote(
    store: ai_hist::SessionStore,
    cancelled: Arc<AtomicBool>,
    shared: Arc<Shared>,
    interval: Duration,
) -> super::Remote {
    Remote(Some(std::thread::spawn(move || {
        super::super::super::priority::background("remote-capture");
        while !stopping(&cancelled) {
            let started = Instant::now();
            let before = store.head_revision().ok();
            let result = super::super::super::remote_sources::sweep(store.db_path(), &store, || {
                stopping(&cancelled)
            });
            super::super::super::remote_sources::report_sweep(store.db_path(), started, &result);
            if result.is_ok() && store.head_revision().ok() != before {
                shared.signal();
            }
            let due =
                Instant::now() + interval.max(started.elapsed().saturating_mul(SWEEP_DUTY_FACTOR));
            while !stopping(&cancelled) && Instant::now() < due {
                std::thread::sleep(STOP_POLL);
            }
        }
    })))
}
pub(in crate::live) struct Remote(Option<JoinHandle<()>>);
impl Drop for Remote {
    fn drop(&mut self) {
        if let Some(thread) = self.0.take() {
            let _ = thread.join();
        }
    }
}

