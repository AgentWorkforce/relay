//! Pi and Oh My Pi tools are named by the registry their harness holds open.
use super::*;
use crate::relay::process::ProcessInfo;
use std::os::unix::fs::PermissionsExt;

const PI: &str = "a1b2c3d4-0000-4000-8000-000000000001";
const PI_TWO: &str = "a1b2c3d4-0000-4000-8000-000000000002";
const OMP: &str = "a1b2c3d4-0000-4000-8000-000000000003";
const INSTANCE: &str = "0123456789abcdef0123456789abcdef";
const INSTANCE_TWO: &str = "fedcba9876543210fedcba9876543210";

/// `world()` as the test's own user, whose files the extension's private
/// registry checks require.
fn pi_world() -> World {
    let mut world = world();
    let uid = crate::relay::peer::current_uid();
    world.sessions.config.uid = uid;
    for process in world.table.processes.lock().unwrap().values_mut() {
        process.uid = uid;
    }
    world
}

fn own(parent: i32, start: u64) -> FakeProcess {
    FakeProcess {
        uid: crate::relay::peer::current_uid(),
        ..process(parent, start)
    }
}

fn private_dir(path: &Path) {
    std::fs::create_dir_all(path).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}

/// What Agent Relay's extension writes when `pid` binds session `id`: a
/// private registry naming `pid`, which it holds open while bound.
fn write_registry(world: &World, kind: SessionKind, pid: i32, id: &str, instance: &str) -> PathBuf {
    let extension = world.sessions.config.extension(kind).unwrap();
    private_dir(&extension.runtime);
    let directory = extension.runtime.join(instance);
    private_dir(&directory);
    let path = directory.join("session.json");
    std::fs::write(
        &path,
        serde_json::json!({"version":1,"pid":pid,"sessionId":id,"instance":instance,
            "cwd":"/work/invented","title":"Invented task"})
        .to_string(),
    )
    .unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    path.canonicalize().unwrap()
}

fn hold(world: &World, pid: i32, path: PathBuf) {
    world
        .table
        .processes
        .lock()
        .unwrap()
        .get_mut(&pid)
        .unwrap()
        .open_files
        .push(path);
}

fn bind(world: &World, kind: SessionKind, pid: i32, id: &str, instance: &str) {
    let path = write_registry(world, kind, pid, id, instance);
    hold(world, pid, path);
}

fn caller(world: &World, pid: i32) -> Result<Target, CallerMiss> {
    world.sessions.caller(pid).map(|session| session.target)
}

fn codex_writer(parent: i32, start: u64) -> FakeProcess {
    FakeProcess {
        executable: Some(codex_exe()),
        arguments: vec!["codex".into(), "resume".into(), THREAD.into()],
        open_files: vec![PathBuf::from(format!(
            "/home/invented/.codex/thread-writer-locks/{THREAD}.lock"
        ))],
        ..own(parent, start)
    }
}

fn tagged(parent: i32, start: u64) -> FakeProcess {
    FakeProcess {
        environment: [("CODEX_THREAD_ID".to_string(), THREAD.to_string())].into(),
        ..own(parent, start)
    }
}

#[test]
fn a_pi_or_omp_harness_names_the_one_session_it_holds() {
    let world = pi_world();
    world.table.insert(600, own(1, 600));
    world.table.insert(610, own(600, 610));
    world.table.insert(620, own(610, 620));
    bind(&world, SessionKind::Pi, 600, PI, INSTANCE);
    assert_eq!(
        caller(&world, 620).ok(),
        Some(Target::new(SessionKind::Pi, PI))
    );
    let row = world.sessions.caller(620).unwrap();
    assert!(row.live);
    assert_eq!(row.title, "Invented task");
    assert_eq!(row.directory.as_deref(), Some("/work/invented"));

    world.table.insert(700, own(1, 700));
    world.table.insert(710, own(700, 710));
    bind(&world, SessionKind::Omp, 700, OMP, INSTANCE);
    assert_eq!(
        caller(&world, 710).ok(),
        Some(Target::new(SessionKind::Omp, OMP))
    );
}

