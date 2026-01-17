//! Unix domain socket server for receiving injection requests.
//!
//! Provides a socket interface at `/tmp/relay-pty-{name}.sock` that accepts:
//! - JSON-framed injection requests
//! - Status queries
//! - Shutdown commands

use crate::protocol::{InjectRequest, InjectResponse, QueuedMessage};
use crate::queue::MessageQueue;
use anyhow::{Context, Result};
use std::path::Path;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

/// Socket server for injection requests
pub struct SocketServer {
    /// Path to the Unix socket
    socket_path: String,
    /// Message queue for injection
    queue: Arc<MessageQueue>,
    /// Channel for status queries
    status_tx: mpsc::Sender<StatusQuery>,
    /// Shutdown signal
    shutdown_tx: mpsc::Sender<()>,
}

/// Status query request
pub struct StatusQuery {
    pub response_tx: tokio::sync::oneshot::Sender<StatusInfo>,
}

/// Status information
#[derive(Debug, Clone)]
pub struct StatusInfo {
    pub agent_idle: bool,
    pub queue_length: usize,
    pub cursor_position: Option<[u16; 2]>,
    pub last_output_ms: u64,
}

impl SocketServer {
    /// Create a new socket server
    pub fn new(
        socket_path: String,
        queue: Arc<MessageQueue>,
        status_tx: mpsc::Sender<StatusQuery>,
        shutdown_tx: mpsc::Sender<()>,
    ) -> Self {
        Self {
            socket_path,
            queue,
            status_tx,
            shutdown_tx,
        }
    }

    /// Start the socket server
    pub async fn run(self) -> Result<()> {
        // Remove existing socket if present
        let path = Path::new(&self.socket_path);
        if path.exists() {
            std::fs::remove_file(path).context("Failed to remove existing socket")?;
        }

        // Create parent directory if needed
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .context(format!("Failed to create socket directory {:?}", parent))?;
        }

        // Bind the socket
        let listener = UnixListener::bind(&self.socket_path)
            .context(format!("Failed to bind socket at {}", self.socket_path))?;

        // Set socket permissions (0600 - owner only)
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = std::fs::Permissions::from_mode(0o600);
            if let Err(e) = std::fs::set_permissions(&self.socket_path, perms) {
                warn!("Failed to set socket permissions: {}", e);
            }
        }

        info!("Socket server listening at {}", self.socket_path);

        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let queue = Arc::clone(&self.queue);
                    let status_tx = self.status_tx.clone();
                    let shutdown_tx = self.shutdown_tx.clone();

                    tokio::spawn(async move {
                        if let Err(e) =
                            handle_connection(stream, queue, status_tx, shutdown_tx).await
                        {
                            error!("Connection error: {}", e);
                        }
                    });
                }
                Err(e) => {
                    error!("Accept error: {}", e);
                }
            }
        }
    }
}

