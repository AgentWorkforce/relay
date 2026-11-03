use super::*;
use std::process::{Command, Stdio};

#[test]
fn host_shutdown_forwards_and_forces_only_its_owned_child_group() {
    let dir = tempfile::tempdir().unwrap();
    let mut fixture = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "relay::harness::muse::host::tests::host_shutdown_fixture",
            "--ignored",
        ])
        .env("AGENT_RELAY_TEST_MUSE_HOST_FIXTURE", dir.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    let pid_file = dir.path().join("child.pid");
    while !pid_file.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
    let pid: i32 = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    // SAFETY: signal only the direct child process created by this test.
    unsafe {
        libc::kill(fixture.id() as i32, libc::SIGTERM);
    }
    let deadline = Instant::now() + Duration::from_secs(7);
    let mut status = None;
    while Instant::now() < deadline {
        status = fixture.try_wait().unwrap();
        if status.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    // SAFETY: this pid was written by the child shell in our private fixture.
    let gone = unsafe { libc::kill(pid, 0) } == -1;
    if status.is_none() {
        let _ = fixture.kill();
        let _ = fixture.wait();
    }
    if !gone {
        unsafe {
            libc::killpg(pid, libc::SIGKILL);
        }
    }
    assert!(
        status.is_some_and(|status| status.success()),
        "host did not settle after SIGTERM"
    );
    assert!(gone, "the terminal child survived its host shutdown");
}

/// A separate test process keeps signal handling isolated from libtest's
/// other concurrently running cases. Its shell deliberately ignores TERM.
#[test]
#[ignore]
fn host_shutdown_fixture() {
    let Some(root) = std::env::var_os("AGENT_RELAY_TEST_MUSE_HOST_FIXTURE") else {
        return;
    };
    let root = std::path::PathBuf::from(root);
    let arguments = vec!["-c".into(), "trap '' TERM HUP; printf '%s\\n' \"$$\" >\"$1\"; printf 'READY\\n'; while :; do sleep 1; done".into(), "relay-host-fixture".into(), root.join("child.pid").to_string_lossy().into_owned()];
    assert!(run(Path::new("/bin/sh"), &root.join("terminal.log"), &arguments).is_err());
}

#[test]
fn natural_exit_stops_stubborn_background_pty_holder_before_reaping_leader() {
    use crate::relay::process::{ProcessTable, SystemProcesses};
    let dir = tempfile::tempdir().unwrap();
    let mut fixture = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "relay::harness::muse::host::tests::natural_exit_fixture",
            "--ignored",
        ])
        .env("AGENT_RELAY_TEST_MUSE_NATURAL_EXIT", dir.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let table = SystemProcesses::default();
    let pid_file = dir.path().join("grandchild.pid");
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut pid = None;
    while pid.is_none() && Instant::now() < deadline {
        pid = std::fs::read_to_string(&pid_file)
            .ok()
            .and_then(|value| value.trim().parse::<i32>().ok());
        if pid.is_none() {
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    let identity = pid.and_then(|pid| table.process(pid));
    let mut status = None;
    while Instant::now() < deadline {
        status = fixture.try_wait().unwrap();
        if status.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let gone = pid.is_some_and(|pid| {
        table.process_gone(pid)
            || table.zombie(pid)
            || identity.is_some_and(|expected| {
                table
                    .process(pid)
                    .is_some_and(|p| p.start != expected.start)
            })
    });
    // Cleanup also makes a failed regression safe. This pid came exclusively
    // from the private fixture; never signal a reused or foreign identity.
    if !gone {
        if let Some(expected) =
            identity.filter(|expected| table.process(expected.pid) == Some(*expected))
        {
            let _ = nix::sys::signal::kill(Pid::from_raw(expected.pid), Signal::SIGKILL);
        }
    }
    if status.is_none() {
        let _ = fixture.kill();
        let _ = fixture.wait();
    }
    assert!(
        pid.is_some(),
        "fixture never established its PTY-holding grandchild"
    );
    assert!(
        status.is_some_and(|status| status.success()),
        "host hung after its direct child exited"
    );
    assert!(
        gone,
        "the original PTY-holding grandchild survived its owner"
    );
}

#[test]
#[ignore]
fn natural_exit_fixture() {
    let Some(root) = std::env::var_os("AGENT_RELAY_TEST_MUSE_NATURAL_EXIT") else {
        return;
    };
    let root = std::path::PathBuf::from(root);
    // Job control is off: this background shell retains the direct child's
    // process group and terminal, ignores its owner's HUP/TERM, and outlives it.
    let script = "trap '' HUP; /bin/sh -c 'trap \"\" HUP TERM; printf \"%s\\n\" \"$$\" >\"$1\"; while :; do sleep 1; done' relay-grandchild \"$1\" & while test ! -s \"$1\"; do sleep 0.01; done; exit 0";
    run(
        Path::new("/bin/sh"),
        &root.join("terminal.log"),
        &[
            "-c".into(),
            script.into(),
            "relay-natural-exit".into(),
            root.join("grandchild.pid").display().to_string(),
        ],
    )
    .unwrap();
}

#[test]
fn natural_exit_preserves_output_larger_than_the_terminal_buffer() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("large.log");
    run(
        Path::new("/bin/sh"),
        &log,
        &[
            "-c".into(),
            "head -c 262144 /dev/zero | tr '\\000' x".into(),
        ],
    )
    .unwrap();
    assert_eq!(std::fs::read(log).unwrap(), vec![b'x'; 262144]);
}

#[test]
fn stopping_the_nonblocking_drain_never_waits_for_terminal_eof() {
    struct OpenTerminal;
    impl std::io::Read for OpenTerminal {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::ErrorKind::WouldBlock.into())
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let output = std::fs::File::create(dir.path().join("open.log")).unwrap();
    let drain = Drain::new(Box::new(OpenTerminal), output);
    let at = Instant::now();
    drop(drain);
    assert!(at.elapsed() < Duration::from_secs(2));
}
