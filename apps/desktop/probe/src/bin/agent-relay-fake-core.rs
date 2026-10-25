//! A fake relay core for the Linux app's tests: it takes
//! `relay serve --socket PATH [--exit-on-stdin-eof]` as
//! `agent-relay-probe` does, and serves a signed-out core
//! (`linux_app::fake_core`) until its stdin closes, or until asked to stop
//! without `--exit-on-stdin-eof`. `FAKE_CORE_LOG` names a file that gets
//! each method called, one per line.

use agent_relay_probe::linux_app::fake_core::{self, FakeCore};
use std::io::Read;
use std::path::PathBuf;
use std::process::ExitCode;

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let socket = arguments
        .iter()
        .position(|argument| argument == "--socket")
        .and_then(|index| arguments.get(index + 1));
    let (true, Some(socket)) = (
        arguments.starts_with(&["relay".into(), "serve".into()]),
        socket,
    ) else {
        eprintln!("usage: agent-relay-fake-core relay serve --socket PATH [--exit-on-stdin-eof]");
        return ExitCode::from(2);
    };
    let socket = PathBuf::from(socket);
    if let Some(parent) = socket.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let core = match FakeCore::start(&socket) {
        Ok(core) => core,
        Err(error) => {
            eprintln!("agent-relay-fake-core: {error}");
            return ExitCode::FAILURE;
        }
    };
    if let Some(log) = std::env::var_os("FAKE_CORE_LOG") {
        core.log_calls_to(PathBuf::from(log));
    }
    fake_core::serve_answers(&core);
    if arguments
        .iter()
        .any(|argument| argument == "--exit-on-stdin-eof")
    {
        // A plain thread: the process may end while it still reads.
        let (closed, stdin_closed) = tokio::sync::oneshot::channel::<()>();
        std::thread::spawn(move || {
            let mut sink = Vec::new();
            let _ = std::io::stdin().read_to_end(&mut sink);
            let _ = closed.send(());
        });
        tokio::select! {
            _ = stdin_closed => {}
            _ = core.stopped() => {}
        }
    } else {
        core.stopped().await;
    }
    core.stop().await;
    ExitCode::SUCCESS
}
