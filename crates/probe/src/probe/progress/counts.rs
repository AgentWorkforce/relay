//! Cached catalog counts shared by content-free progress monitors.
use super::*;

/// How long a count of captured sessions is reused. Counting walks the whole
/// catalog, and the count changes only while a capture runs, so a report
/// every few seconds reuses it, and the end of a capture pass counts afresh.
const CAPTURED_SESSIONS_REFRESH: Duration = Duration::from_secs(30);

/// The last count of captured sessions in each store, shared by every
/// monitor in the process: each delivery pass starts its own.
pub(super) fn captured_sessions(db: &Path, fresh: bool) -> i64 {
    static COUNTS: OnceLock<Mutex<HashMap<PathBuf, (Instant, i64)>>> = OnceLock::new();
    let counts = COUNTS.get_or_init(Default::default);
    if !fresh {
        let counts = counts.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, count)) = counts.get(db) {
            if at.elapsed() < CAPTURED_SESSIONS_REFRESH {
                return *count;
            }
        }
    }
    let Ok(count) = crate::history::captured_sessions(db) else {
        return 0;
    };
    counts
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(db.to_owned(), (Instant::now(), count));
    count
}
