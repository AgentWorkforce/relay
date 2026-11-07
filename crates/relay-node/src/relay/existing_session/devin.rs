//! Devin's official v3 session-message route, restricted to an exact org,
//! session and owner. It does not inject into an arbitrary local Devin CLI
//! TUI. The API has no documented idempotency field, so callers must use
//! `Journal` before POST and treat every uncertain POST as in doubt.
//! Contract: https://docs.devin.ai/v3-openapi.yaml

use super::{Adapter, Binding, Failure, Outcome, Provider, Request, Transport};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::sync::Arc;
use std::time::Duration;

pub trait HttpTransport: Send + Sync {
    /// `None` means no complete response. Neither URL nor headers nor body
    /// is surfaced as an error string.
    fn request(
        &self,
        method: &str,
        url: &str,
        bearer: &str,
        body: Option<&str>,
        timeout: Duration,
    ) -> Option<(u16, String)>;
}

pub struct SystemHttp;

impl HttpTransport for SystemHttp {
    fn request(
        &self,
        method: &str,
        url: &str,
        bearer: &str,
        body: Option<&str>,
        timeout: Duration,
    ) -> Option<(u16, String)> {
        let agent = ureq::AgentBuilder::new()
            .redirects(0)
            .try_proxy_from_env(false)
            .timeout(timeout)
            .timeout_connect(timeout)
            .timeout_read(timeout)
            .timeout_write(timeout)
            .build();
        let request = agent
            .request(method, url)
            .set("Authorization", &format!("Bearer {bearer}"))
            .set("Accept", "application/json");
        let result = match body {
            Some(body) => request
                .set("Content-Type", "application/json")
                .send_string(body),
            None => request.call(),
        };
        match result {
            Ok(response) => {
                let status = response.status();
                let mut text = String::new();
                response
                    .into_reader()
                    .take(1_000_001)
                    .read_to_string(&mut text)
                    .ok()?;
                (text.len() <= 1_000_000).then_some((status, text))
            }
            Err(ureq::Error::Status(status, _)) => Some((status, String::new())),
            Err(ureq::Error::Transport(_)) => None,
        }
    }
}

pub struct DevinAdapter {
    resolve_credential: Arc<dyn Fn(&str) -> Option<String> + Send + Sync>,
    transport: Arc<dyn HttpTransport>,
}

impl DevinAdapter {
    pub fn new(
        resolve_credential: Arc<dyn Fn(&str) -> Option<String> + Send + Sync>,
        transport: Arc<dyn HttpTransport>,
    ) -> Self {
        Self {
            resolve_credential,
            transport,
        }
    }