#[test]
fn pi_and_claude_nested_either_way_name_the_nearest() {
    let world = pi_world();
    // Pi started from a shell in the Claude Code session.
    world.table.insert(330, own(310, 330));
    world.table.insert(340, own(330, 340));
    bind(&world, SessionKind::Pi, 330, PI, INSTANCE);
    assert_eq!(
        caller(&world, 340).ok(),
        Some(Target::new(SessionKind::Pi, PI))
    );
    assert_eq!(
        caller(&world, 320).ok(),
        Some(Target::new(SessionKind::ClaudeTerminal, CLAUDE))
    );
    // Claude Code started inside Oh My Pi.
    world.table.insert(700, own(1, 700));
    bind(&world, SessionKind::Omp, 700, OMP, INSTANCE_TWO);
    world.table.insert(300, own(700, 100));
    assert_eq!(
        caller(&world, 320).ok(),
        Some(Target::new(SessionKind::ClaudeTerminal, CLAUDE))
    );
}

#[test]
fn pi_and_codex_nested_either_way_name_the_nearest() {
    let world = pi_world();
    // Pi inside Codex: its tools inherit Codex's thread tag, which names
    // nobody while the Pi harness is nearer.
    world.table.insert(400, codex_writer(1, 400));
    world.table.insert(410, own(400, 410));
    world.table.insert(420, tagged(410, 420));
    bind(&world, SessionKind::Pi, 410, PI, INSTANCE);
    assert_eq!(
        caller(&world, 420).ok(),
        Some(Target::new(SessionKind::Pi, PI))
    );
    // Codex inside Oh My Pi.
    world.table.insert(700, own(1, 700));
    bind(&world, SessionKind::Omp, 700, OMP, INSTANCE_TWO);
    world.table.insert(710, codex_writer(700, 710));
    world.table.insert(720, tagged(710, 720));
    assert_eq!(
        caller(&world, 720).ok(),
        Some(Target::new(SessionKind::Codex, THREAD))
    );
}

#[test]
fn a_harness_holding_two_bindings_or_none_it_can_prove_is_nobody() {
    let world = pi_world();
    world.table.insert(330, own(310, 330));
    world.table.insert(340, own(330, 340));
    bind(&world, SessionKind::Pi, 330, PI, INSTANCE);
    bind(&world, SessionKind::Pi, 330, PI_TWO, INSTANCE_TWO);
    // Never the Claude Code session around it.
    assert!(matches!(caller(&world, 340), Err(CallerMiss::Unattributed)));

    // A registry it holds that names another, exited process.
    let world = pi_world();
    world.table.insert(330, own(310, 330));
    world.table.insert(340, own(330, 340));
    let stale = write_registry(&world, SessionKind::Pi, 999, PI, INSTANCE);
    hold(&world, 330, stale);
    assert!(matches!(caller(&world, 340), Err(CallerMiss::Unattributed)));

    // One Pi binding and one Oh My Pi binding in the same process.
    let world = pi_world();
    world.table.insert(330, own(310, 330));
    world.table.insert(340, own(330, 340));
    bind(&world, SessionKind::Pi, 330, PI, INSTANCE);
    bind(&world, SessionKind::Omp, 330, OMP, INSTANCE_TWO);
    assert!(matches!(caller(&world, 340), Err(CallerMiss::Unattributed)));
}

#[test]
fn a_session_two_harnesses_claim_names_neither() {
    let world = pi_world();
    world.table.insert(330, own(310, 330));
    world.table.insert(340, own(330, 340));
    world.table.insert(350, own(1, 350));
    bind(&world, SessionKind::Pi, 330, PI, INSTANCE);
    // Another live process holds a registry for the same session.
    let other = write_registry(&world, SessionKind::Pi, 350, PI, INSTANCE_TWO);
    hold(&world, 350, other);
    assert!(matches!(caller(&world, 340), Err(CallerMiss::Unattributed)));
}

