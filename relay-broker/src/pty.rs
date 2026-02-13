use std::{
    io::{Read, Write},
    sync::Arc,
    thread,
};

use anyhow::{Context, Result};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tokio::sync::mpsc;

pub struct PtySession {
    master: Box<dyn portable_pty::MasterPty>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send>>>,
}

impl PtySession {
    pub fn spawn(
        command: &str,
        args: &[String],
        rows: u16,
        cols: u16,
    ) -> Result<(Self, mpsc::Receiver<Vec<u8>>)> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("failed to open pty")?;

        let mut cmd = CommandBuilder::new(command);
        cmd.cwd(std::env::current_dir().context("failed to get current directory")?);
        for arg in args {
            cmd.arg(arg);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .context("failed to spawn wrapped command")?;

        let mut reader = pair
            .master
            .try_clone_reader()
            .context("failed to clone pty reader")?;
        let writer = pair
            .master
            .take_writer()
            .context("failed to take pty writer")?;

        let (tx, rx) = mpsc::channel(256);
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.blocking_send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        Ok((
            Self {
                master: pair.master,
                writer: Arc::new(Mutex::new(writer)),
                child: Arc::new(Mutex::new(child)),
            },
            rx,
        ))
    }

    pub fn write_all(&self, bytes: &[u8]) -> Result<()> {
        let mut guard = self.writer.lock();
        guard.write_all(bytes)?;
        guard.flush()?;
        Ok(())
    }

    pub fn resize(&self, rows: u16, cols: u16) -> Result<()> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("failed to resize pty")
    }

    pub fn shutdown(&self) -> Result<()> {
        let mut child = self.child.lock();
        let _ = child.kill();
        let _ = child.wait();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::PtySession;
    use tokio::time::{timeout, Duration};

    #[tokio::test]
    async fn spawn_echo_and_read() {
        let (pty, mut rx) = PtySession::spawn("echo", &["hello".into()], 24, 80).unwrap();
        let mut collected = Vec::new();
        while let Ok(Some(chunk)) = timeout(Duration::from_secs(2), rx.recv()).await {
            collected.extend_from_slice(&chunk);
            if String::from_utf8_lossy(&collected).contains("hello") {
                break;
            }
        }
        assert!(String::from_utf8_lossy(&collected).contains("hello"));
        let _ = pty.shutdown();
    }

    #[tokio::test]
    async fn resize_does_not_error() {
        let (pty, _rx) = PtySession::spawn("sleep", &["1".into()], 24, 80).unwrap();
        assert!(pty.resize(40, 120).is_ok());
        let _ = pty.shutdown();
    }

    #[tokio::test]
    async fn shutdown_terminates() {
        let (pty, mut rx) = PtySession::spawn("sleep", &["30".into()], 24, 80).unwrap();
        assert!(pty.shutdown().is_ok());
        // After shutdown, receiver should eventually close
        let result = timeout(Duration::from_secs(2), rx.recv()).await;
        assert!(result.is_ok()); // timeout didn't fire; channel closed
    }
}
