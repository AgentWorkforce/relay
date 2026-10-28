//! Observes the SDK boundary without changing its authentication or retry policy.
use relaycast::{ClientOptions, RequestOptions};
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
            inner: relaycast::HttpClient::new(options)?,
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
            self.inner.get(path, query, options),
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
            self.inner.post(path, body, options),
        )
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
            self.inner.delete(path, options),
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