    fn valid_id(value: &str, prefix: &str) -> bool {
        value.strip_prefix(prefix).is_some_and(|body| {
            (8..=128).contains(&body.len())
                && body
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    }

    fn exact(response: &str, binding: &Binding) -> bool {
        let Ok(json) = serde_json::from_str::<Value>(response) else {
            return false;
        };
        json["session_id"].as_str() == Some(binding.session_id.as_str())
            && json["org_id"].as_str() == Some(binding.endpoint_id.as_str())
            && json["user_id"].as_str() == Some(binding.owner_id.as_str())
            && json["is_archived"].as_bool() == Some(false)
    }
}

impl Adapter for DevinAdapter {
    fn provider(&self) -> Provider {
        Provider::Devin
    }

    fn inject(&self, request: &Request<'_>, _command_id: &str) -> Outcome {
        let binding = request.binding;
        if binding.provider != Provider::Devin
            || binding.transport != Transport::OfficialApi
            || !Self::valid_id(&binding.endpoint_id, "org-")
            || !Self::valid_id(&binding.session_id, "devin-")
            || !binding.credential_reference.starts_with("keychain:")
        {
            return Outcome::Refused(Failure::IdentityMismatch);
        }
        let Some(token) = (self.resolve_credential)(&binding.credential_reference) else {
            return Outcome::Refused(Failure::AuthenticationUnavailable);
        };
        if token.is_empty()
            || token.len() > 4096
            || !token.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
        {
            return Outcome::Refused(Failure::AuthenticationUnavailable);
        }
        let url = format!(
            "https://api.devin.ai/v3/organizations/{}/sessions/{}",
            binding.endpoint_id, binding.session_id
        );
        let Some((status, found)) =
            self.transport
                .request("GET", &url, &token, None, request.timeout)
        else {
            return Outcome::Waiting(Failure::EndpointUnavailable);
        };
        if status != 200 {
            return if status == 429 || status >= 500 {
                Outcome::Waiting(Failure::EndpointUnavailable)
            } else {
                Outcome::Refused(Failure::ProviderRefused)
            };
        }
        if !Self::exact(&found, binding) {
            return Outcome::Refused(Failure::IdentityMismatch);
        }
        let body = serde_json::json!({"message": request.text}).to_string();
        let Some((status, accepted)) = self.transport.request(
            "POST",
            &format!("{url}/messages"),
            &token,
            Some(&body),
            request.timeout,
        ) else {
            return Outcome::InDoubt(Failure::TimedOut);
        };
        if status != 200 || !Self::exact(&accepted, binding) {
            return Outcome::InDoubt(Failure::PriorAttemptUncertain);
        }
        let digest =
            Sha256::digest(format!("{}:{}", binding.session_id, request.delivery_id).as_bytes());
        Outcome::Delivered {
            receipt_id: format!("devin-v3:{digest:x}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::existing_session::{Coordinator, Gate, Journal};
    use std::collections::VecDeque;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeHttp {
        replies: Mutex<VecDeque<Option<(u16, String)>>>,
        calls: Mutex<Vec<(String, String)>>,
    }

    impl HttpTransport for FakeHttp {
        fn request(
            &self,
            method: &str,
            url: &str,
            _: &str,
            _: Option<&str>,
            _: Duration,
        ) -> Option<(u16, String)> {
            self.calls.lock().unwrap().push((method.into(), url.into()));
            self.replies.lock().unwrap().pop_front().flatten()
        }
    }

    fn binding() -> Binding {
        Binding {
            provider: Provider::Devin,
            transport: Transport::OfficialApi,
            workspace_id: "rw_12345678".into(),
            session_id: "devin-12345678".into(),
            endpoint_id: "org-12345678".into(),
            owner_id: "user-1".into(),
            credential_reference: "keychain:devin-1".into(),
            owner_uid: 0,
            auth_id: String::new(),
            protocol_id: String::new(),
            cwd: std::path::PathBuf::new(),
            model_id: String::new(),
            agent_version: String::new(),
            executable: std::path::PathBuf::new(),
            leader_pid: 0,
            leader_start: 0,
            socket_path: std::path::PathBuf::new(),
            socket_device: 0,
            socket_inode: 0,
        }
    }

    #[test]
    fn exact_preflight_precedes_post_and_timeout_is_never_resent() {
        let directory = tempfile::tempdir().unwrap();
        let http = Arc::new(FakeHttp::default());
        let adapter = Arc::new(DevinAdapter::new(
            Arc::new(|_| Some("test-token".into())),
            http.clone(),
        ));
        let coordinator = Coordinator::new(
            Gate::enabled([Provider::Devin]),
            Journal::new(directory.path().join("journal")).unwrap(),
            vec![adapter],
        )
        .unwrap();
        let binding = binding();
        http.replies.lock().unwrap().push_back(Some((200,
            r#"{"session_id":"devin-other","org_id":"org-12345678","user_id":"user-1","is_archived":false}"#.into())));
        let wrong = Request {
            binding: &binding,
            delivery_id: "wrong",
            message_id: "message-1",
            text: "hello",
            timeout: Duration::from_secs(10),
        };
        assert_eq!(
            coordinator.inject(&wrong),
            Outcome::Refused(Failure::IdentityMismatch)
        );
        assert_eq!(http.calls.lock().unwrap().len(), 1);

        http.replies.lock().unwrap().extend([
            Some((200, r#"{"session_id":"devin-12345678","org_id":"org-12345678","user_id":"user-1","is_archived":false}"#.into())),
            None,
        ]);
        let uncertain = Request {
            delivery_id: "uncertain",
            ..wrong
        };
        assert_eq!(
            coordinator.inject(&uncertain),
            Outcome::InDoubt(Failure::TimedOut)
        );
        assert_eq!(
            coordinator.inject(&uncertain),
            Outcome::InDoubt(Failure::PriorAttemptUncertain)
        );
        let calls = http.calls.lock().unwrap();
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[2].0, "POST");
        assert_eq!(
            calls[2].1,
            "https://api.devin.ai/v3/organizations/org-12345678/sessions/devin-12345678/messages"
        );
    }
}
