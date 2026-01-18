//! relay-pty: PTY wrapper for reliable agent message injection
//!
//! A Rust binary that wraps agent CLIs (claude, codex, etc.) in a PTY
//! and provides a Unix socket interface for reliable message injection.
//!
//! Usage:
//!   relay-pty --name myagent -- claude --model opus

// Allow dead code - this binary has public API components that may not be used internally
#![allow(dead_code)]

mod inject;
mod parser;
mod protocol;
mod pty;
mod queue;
mod socket;

use anyhow::{Context, Result};
use clap::Parser;
use inject::Injector;
use parser::OutputParser;
use protocol::Config;
use pty::{AsyncPty, Pty};
use queue::MessageQueue;
use socket::{SocketServer, StatusInfo, StatusQuery};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write as IoWrite};
use std::path::Path;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::select;
use tokio::signal::unix::{signal, SignalKind};
use tokio::sync::{broadcast, mpsc, Mutex};
use tracing::{debug, error, info, warn};
use tracing_subscriber::EnvFilter;

/// PTY wrapper for reliable agent message injection
#[derive(Parser, Debug)]
#[command(name = "relay-pty")]
#[command(about = "PTY wrapper for reliable agent message injection")]
#[command(version)]
struct Args {
    /// Agent name/identifier
    #[arg(short, long)]
    name: String,

    /// Unix socket path (default: /tmp/relay-pty-{name}.sock)
    #[arg(short, long)]
    socket: Option<String>,

    /// Regex pattern to detect agent prompt
    #[arg(long, default_value = r"^[>$%#] $")]
    prompt_pattern: String,

    /// Milliseconds of silence before considering idle
    #[arg(long, default_value = "500")]
    idle_timeout: u64,

    /// Maximum messages in queue before backpressure
    #[arg(long, default_value = "50")]
    queue_max: usize,

    /// Output parsed relay commands as JSON to stderr
    #[arg(long)]
    json_output: bool,

    /// Maximum injection retries
    #[arg(long, default_value = "3")]
    max_retries: u32,

    /// Delay between retries in milliseconds
    #[arg(long, default_value = "300")]
    retry_delay: u64,

    /// Log level (error, warn, info, debug, trace)
    #[arg(long, default_value = "info")]
    log_level: String,

    /// Terminal rows (for headless mode)
    #[arg(long)]
    rows: Option<u16>,

    /// Terminal columns (for headless mode)
    #[arg(long)]
    cols: Option<u16>,

    /// Log file path for agent output (tees stdout to file)
    #[arg(long)]
    log_file: Option<String>,

    /// Outbox directory for file-based relay messages
    #[arg(long)]
    outbox: Option<String>,

    /// Command to run (after --)
    #[arg(last = true, required = true)]
    command: Vec<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    // Initialize logging
    let filter = EnvFilter::try_new(&args.log_level).unwrap_or_else(|_| EnvFilter::new("info"));

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .with_writer(io::stderr)
        .init();

    info!("relay-pty v{}", env!("CARGO_PKG_VERSION"));
    info!("Agent: {}", args.name);
    info!("Command: {:?}", args.command);

    // Build configuration
    let socket_path = args
        .socket
        .unwrap_or_else(|| format!("/tmp/relay-pty-{}.sock", args.name));

    let config = Config {
        name: args.name.clone(),
        socket_path: socket_path.clone(),
        prompt_pattern: args.prompt_pattern,
        idle_timeout_ms: args.idle_timeout,
        queue_max: args.queue_max,
        json_output: args.json_output,
        command: args.command.clone(),
        max_retries: args.max_retries,
        retry_delay_ms: args.retry_delay,
    };

    info!("Socket: {}", socket_path);
    if let (Some(r), Some(c)) = (args.rows, args.cols) {
        info!("Terminal size: {}x{}", c, r);
    }

