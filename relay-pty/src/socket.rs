//! Unix domain socket server for receiving injection requests.
//!
//! Provides a socket interface at `/tmp/relay-pty-{name}.sock` or
//! `/tmp/relay/{WORKSPACE_ID}/sockets/{name}.sock` that accepts:
//! - JSON-framed injection requests
//! - Status queries
//! - Shutdown commands
//!
//! For injection requests, the connection stays open and streams all status
//! updates (Queued → Injecting → Delivered/Failed) back to the client.

use crate::protocol::{InjectRequest, InjectResponse, InjectStatus, QueuedMessage};
use crate::queue::MessageQueue;
use anyhow::{Context, Result};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{broadcast, mpsc};
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
    /// Direct PTY write channel (for SendEnter)
    pty_tx: mpsc::Sender<Vec<u8>>,
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
        pty_tx: mpsc::Sender<Vec<u8>>,
    ) -> Self {
        Self {
            socket_path,
            queue,
            status_tx,
            shutdown_tx,
            pty_tx,
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
                    let pty_tx = self.pty_tx.clone();

                    tokio::spawn(async move {
                        if let Err(e) =
                            handle_connection(stream, queue, status_tx, shutdown_tx, pty_tx).await
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
///
/// For injection requests, this connection will stay open and stream all
/// status updates until the final status (Delivered/Failed) is received.
async fn handle_connection(
    stream: UnixStream,
    queue: Arc<MessageQueue>,
    status_tx: mpsc::Sender<StatusQuery>,
    shutdown_tx: mpsc::Sender<()>,
    pty_tx: mpsc::Sender<Vec<u8>>,
) -> Result<()> {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let mut line = String::new();

    // Subscribe to response notifications
    let mut response_rx = queue.subscribe_responses();

    // Track message IDs we're waiting for final responses on
    let mut pending_ids: HashSet<String> = HashSet::new();

    debug!("New client connection");

    loop {
        tokio::select! {
            // Handle incoming requests from client
            result = reader.read_line(&mut line) => {
                let bytes_read = result?;

                if bytes_read == 0 {
                    debug!("Client disconnected");
                    break;
                }

                let trimmed = line.trim();
                if trimmed.is_empty() {
                    line.clear();
                    continue;
                }

                // Parse JSON request
                match serde_json::from_str::<InjectRequest>(trimmed) {
                    Ok(request) => {
                        // For inject requests, track the ID BEFORE calling handle_request
                        // This prevents a race where the "Queued" broadcast arrives before
                        // we've added the ID to pending_ids
                        let inject_id = if let InjectRequest::Inject { ref id, .. } = request {
                            debug!("Pre-tracking message {} for response streaming", id);
                            pending_ids.insert(id.clone());
                            Some(id.clone())
                        } else {
                            None
                        };

                        let response = handle_request(request, &queue, &status_tx, &shutdown_tx, &pty_tx).await;

                        // Send the initial response to the client
                        // For inject requests, this is the "Queued" status
                        // Subsequent status updates (Injecting, Delivered, Failed) come via broadcast
                        match (&response, &inject_id) {
                            (InjectResponse::InjectResult { .. }, Some(_)) => {
                                // Send the Queued response immediately
                                let response_json = serde_json::to_string(&response)?;
                                writer.write_all(response_json.as_bytes()).await?;
                                writer.write_all(b"\n").await?;
                                writer.flush().await?;
                            }
                            (InjectResponse::Error { .. }, Some(id)) => {
                                // Inject request failed - remove tracking and send error
                                debug!("Inject request {} failed, removing tracking", id);
                                pending_ids.remove(id);
                                let response_json = serde_json::to_string(&response)?;
                                writer.write_all(response_json.as_bytes()).await?;
                                writer.write_all(b"\n").await?;
                                writer.flush().await?;
                            }
                            _ => {
                                // Non-inject request - send response immediately
                                let response_json = serde_json::to_string(&response)?;
                                writer.write_all(response_json.as_bytes()).await?;
                                writer.write_all(b"\n").await?;
                                writer.flush().await?;
                            }
                        }

                        // Check for shutdown
                        if matches!(response, InjectResponse::ShutdownAck) {
                            return Ok(());
                        }
                    }
                    Err(e) => {
                        let response = InjectResponse::Error {
                            message: format!("Invalid JSON: {}", e),
                        };
                        let response_json = serde_json::to_string(&response)?;
                        writer.write_all(response_json.as_bytes()).await?;
                        writer.write_all(b"\n").await?;
                        writer.flush().await?;
                    }
                }

                line.clear();
            }

            // Handle response notifications from the queue
            result = response_rx.recv() => {
                match result {
                    Ok(response) => {
                        // Only forward responses for message IDs we're tracking
                        if let InjectResponse::InjectResult { ref id, ref status, .. } = response {
                            if pending_ids.contains(id) {
                                // Skip "Queued" status via broadcast - it's already sent directly
                                // in the request handler. Only forward Injecting/Delivered/Failed.
                                if matches!(status, InjectStatus::Queued) {
                                    debug!("Skipping duplicate Queued broadcast for {}", id);
                                    continue;
                                }

                                debug!("Forwarding response for message {}: {:?}", id, status);

                                let response_json = serde_json::to_string(&response)?;
                                writer.write_all(response_json.as_bytes()).await?;
                                writer.write_all(b"\n").await?;
                                writer.flush().await?;

                                // Remove from pending if this is a final status
                                if matches!(status, InjectStatus::Delivered | InjectStatus::Failed) {
                                    debug!("Message {} reached final state: {:?}", id, status);
                                    pending_ids.remove(id);

                                    // Clear from seen_ids immediately on delivery to free memory
                                    // This is critical for long-running sessions with 200+ agents
                                    if matches!(status, InjectStatus::Delivered) {
                                        queue.mark_delivered(id).await;
                                    }
                                    // Keep connection open for subsequent messages
                                    // Node.js orchestrator maintains a persistent socket
                                }
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        warn!("Response receiver lagged by {} messages - some status updates may be lost", n);
                        // When lagged, we've lost status updates. Messages in pending_ids may never
                        // get their final status. Log the affected IDs for debugging.
                        if !pending_ids.is_empty() {
                            warn!("Pending IDs that may have lost updates: {:?}", pending_ids);
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        debug!("Response channel closed");
                        break;
                    }
                }
            }
        }
    }

    Ok(())
}

/// Handle a single request
///
/// For inject requests, returns None on success (queue broadcasts the response),
/// or an Error response if the message was rejected.
async fn handle_request(
    request: InjectRequest,
    queue: &Arc<MessageQueue>,
    status_tx: &mpsc::Sender<StatusQuery>,
    shutdown_tx: &mpsc::Sender<()>,
    pty_tx: &mpsc::Sender<Vec<u8>>,
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
                // Success - the queue will broadcast the Queued status,
                // and later Injecting/Delivered/Failed statuses.
                // Return a placeholder that won't be sent (handled in handle_connection)
                InjectResponse::InjectResult {
                    id,
                    status: InjectStatus::Queued,
                    timestamp: current_timestamp_ms(),
                    error: None,
                }
            } else {
                // Rejection - must tell the client directly since broadcast won't have this
                InjectResponse::Error {
                    message: format!("Message {} rejected (duplicate or backpressure)", id),
                }
            }
        }

        InjectRequest::SendEnter { id } => {
            info!("SendEnter request for message {}", id);

            // Send just the Enter key (\r) to the PTY
            let success = pty_tx.send(vec![0x0d]).await.is_ok();

            if success {
                info!("Enter key sent successfully for {}", id);
            } else {
                warn!("Failed to send Enter key for {} - PTY channel closed", id);
            }

            InjectResponse::SendEnterResult {
                id,
                success,
                timestamp: current_timestamp_ms(),
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
    use crate::protocol::InjectStatus;
    use tempfile::tempdir;
    use tokio::sync::broadcast;

    #[tokio::test]
    async fn test_socket_server_client() {
        let dir = tempdir().unwrap();
        let socket_path = dir.path().join("test.sock").to_string_lossy().to_string();

        let (response_tx, _response_rx) = broadcast::channel(16);
        let (status_tx, _status_rx) = mpsc::channel(16);
        let (shutdown_tx, _shutdown_rx) = mpsc::channel(1);
        let (pty_tx, _pty_rx) = mpsc::channel::<Vec<u8>>(16);

        let queue = Arc::new(MessageQueue::new(10, response_tx));

        let server = SocketServer::new(
            socket_path.clone(),
            Arc::clone(&queue),
            status_tx,
            shutdown_tx,
            pty_tx,
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

    #[tokio::test]
    async fn test_handle_request_status_channel_closed() {
        let (response_tx, _response_rx) = broadcast::channel(1);
        let (status_tx, status_rx) = mpsc::channel(1);
        drop(status_rx);
        let (shutdown_tx, _shutdown_rx) = mpsc::channel(1);
        let (pty_tx, _pty_rx) = mpsc::channel(1);

        let queue = Arc::new(MessageQueue::new(1, response_tx));

        let response = handle_request(
            InjectRequest::Status,
            &queue,
            &status_tx,
            &shutdown_tx,
            &pty_tx,
        )
        .await;

        match response {
            InjectResponse::Error { message } => {
                assert!(message.contains("Status channel closed"));
            }
            _ => panic!("Expected error response"),
        }
    }

    #[tokio::test]
    async fn test_handle_request_shutdown() {
        let (response_tx, _response_rx) = broadcast::channel(1);
        let (status_tx, _status_rx) = mpsc::channel(1);
        let (shutdown_tx, mut shutdown_rx) = mpsc::channel(1);
        let (pty_tx, _pty_rx) = mpsc::channel(1);

        let queue = Arc::new(MessageQueue::new(1, response_tx));

        let response = handle_request(
            InjectRequest::Shutdown,
            &queue,
            &status_tx,
            &shutdown_tx,
            &pty_tx,
        )
        .await;
        assert!(matches!(response, InjectResponse::ShutdownAck));

        let received =
            tokio::time::timeout(tokio::time::Duration::from_millis(200), shutdown_rx.recv())
                .await
                .ok()
                .flatten();
        assert!(received.is_some());
    }

    #[tokio::test]
    async fn test_handle_request_duplicate_inject() {
        let (response_tx, _response_rx) = broadcast::channel(4);
        let (status_tx, _status_rx) = mpsc::channel(1);
        let (shutdown_tx, _shutdown_rx) = mpsc::channel(1);
        let (pty_tx, _pty_rx) = mpsc::channel(1);

        let queue = Arc::new(MessageQueue::new(1, response_tx));

        let first = handle_request(
            InjectRequest::Inject {
                id: "msg-1".to_string(),
                from: "Alice".to_string(),
                body: "Hello".to_string(),
                priority: 0,
            },
            &queue,
            &status_tx,
            &shutdown_tx,
            &pty_tx,
        )
        .await;

        assert!(matches!(
            first,
            InjectResponse::InjectResult {
                status: InjectStatus::Queued,
                ..
            }
        ));

        let second = handle_request(
            InjectRequest::Inject {
                id: "msg-1".to_string(),
                from: "Alice".to_string(),
                body: "Hello again".to_string(),
                priority: 0,
            },
            &queue,
            &status_tx,
            &shutdown_tx,
            &pty_tx,
        )
        .await;

        match second {
            InjectResponse::InjectResult { status, error, .. } => {
                assert_ne!(status, InjectStatus::Queued);
                if status == InjectStatus::Failed {
                    assert!(error.unwrap_or_default().contains("Message rejected"));
                }
            }
            InjectResponse::Backpressure { .. } => {}
            InjectResponse::Error { message } => {
                assert!(!message.is_empty());
            }
            other => panic!("Unexpected response: {:?}", other),
        }
    }

    #[tokio::test]
    async fn test_handle_connection_invalid_json() {
        let (response_tx, _response_rx) = broadcast::channel(1);
        let (status_tx, _status_rx) = mpsc::channel(1);
        let (shutdown_tx, _shutdown_rx) = mpsc::channel(1);
        let (pty_tx, _pty_rx) = mpsc::channel::<Vec<u8>>(1);

        let queue = Arc::new(MessageQueue::new(1, response_tx));
        let (server_stream, client_stream) = UnixStream::pair().unwrap();

        let server_handle = tokio::spawn(async move {
            handle_connection(server_stream, queue, status_tx, shutdown_tx, pty_tx)
                .await
                .unwrap();
        });

        let (reader, mut writer) = client_stream.into_split();
        let mut reader = BufReader::new(reader);

        writer.write_all(b"not json\n").await.unwrap();
        writer.flush().await.unwrap();

        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        let response: InjectResponse = serde_json::from_str(line.trim()).unwrap();
        match response {
            InjectResponse::Error { message } => {
                assert!(message.contains("Invalid JSON"));
            }
            other => panic!("Unexpected response: {:?}", other),
        }

        drop(writer);
        server_handle.abort();
    }
}
