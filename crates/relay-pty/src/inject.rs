use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use serde::Serialize;
use tokio::time::sleep;

/// Minimal view the injector needs of a deliverable request: a stable id
/// used for logging and result reporting. Callers keep their own request
/// types and expose the id through this trait.
pub trait RequestId {
    fn id(&self) -> &str;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InjectStatus {
    Queued,
    Injecting,
    Delivered,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct InjectResult {
    pub id: String,
    pub statuses: Vec<InjectStatus>,
    pub attempts: u32,
    pub delivered: bool,
}

#[derive(Clone)]
pub struct Injector {
    max_retries: u32,
    retry_delay: Duration,
    /// Invoked with the final [`InjectResult`] of every delivery, successful
    /// or failed; callers forward it into their own event stream.
    observer: Arc<dyn Fn(&InjectResult) + Send + Sync>,
}

impl Injector {
    pub fn new(
        max_retries: u32,
        retry_delay_ms: u64,
        observer: impl Fn(&InjectResult) + Send + Sync + 'static,
    ) -> Self {
        Self {
            max_retries,
            retry_delay: Duration::from_millis(retry_delay_ms),
            observer: Arc::new(observer),
        }
    }

    pub async fn deliver_with<R, F>(&self, req: R, mut sink: F) -> InjectResult
    where
        R: RequestId,
        F: FnMut(&R) -> Result<()>,
    {
        let mut statuses = vec![InjectStatus::Queued];
        let mut attempts = 0;

        loop {
            statuses.push(InjectStatus::Injecting);
            attempts += 1;

            match sink(&req) {
                Ok(_) => {
                    statuses.push(InjectStatus::Delivered);
                    let result = InjectResult {
                        id: req.id().to_string(),
                        statuses,
                        attempts,
                        delivered: true,
                    };
                    (self.observer)(&result);
                    return result;
                }
                Err(error) => {
                    if attempts > self.max_retries {
                        tracing::warn!(request_id = %req.id(), error = %error, "injection failed after retries");
                        statuses.push(InjectStatus::Failed);
                        let result = InjectResult {
                            id: req.id().to_string(),
                            statuses,
                            attempts,
                            delivered: false,
                        };
                        (self.observer)(&result);
                        return result;
                    }
                    sleep(self.retry_delay).await;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    use super::{InjectStatus, Injector, RequestId};

    struct Req {
        id: String,
    }

    impl RequestId for Req {
        fn id(&self) -> &str {
            &self.id
        }
    }

    #[tokio::test]
    async fn status_sequence_on_success() {
        let injector = Injector::new(2, 1, |_| {});
        let req = Req { id: "1".into() };

        let result = injector.deliver_with(req, |_| Ok(())).await;
        assert_eq!(
            result.statuses,
            vec![
                InjectStatus::Queued,
                InjectStatus::Injecting,
                InjectStatus::Delivered
            ]
        );
    }

    #[tokio::test]
    async fn retries_respect_config() {
        let injector = Injector::new(2, 1, |_| {});
        let req = Req { id: "2".into() };
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_clone = calls.clone();

        let result = injector
            .deliver_with(req, move |_| {
                let call = calls_clone.fetch_add(1, Ordering::SeqCst);
                if call < 2 {
                    anyhow::bail!("transient")
                }
                Ok(())
            })
            .await;

        assert!(result.delivered);
        assert_eq!(result.attempts, 3);
    }

    #[tokio::test]
    async fn observer_sees_final_result() {
        let seen = Arc::new(AtomicUsize::new(0));
        let seen_clone = seen.clone();
        let injector = Injector::new(0, 1, move |result| {
            assert_eq!(result.id, "3");
            seen_clone.fetch_add(1, Ordering::SeqCst);
        });
        let req = Req { id: "3".into() };

        let result = injector.deliver_with(req, |_| Ok(())).await;
        assert!(result.delivered);
        assert_eq!(seen.load(Ordering::SeqCst), 1);
    }
}
