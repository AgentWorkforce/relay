//! HTTP client for the RelayCast API.

use reqwest::{Client, Method, RequestBuilder};
use serde::{de::DeserializeOwned, Serialize};
use std::time::Duration;

use crate::error::{RelayError, Result};
use crate::types::ApiResponse;

const SDK_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_BASE_URL: &str = "https://api.relaycast.dev";
const DEFAULT_ORIGIN_SURFACE: &str = "sdk";
const DEFAULT_ORIGIN_CLIENT: &str = "@relaycast/sdk-rust";
const RETRY_BACKOFFS_MS: [u64; 3] = [200, 400, 800];

/// Options for creating an HTTP client.
#[derive(Debug, Clone)]
pub struct ClientOptions {
    /// The API key for authentication.
    pub api_key: String,
    /// The base URL for the API (defaults to https://api.relaycast.dev).
    pub base_url: Option<String>,
    /// SDK origin surface metadata.
    pub origin_surface: Option<String>,
    /// SDK origin client metadata.
    pub origin_client: Option<String>,
    /// SDK origin version metadata.
    pub origin_version: Option<String>,
}

impl ClientOptions {
    /// Create new client options with the given API key.
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            base_url: None,
            origin_surface: None,
            origin_client: None,
            origin_version: None,
        }
    }

    /// Set a custom base URL.
    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = Some(base_url.into());
        self
    }

    /// Set origin metadata headers.
    pub fn with_origin(
        mut self,
        origin_surface: impl Into<String>,
        origin_client: impl Into<String>,
        origin_version: impl Into<String>,
    ) -> Self {
        self.origin_surface = Some(origin_surface.into());
        self.origin_client = Some(origin_client.into());
        self.origin_version = Some(origin_version.into());
        self
    }
}

/// Options for individual requests.
#[derive(Debug, Clone, Default)]
pub struct RequestOptions {
    /// Additional headers to include.
    pub headers: Option<Vec<(String, String)>>,
    /// Idempotency key for the request.
    pub idempotency_key: Option<String>,
}

impl RequestOptions {
    /// Create request options with an idempotency key.
    pub fn with_idempotency_key(key: impl Into<String>) -> Self {
        Self {
            idempotency_key: Some(key.into()),
            ..Default::default()
        }
    }
}

/// HTTP client for making requests to the RelayCast API.
#[derive(Debug, Clone)]
pub struct HttpClient {
    client: Client,
    api_key: String,
    base_url: String,
    origin_surface: String,
    origin_client: String,
    origin_version: String,
}

impl HttpClient {
    /// Create a new HTTP client with the given options.
    pub fn new(options: ClientOptions) -> Result<Self> {
        let client = Client::builder().timeout(Duration::from_secs(30)).build()?;

        Ok(Self {
            client,
            api_key: options.api_key,
            base_url: options
                .base_url
                .unwrap_or_else(|| DEFAULT_BASE_URL.to_string()),
            origin_surface: options
                .origin_surface
                .unwrap_or_else(|| DEFAULT_ORIGIN_SURFACE.to_string()),
            origin_client: options
                .origin_client
                .unwrap_or_else(|| DEFAULT_ORIGIN_CLIENT.to_string()),
            origin_version: options
                .origin_version
                .unwrap_or_else(|| SDK_VERSION.to_string()),
        })
    }

    /// Get the API key.
    pub fn api_key(&self) -> &str {
        &self.api_key
    }

    /// Get the base URL.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Get the origin surface metadata value.
    pub fn origin_surface(&self) -> &str {
        &self.origin_surface
    }

    /// Get the origin client metadata value.
    pub fn origin_client(&self) -> &str {
        &self.origin_client
    }

    /// Get the origin version metadata value.
    pub fn origin_version(&self) -> &str {
        &self.origin_version
    }

