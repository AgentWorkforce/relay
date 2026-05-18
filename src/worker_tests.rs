//! Tests for worker.rs module.
//!
//! worker.rs public API:
//!   - WorkerRegistry::new(event_tx, worker_env, logs_dir, broker_start) -> Self
//!   - WorkerRegistry::has_worker(name) -> bool
//!   - WorkerRegistry::has_any_worker() -> bool
//!   - WorkerRegistry::list() -> Vec<Value>
//!   - WorkerRegistry::env_value(key) -> Option<&str>
//!   - WorkerRegistry::worker_log_path(name) -> Option<PathBuf>
//!   - WorkerRegistry::routing_workers() -> Vec<RoutingWorker>

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::Instant;

    use tokio::sync::mpsc;

    use crate::worker::{WorkerEvent, WorkerRegistry};

    fn make_registry(env: Vec<(String, String)>) -> WorkerRegistry {
        let (tx, _rx) = mpsc::channel::<WorkerEvent>(16);
        WorkerRegistry::new(tx, env, PathBuf::from("/tmp/worker-tests"), Instant::now())
    }

    #[test]
    fn worker_registry_starts_empty() {
        let reg = make_registry(vec![]);
        assert!(!reg.has_any_worker());
        assert!(reg.list().is_empty());
    }

    #[test]
    fn has_worker_returns_false_for_unknown() {
        let reg = make_registry(vec![]);
        assert!(!reg.has_worker("nonexistent"));
    }

    #[test]
    fn worker_log_path_rejects_path_traversal() {
        let reg = make_registry(vec![]);
        // ".." as a name component must be rejected
        assert!(reg.worker_log_path("..").is_none());
        assert!(reg.worker_log_path("../etc/passwd").is_none());
        assert!(reg.worker_log_path("foo/../bar").is_none());
        assert!(reg.worker_log_path("foo/bar").is_none());
        assert!(reg.worker_log_path("foo\\bar").is_none());
        // Valid names are allowed
        assert!(reg.worker_log_path("valid-name").is_some());
        assert!(reg.worker_log_path("worker.1").is_some());
    }

    #[test]
    fn env_value_lookup() {
        let env = vec![("KEY".into(), "val".into())];
        let reg = make_registry(env);
        assert_eq!(reg.env_value("KEY"), Some("val"));
        assert_eq!(reg.env_value("MISSING"), None);
    }

    #[test]
    fn routing_workers_empty_when_no_workers() {
        let reg = make_registry(vec![]);
        assert!(reg.routing_workers().is_empty());
    }
}