    // Open log file if specified
    let log_file: Option<Arc<Mutex<File>>> = if let Some(ref log_path) = args.log_file {
        // Create parent directory if needed
        if let Some(parent) = Path::new(log_path).parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                warn!("Failed to create log directory {:?}: {}", parent, e);
            }
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
            .context(format!("Failed to open log file: {}", log_path))?;
        info!("Logging output to: {}", log_path);
        Some(Arc::new(Mutex::new(file)))
    } else {
        None
    };

    // Create PTY and spawn agent
    let pty = Pty::spawn(&args.command, args.rows, args.cols).context("Failed to spawn agent")?;

    // Set raw mode for transparent terminal passthrough (if TTY available)
    let is_interactive = Pty::set_raw_mode().context("Failed to set raw mode")?;
    if is_interactive {
        info!("Running in interactive mode (TTY)");
    } else {
        info!("Running in headless mode (no TTY)");
    }

    // Wrap in async PTY
    let mut async_pty = AsyncPty::new(pty);

    // Create channels
    // Broadcast channel for response notifications (socket server subscribes to this)
    let (response_tx, _response_rx) = broadcast::channel(64);
    let (status_tx, mut status_rx) = mpsc::channel::<StatusQuery>(16);
    let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);
    let (inject_tx, mut inject_rx) = mpsc::channel::<Vec<u8>>(64);

    // Create message queue with broadcast sender
    let queue = Arc::new(MessageQueue::new(config.queue_max, response_tx));

    // Create injector
    let injector = Arc::new(Injector::new(inject_tx, Arc::clone(&queue), config.clone()));

    // Create output parser
    let mut parser = if let Some(ref outbox) = args.outbox {
        let outbox_path = std::path::PathBuf::from(outbox);
        // Create outbox directory if needed
        if !outbox_path.exists() {
            if let Err(e) = std::fs::create_dir_all(&outbox_path) {
                warn!("Failed to create outbox directory {:?}: {}", outbox_path, e);
            }
        }
        info!("File-based relay enabled, outbox: {}", outbox);
        OutputParser::with_outbox(config.name.clone(), &config.prompt_pattern, outbox_path)
    } else {
        OutputParser::new(config.name.clone(), &config.prompt_pattern)
    };

    // Start socket server
    let socket_server = SocketServer::new(
        socket_path.clone(),
        Arc::clone(&queue),
        status_tx,
        shutdown_tx,
    );

    let socket_handle = tokio::spawn(async move {
        if let Err(e) = socket_server.run().await {
            error!("Socket server error: {}", e);
        }
    });

    // Start injector
    let injector_clone = Arc::clone(&injector);
    let injector_handle = tokio::spawn(async move {
        if let Err(e) = injector_clone.run().await {
            error!("Injector error: {}", e);
        }
    });

    // Set up signal handlers
    let mut sigint = signal(SignalKind::interrupt())?;
    let mut sigterm = signal(SignalKind::terminate())?;
    let mut sigwinch = signal(SignalKind::window_change())?;

    // Create stdin reader (always - for both interactive and piped input)
    let (stdin_tx, mut stdin_rx) = mpsc::channel::<Vec<u8>>(32);
    std::thread::spawn(move || {
        let mut stdin = io::stdin();
        let mut buf = [0u8; 1024];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if stdin_tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Main event loop
    let json_output = config.json_output;
    let mut stdout = tokio::io::stdout();

    loop {
        select! {
            // Handle shutdown signal
            _ = shutdown_rx.recv() => {
                info!("Shutdown requested");
                break;
            }

            // Handle SIGINT
            _ = sigint.recv() => {
                info!("SIGINT received");
                // Forward to child
                let _ = async_pty.signal(nix::sys::signal::Signal::SIGINT);
            }

            // Handle SIGTERM
            _ = sigterm.recv() => {
                info!("SIGTERM received");
                break;
            }

            // Handle SIGWINCH (terminal resize)
            _ = sigwinch.recv() => {
                debug!("SIGWINCH received");
                if let Some((rows, cols)) = get_terminal_size() {
                    let _ = async_pty.resize(rows, cols);
                }
            }

            // Handle stdin (user input)
            Some(data) = stdin_rx.recv() => {
                debug!("Received {} bytes from stdin", data.len());
                if let Err(e) = async_pty.send(data).await {
                    error!("Failed to send to PTY: {}", e);
                }
            }

            // Handle injected messages from injector
            Some(data) = inject_rx.recv() => {
                if let Err(e) = async_pty.send(data).await {
                    error!("Failed to inject to PTY: {}", e);
                }
            }

            // Handle PTY output
            result = async_pty.recv() => {
                if let Some(data) = result {
                    // Check for cursor position query (CSI 6n) and respond
                    // Codex CLI sends this query and waits for response - without it, Codex times out
                    // Pattern: ESC [ 6 n or ESC [ ? 6 n
                    let text = String::from_utf8_lossy(&data);
                    if text.contains("\x1b[6n") || text.contains("\x1b[?6n") {
                        debug!("Detected cursor position query (CSI 6n), sending response");
                        // Respond with cursor at position (1, 1): ESC [ 1 ; 1 R
                        let response = b"\x1b[1;1R";
                        if let Err(e) = async_pty.send(response.to_vec()).await {
                            warn!("Failed to send cursor position response: {}", e);
                        }
                    }

                    // Write to stdout
                    stdout.write_all(&data).await?;
                    stdout.flush().await?;

                    // Write to log file if configured
                    if let Some(ref log) = log_file {
                        let mut file = log.lock().await;
                        let _ = file.write_all(&data);
                        let _ = file.flush();
                    }

                    // Parse output
                    let parse_result = parser.process(&data);

                    // Update injector state
                    injector.record_output(&text).await;
                    injector.update_from_parse(&parse_result);

                    // Output parsed commands as JSON if enabled
                    if json_output {
                        for cmd in parse_result.commands {
                            let json = serde_json::to_string(&cmd)?;
                            eprintln!("{}", json);
                        }
                    }
                } else {
                    // PTY closed
                    info!("PTY closed");
                    break;
                }
            }

            // Handle status queries
            Some(query) = status_rx.recv() => {
                let info = StatusInfo {
                    agent_idle: injector.check_idle(),
                    queue_length: queue.len().await,
                    cursor_position: None, // Would need terminal query
                    last_output_ms: injector.silence_ms(),
                };
                let _ = query.response_tx.send(info);
            }

            // Note: Response notifications are handled by the socket server
            // which subscribes to the queue's broadcast channel directly
        }

        // Check if child is still running
        if !async_pty.is_running() {
            info!("Child process exited");
            break;
        }
    }

    // Cleanup
    info!("Shutting down...");

    // Terminate child and reap
    let _ = async_pty.shutdown();

    // Restore terminal
    Pty::restore_terminal();

    // Clean up socket
    let _ = std::fs::remove_file(&socket_path);

    // Abort background tasks
    socket_handle.abort();
    injector_handle.abort();

    info!("Goodbye!");
    Ok(())
}

/// Get current terminal size
fn get_terminal_size() -> Option<(u16, u16)> {
    use nix::libc;
    use nix::pty::Winsize;

    let mut winsize = Winsize {
        ws_row: 0,
        ws_col: 0,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };

    unsafe {
        if libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut winsize) == 0 {
            Some((winsize.ws_row, winsize.ws_col))
        } else {
            None
        }
    }
}