#[test]
fn an_unheld_registry_names_nobody() {
    let world = pi_world();
    world.table.insert(600, own(1, 600));
    world.table.insert(610, own(600, 610));
    // Written, then released when the harness reloaded or exited: the
    // process no longer runs the extension.
    write_registry(&world, SessionKind::Pi, 600, PI, INSTANCE);
    assert!(matches!(caller(&world, 610), Err(CallerMiss::NotASession)));
}

#[test]
fn another_users_harness_lends_no_identity() {
    let world = pi_world();
    world.table.insert(
        600,
        FakeProcess {
            uid: crate::relay::peer::current_uid().wrapping_add(1),
            ..process(1, 600)
        },
    );
    world.table.insert(610, own(600, 610));
    bind(&world, SessionKind::Pi, 600, PI, INSTANCE);
    assert!(caller(&world, 610).is_err());
    assert!(!matches!(
        caller(&world, 610),
        Ok(Target {
            kind: SessionKind::Pi,
            ..
        })
    ));
}

#[test]
fn a_reused_pid_is_not_the_holder_the_walk_met() {
    let world = pi_world();
    world.table.insert(600, own(1, 600));
    bind(&world, SessionKind::Pi, 600, PI, INSTANCE);
    let walked = world.table.process(600).unwrap();
    assert_eq!(
        crate::relay::local::pi_caller::caller(&world.sessions.config, &*world.table, 600, walked)
            .and_then(Result::ok),
        Some(Target::new(SessionKind::Pi, PI))
    );
    // The walk met an earlier process with this pid; the one holding the
    // registry now started later.
    let earlier = ProcessInfo {
        start: walked.start - 1,
        ..walked
    };
    assert!(matches!(
        crate::relay::local::pi_caller::caller(&world.sessions.config, &*world.table, 600, earlier),
        Some(Err(CallerMiss::Unattributed))
    ));
}

#[test]
fn an_omp_registry_is_never_taken_for_pi_and_an_off_flavor_names_nobody() {
    let mut world = pi_world();
    world.table.insert(700, own(1, 700));
    world.table.insert(710, own(700, 710));
    bind(&world, SessionKind::Omp, 700, OMP, INSTANCE);
    assert_eq!(
        caller(&world, 710).ok(),
        Some(Target::new(SessionKind::Omp, OMP))
    );
    // Pi off changes nothing for Oh My Pi.
    world.sessions.config.pi.enabled = false;
    assert_eq!(
        caller(&world, 710).ok(),
        Some(Target::new(SessionKind::Omp, OMP))
    );
    // Oh My Pi off: its harness is still recognised, and names nobody.
    world.sessions.config.omp.enabled = false;
    assert!(matches!(caller(&world, 710), Err(CallerMiss::Unattributed)));
    world.sessions.config.omp.enabled = true;
    std::fs::write(world.sessions.config.omp.off_marker(), "off").unwrap();
    assert!(matches!(caller(&world, 710), Err(CallerMiss::Unattributed)));
    std::fs::remove_file(world.sessions.config.omp.off_marker()).unwrap();

    // A Pi-shaped registry in Oh My Pi's runtime is Oh My Pi's, and one in
    // Pi's runtime never makes an Oh My Pi caller.
    world.sessions.config.pi.enabled = true;
    world.table.insert(600, own(1, 600));
    world.table.insert(610, own(600, 610));
    bind(&world, SessionKind::Pi, 600, PI, INSTANCE_TWO);
    assert_eq!(
        caller(&world, 610).ok(),
        Some(Target::new(SessionKind::Pi, PI))
    );
    assert_eq!(
        caller(&world, 710).ok(),
        Some(Target::new(SessionKind::Omp, OMP))
    );
}
