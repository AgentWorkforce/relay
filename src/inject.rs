use std::time::Duration;

use anyhow::Result;
use serde::Serialize;
use tokio::time::sleep;

use crate::{events::EventEmitter, types::InjectRequest};

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
    events: EventEmitter,
}

impl Injector {
    pub fn new(max_retries: u32, retry_delay_ms: u64, events: EventEmitter) -> Self {
        Self {
            max_retries,
            retry_delay: Duration::from_millis(retry_delay_ms),
            events,
        }
    }

    pub async fn deliver_with<F>(&self, req: InjectRequest, mut sink: F) -> InjectResult
    where
        F: FnMut(&InjectRequest) -> Result<()>,
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
                        id: req.id.clone(),
                        statuses,
                        attempts,
                        delivered: true,
                    };
                    self.events.emit("inject_result", &result);
                    return result;
                }
                Err(error) => {
                    if attempts > self.max_retries {
                        tracing::warn!(target = "relay_broker::inject", request_id = %req.id, error = %error, "injection failed after retries");
                        statuses.push(InjectStatus::Failed);
                        let result = InjectResult {
                            id: req.id.clone(),
                            statuses,
                            attempts,
                            delivered: false,
                        };
                        self.events.emit("inject_result", &result);
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

    use crate::{events::EventEmitter, types::RelayPriority};

    use super::{InjectStatus, Injector};

    #[tokio::test]
    async fn status_sequence_on_success() {
        let injector = Injector::new(2, 1, EventEmitter::new(false));
        let req = crate::types::InjectRequest {
            id: "1".into(),
            from: "alice".into(),
            target: "#general".into(),
            body: "hello".into(),
            priority: RelayPriority::P3,
            attempts: 0,
        };

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
        let injector = Injector::new(2, 1, EventEmitter::new(false));
        let req = crate::types::InjectRequest {
            id: "2".into(),
            from: "alice".into(),
            target: "#general".into(),
            body: "hello".into(),
            priority: RelayPriority::P3,
            attempts: 0,
        };
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
}
