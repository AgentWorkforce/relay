//! Observes the SDK boundary without changing its authentication or retry policy.
use relaycast::ClientOptions;
// Keep options on the same SDK version as this transport. An embedding app
// may also use a registry SDK, whose RequestOptions is a different Rust type.
pub use relaycast::RequestOptions;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

#[derive(Clone, Debug)]
pub struct HttpClient {
    inner: relaycast::HttpClient,
    credential: super::workspace::Secret,
}
impl HttpClient {
    pub fn new(options: ClientOptions) -> relaycast::Result<Self> {
        let credential = super::workspace::Secret::new(options.api_key.clone());
        Ok(Self {
            inner: super::sdk_http::client(options)?,
            credential,
        })
    }
    pub async fn get<T: DeserializeOwned + Serialize>(
        &self,
        path: &str,
        query: Option<&[(&str, &str)]>,
        options: Option<RequestOptions>,
    ) -> relaycast::Result<T> {
        super::request_log::observe(
            "GET",
            &format!("{}{}", self.inner.base_url(), path),
            serde_json::to_value(query).unwrap_or(Value::Null),
            self.credential.expose(),
            async {
                super::sdk_http::environment_is_safe()?;
                self.inner
                    .get(path, query, options)
                    .await
                    .map_err(|error| self.broker_error(error))
            },
        )
        .await
    }
    pub async fn post<T: DeserializeOwned + Serialize>(
        &self,
        path: &str,
        body: Option<impl Serialize>,
        options: Option<RequestOptions>,
    ) -> relaycast::Result<T> {
        super::request_log::observe(
            "POST",
            &format!("{}{}", self.inner.base_url(), path),
            serde_json::to_value(&body).unwrap_or(Value::Null),
            self.credential.expose(),
            async {
                super::sdk_http::environment_is_safe()?;
                self.inner
                    .post(path, body, options)
                    .await
                    .map_err(|error| self.broker_error(error))
            },
        )
        .await
    }
    /// `error` as read from a Control broker ([`super::node_credential::broker_error`])
    /// when this client carries a node-scoped credential; as it is otherwise.
    fn broker_error(&self, error: relaycast::RelayError) -> relaycast::RelayError {
        if self.node_scoped() {
            super::node_credential::broker_error(error)
        } else {
            error
        }
    }
    /// Whether this client carries a node-scoped credential (`sh_wk_…`),
    /// so it reaches a Control broker.
    pub fn node_scoped(&self) -> bool {
        super::workspace::is_node_key(self.credential.expose())
    }
    /// `GET path` at a Control broker, its answer read by
    /// [`super::node_credential::broker_data`] rather than the SDK, which
    /// cannot read the bare bodies of broker images older than relay-control
    /// 01614898. One attempt, no retry. It goes once every deployed broker
    /// image carries 01614898.
    pub async fn get_broker(&self, path: &str) -> relaycast::Result<Value> {
        let url = format!("{}{}", self.inner.base_url(), path);
        super::request_log::observe("GET", &url, Value::Null, self.credential.expose(), async {
            let options =
                ClientOptions::new(self.inner.api_key()).with_base_url(self.inner.base_url());
            let transport = super::sdk_http::guarded_transport(&options)?;
            let response = transport
                .get(&url)
                .bearer_auth(self.inner.api_key())
                .header("X-Relaycast-Origin-Client", self.inner.origin_client())
                .header("X-Relaycast-Origin-Version", self.inner.origin_version())
                .send()
                .await?;
            let status = response.status().as_u16();
            let header = |name: &str| {
                response
                    .headers()
                    .get(name)
                    .and_then(|value| value.to_str().ok())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            };
            let request_id = header("x-request-id").or_else(|| header("x-correlation-id"));
            let retry_after_ms = header("retry-after")
                .and_then(|value| value.parse::<u64>().ok())
                .map(|seconds| seconds.saturating_mul(1_000));
            let body = response.bytes().await?;
            super::node_credential::broker_data(status, &body, request_id, retry_after_ms)
        })
        .await
    }
    pub async fn delete(
        &self,
        path: &str,
        options: Option<RequestOptions>,
    ) -> relaycast::Result<()> {
        super::request_log::observe(
            "DELETE",
            &format!("{}{}", self.inner.base_url(), path),
            Value::Null,
            self.credential.expose(),
            async {
                super::sdk_http::environment_is_safe()?;
                self.inner
                    .delete(path, options)
                    .await
                    .map_err(|error| self.broker_error(error))
            },
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[tokio::test]
    async fn actual_relaycast_failure_keeps_status_response_and_retry_correlation() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            for _ in 0..3 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0; 4096];
                let count = stream.read(&mut request).unwrap();
                assert!(String::from_utf8_lossy(&request[..count]).contains("GET /v1/workspace"));
                let body = r#"{"ok":false,"error":{"code":"workspace_unavailable","message":"Workspace temporarily unavailable"}}"#;
                write!(stream, "HTTP/1.1 503 Service Unavailable\r\nx-request-id: failed-request-42\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            }
        });
        let client =
            HttpClient::new(ClientOptions::new("test-secret").with_base_url(&base)).unwrap();
        let result = client.get::<Value>("/v1/workspace", None, None).await;
        assert_eq!(result.unwrap_err().status(), Some(503));
        server.join().unwrap();
        let entry = super::super::request_log::snapshot()
            .entries
            .into_iter()
            .find(|entry| entry.endpoint == format!("{base}/v1/workspace"))
            .unwrap();
        assert_eq!(entry.status, Some(503));
        assert!(entry.failed);
        assert!(entry.duration_ms.is_some());
        let response: Value = serde_json::from_str(&entry.response).unwrap();
        assert_eq!(response["attempts"], json!(3));
        assert_eq!(response["request_id"], "failed-request-42");
        assert_eq!(response["error_code"], "workspace_unavailable");
        assert!(response["message"]
            .as_str()
            .unwrap()
            .contains("temporarily unavailable"));
        assert!(!entry.request.contains("test-secret"));
    }
}