/// Handle a single client connection
async fn handle_connection(
    stream: UnixStream,
    queue: Arc<MessageQueue>,
    status_tx: mpsc::Sender<StatusQuery>,
    shutdown_tx: mpsc::Sender<()>,
) -> Result<()> {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let mut line = String::new();

    debug!("New client connection");

    loop {
        line.clear();
        let bytes_read = reader.read_line(&mut line).await?;

        if bytes_read == 0 {
            debug!("Client disconnected");
            break;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Parse JSON request
        let response = match serde_json::from_str::<InjectRequest>(trimmed) {
            Ok(request) => handle_request(request, &queue, &status_tx, &shutdown_tx).await,
            Err(e) => InjectResponse::Error {
                message: format!("Invalid JSON: {}", e),
            },
        };

        // Send response
        let response_json = serde_json::to_string(&response)?;
        writer.write_all(response_json.as_bytes()).await?;
        writer.write_all(b"\n").await?;
        writer.flush().await?;

        // Check for shutdown
        if matches!(response, InjectResponse::ShutdownAck) {
            break;
        }
    }

    Ok(())
}

/// Handle a single request
async fn handle_request(
    request: InjectRequest,
    queue: &Arc<MessageQueue>,
    status_tx: &mpsc::Sender<StatusQuery>,
    shutdown_tx: &mpsc::Sender<()>,
) -> InjectResponse {
    match request {
        InjectRequest::Inject {
            id,
            from,
            body,
            priority,
        } => {
            debug!(
                "Inject request: {} from {} (priority {})",
                id, from, priority
            );

            let msg = QueuedMessage::new(id.clone(), from, body, priority);
            let queued = queue.enqueue(msg).await;

            if queued {
                InjectResponse::InjectResult {
                    id,
                    status: crate::protocol::InjectStatus::Queued,
                    timestamp: current_timestamp_ms(),
                    error: None,
                }
            } else {
                InjectResponse::InjectResult {
                    id,
                    status: crate::protocol::InjectStatus::Failed,
                    timestamp: current_timestamp_ms(),
                    error: Some("Message rejected (duplicate or backpressure)".to_string()),
                }
            }
        }

        InjectRequest::Status => {
            let (tx, rx) = tokio::sync::oneshot::channel();

            if status_tx
                .send(StatusQuery { response_tx: tx })
                .await
                .is_ok()
            {
                match rx.await {
                    Ok(info) => InjectResponse::Status {
                        agent_idle: info.agent_idle,
                        queue_length: info.queue_length,
                        cursor_position: info.cursor_position,
                        last_output_ms: info.last_output_ms,
                    },
                    Err(_) => InjectResponse::Error {
                        message: "Failed to get status".to_string(),
                    },
                }
            } else {
                InjectResponse::Error {
                    message: "Status channel closed".to_string(),
                }
            }
        }

        InjectRequest::Shutdown => {
            info!("Shutdown requested via socket");
            let _ = shutdown_tx.send(()).await;
            InjectResponse::ShutdownAck
        }
    }
}

/// Get current timestamp in milliseconds
fn current_timestamp_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Client for connecting to the socket (for testing and integration)
pub struct SocketClient {
    socket_path: String,
}

impl SocketClient {
    pub fn new(socket_path: String) -> Self {
        Self { socket_path }
    }

    /// Send an injection request
    pub async fn inject(
        &self,
        id: String,
        from: String,
        body: String,
        priority: i32,
    ) -> Result<InjectResponse> {
        self.send_request(InjectRequest::Inject {
            id,
            from,
            body,
            priority,
        })
        .await
    }

    /// Query status
    pub async fn status(&self) -> Result<InjectResponse> {
        self.send_request(InjectRequest::Status).await
    }

    /// Request shutdown
    pub async fn shutdown(&self) -> Result<InjectResponse> {
        self.send_request(InjectRequest::Shutdown).await
    }

    async fn send_request(&self, request: InjectRequest) -> Result<InjectResponse> {
        let stream = UnixStream::connect(&self.socket_path)
            .await
            .context("Failed to connect to socket")?;

        let (reader, mut writer) = stream.into_split();
        let mut reader = BufReader::new(reader);

        // Send request
        let request_json = serde_json::to_string(&request)?;
        writer.write_all(request_json.as_bytes()).await?;
        writer.write_all(b"\n").await?;
        writer.flush().await?;

        // Read response
        let mut line = String::new();
        reader.read_line(&mut line).await?;

        let response: InjectResponse = serde_json::from_str(line.trim())?;
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn test_socket_server_client() {
        let dir = tempdir().unwrap();
        let socket_path = dir.path().join("test.sock").to_string_lossy().to_string();

        let (response_tx, _response_rx) = mpsc::channel(16);
        let (status_tx, _status_rx) = mpsc::channel(16);
        let (shutdown_tx, _shutdown_rx) = mpsc::channel(1);

        let queue = Arc::new(MessageQueue::new(10, response_tx));

        let server = SocketServer::new(
            socket_path.clone(),
            Arc::clone(&queue),
            status_tx,
            shutdown_tx,
        );

        // Start server in background
        let server_handle = tokio::spawn(async move {
            server.run().await.ok();
        });

        // Wait for server to start
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

        // Connect client
        let client = SocketClient::new(socket_path);

        // Send injection request
        let response = client
            .inject(
                "test-123".to_string(),
                "Alice".to_string(),
                "Hello!".to_string(),
                0,
            )
            .await
            .unwrap();

        assert!(matches!(response, InjectResponse::InjectResult { .. }));

        // Cleanup
        server_handle.abort();
    }
}
