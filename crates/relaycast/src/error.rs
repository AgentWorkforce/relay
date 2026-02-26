//! Error types for the RelayCast SDK.

use thiserror::Error;

/// Errors that can occur when using the RelayCast SDK.
#[derive(Error, Debug)]
pub enum RelayError {
    /// An error returned by the RelayCast API.
    #[error("API error ({code}): {message}")]
    Api {
        /// The error code from the API.
        code: String,
        /// The error message from the API.
        message: String,
        /// The HTTP status code.
        status: u16,
    },

    /// An HTTP request error.
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    /// A JSON serialization/deserialization error.
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    /// A URL parsing error.
    #[error("URL error: {0}")]
    Url(#[from] url::ParseError),

    /// A WebSocket error.
    #[error("WebSocket error: {0}")]
    WebSocket(Box<tokio_tungstenite::tungstenite::Error>),

    /// The response was invalid or malformed.
    #[error("Invalid response: {0}")]
    InvalidResponse(String),

    /// The WebSocket is not connected.
    #[error("WebSocket not connected. Call connect() first.")]
    NotConnected,
}

impl RelayError {
    /// Create a new API error.
    pub fn api(code: impl Into<String>, message: impl Into<String>, status: u16) -> Self {
        Self::Api {
            code: code.into(),
            message: message.into(),
            status,
        }
    }

    /// Check if this is a retryable error.
    pub fn is_retryable(&self) -> bool {
        match self {
            Self::Api { status, .. } => *status >= 500 && *status <= 599,
            Self::Http(e) => e.is_connect() || e.is_timeout(),
            _ => false,
        }
    }

    /// Check if this is a rate-limit error (HTTP 429).
    pub fn is_rate_limited(&self) -> bool {
        matches!(self, Self::Api { status: 429, .. })
    }

    /// Check if this is a not-found error (HTTP 404).
    pub fn is_not_found(&self) -> bool {
        matches!(self, Self::Api { status: 404, .. })
    }

    /// Check if this is an authentication/authorization rejection (HTTP 401 or 403).
    pub fn is_auth_rejection(&self) -> bool {
        matches!(
            self,
            Self::Api {
                status: 401 | 403,
                ..
            }
        )
    }

    /// Check if this is a conflict error (HTTP 409).
    pub fn is_conflict(&self) -> bool {
        matches!(self, Self::Api { status: 409, .. })
    }

    /// Get the HTTP status code, if this is an API error.
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Api { status, .. } => Some(*status),
            _ => None,
        }
    }

    /// Get the API error code, if this is an API error.
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Api { code, .. } => Some(code),
            _ => None,
        }
    }
}

impl From<tokio_tungstenite::tungstenite::Error> for RelayError {
    fn from(err: tokio_tungstenite::tungstenite::Error) -> Self {
        Self::WebSocket(Box::new(err))
    }
}

/// Result type alias for RelayCast operations.
pub type Result<T> = std::result::Result<T, RelayError>;