    /// Return a cloned client with a different API key while preserving base URL and origin metadata.
    pub fn with_api_key(&self, api_key: impl Into<String>) -> Result<Self> {
        HttpClient::new(
            ClientOptions::new(api_key)
                .with_base_url(self.base_url.clone())
                .with_origin(
                    self.origin_surface.clone(),
                    self.origin_client.clone(),
                    self.origin_version.clone(),
                ),
        )
    }

    /// Make a request to the API.
    pub async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<impl Serialize>,
        query: Option<&[(&str, &str)]>,
        options: Option<RequestOptions>,
    ) -> Result<T> {
        let url = format!("{}{}", self.base_url, path);
        let options = options.unwrap_or_default();

        for (attempt, backoff) in RETRY_BACKOFFS_MS.iter().enumerate() {
            let mut request = self.build_request(method.clone(), &url, &options);

            if let Some(ref q) = query {
                request = request.query(q);
            }

            if let Some(ref b) = body {
                request = request.json(b);
            }

            let response = request.send().await?;
            let status = response.status().as_u16();

            // Retry on 5xx errors
            if (500..=599).contains(&status) && attempt < RETRY_BACKOFFS_MS.len() {
                tokio::time::sleep(Duration::from_millis(*backoff)).await;
                continue;
            }

            // Handle 204 No Content
            if status == 204 {
                // Return default value for T (works for () and Option<T>)
                let empty_json = serde_json::from_str("null")?;
                return Ok(empty_json);
            }

            let json: ApiResponse<T> = response.json().await?;

            if !json.ok {
                let error = json.error.unwrap_or_else(|| crate::types::ApiErrorInfo {
                    code: "unknown_error".to_string(),
                    message: "Unknown error".to_string(),
                });
                return Err(RelayError::api(error.code, error.message, status));
            }

            return json.data.ok_or_else(|| {
                RelayError::InvalidResponse("Response missing data field".to_string())
            });
        }

        // This shouldn't be reached, but just in case
        Err(RelayError::InvalidResponse(
            "Max retries exceeded".to_string(),
        ))
    }

    fn build_request(&self, method: Method, url: &str, options: &RequestOptions) -> RequestBuilder {
        let mut request = self
            .client
            .request(method, url)
            .bearer_auth(&self.api_key)
            .header("X-SDK-Version", SDK_VERSION)
            .header("X-Relaycast-Origin-Surface", &self.origin_surface)
            .header("X-Relaycast-Origin-Client", &self.origin_client)
            .header("X-Relaycast-Origin-Version", &self.origin_version);

        if let Some(ref key) = options.idempotency_key {
            request = request.header("Idempotency-Key", key);
        }

        if let Some(ref headers) = options.headers {
            for (name, value) in headers {
                request = request.header(name.as_str(), value.as_str());
            }
        }

        request
    }

    /// Make a GET request.
    pub async fn get<T: DeserializeOwned>(
        &self,
        path: &str,
        query: Option<&[(&str, &str)]>,
        options: Option<RequestOptions>,
    ) -> Result<T> {
        self.request::<T>(Method::GET, path, None::<()>, query, options)
            .await
    }

    /// Make a POST request.
    pub async fn post<T: DeserializeOwned>(
        &self,
        path: &str,
        body: Option<impl Serialize>,
        options: Option<RequestOptions>,
    ) -> Result<T> {
        self.request(Method::POST, path, body, None, options).await
    }

    /// Make a PATCH request.
    pub async fn patch<T: DeserializeOwned>(
        &self,
        path: &str,
        body: Option<impl Serialize>,
        options: Option<RequestOptions>,
    ) -> Result<T> {
        self.request(Method::PATCH, path, body, None, options).await
    }

    /// Make a PUT request.
    pub async fn put<T: DeserializeOwned>(
        &self,
        path: &str,
        body: Option<impl Serialize>,
        options: Option<RequestOptions>,
    ) -> Result<T> {
        self.request(Method::PUT, path, body, None, options).await
    }

    /// Make a DELETE request.
    pub async fn delete(&self, path: &str, options: Option<RequestOptions>) -> Result<()> {
        self.request::<()>(Method::DELETE, path, None::<()>, None, options)
            .await
    }
}
