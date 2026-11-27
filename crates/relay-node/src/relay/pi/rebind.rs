//! A session's binding after Pi's `/reload` or a restart: the extension then
//! writes a new instance directory for the same session id. The registration
//! keeps the binding it was pinned to; once the process holding that binding
//! is proven gone, delivery follows the one live binding of the same session
//! and records it as the old binding's successor (`successor.json` in the old
//! instance directory). Receipts recorded in any directory of that chain stay
//! readable, and messages still queued in the old directory move to the new
//! one, so none is lost and none is handed to Pi twice.
use super::*;
use crate::relay::store::Registration;

const SUCCESSOR: &str = "successor.json";
/// Links followed at most: a long-lived session reloaded this often is
/// still followed, and a corrupt chain cannot loop.
const MAX_LINKS: usize = 64;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Successor {
    version: u32,
    session_id: String,
    reference: String,
}

/// A binding reference of this flavor, `kind:pid:start:instance`, with its
/// private instance directory.
pub(super) struct Pin {
    pub reference: String,
    pid: i32,
    start: u64,
    pub directory: PathBuf,
}

pub(super) fn parse(config: &PiConfig, uid: u32, reference: &str) -> Option<Pin> {
    let parts: Vec<_> = reference.split(':').collect();
    if parts.len() != 4 || parts[0] != config.flavor.kind().as_str() || !nonce(parts[3]) {
        return None;
    }
    let pid = parts[1].parse::<i32>().ok().filter(|pid| *pid > 0)?;
    let start = parts[2].parse::<u64>().ok().filter(|start| *start > 0)?;
    let directory = config.runtime.join(parts[3]);
    (config.enabled && private(&config.runtime, uid, true) && private(&directory, uid, true)).then(
        || Pin {
            reference: reference.into(),
            pid,
            start,
            directory,
        },
    )
}

/// The registration's pin followed through its successor links, oldest
/// first; empty when the pin names no private directory of this flavor.
pub(super) fn chain(config: &PiConfig, uid: u32, registration: &Registration) -> Vec<Pin> {
    let mut pins: Vec<Pin> = Vec::new();
    let mut next = registration
        .route_binding
        .as_deref()
        .and_then(|reference| parse(config, uid, reference));
    while let Some(pin) = next.take() {
        next = read::<Successor>(&pin.directory.join(SUCCESSOR), uid)
            .filter(|link| link.version == 1 && link.session_id == registration.target.id)
            .and_then(|link| parse(config, uid, &link.reference))
            .filter(|found| {
                found.directory != pin.directory
                    && !pins.iter().any(|seen| seen.directory == found.directory)
            });
        pins.push(pin);
        if pins.len() >= MAX_LINKS {
            break;
        }
    }
    pins
}

/// Whether the process `pin` names no longer holds its registry: the kernel
/// reports it exited, its pid now names another process, it is a zombie, or
/// its descriptors were read and do not include the registry, as after Pi's
/// `/reload`. A lookup that fails, or a descriptor table that cannot be
/// read, proves nothing, and the holder counts as present.
fn holder_gone(table: &dyn ProcessTable, uid: u32, pin: &Pin) -> bool {
    let Some(process) = table.process(pin.pid) else {
        return table.process_gone(pin.pid);
    };
    if process.start != pin.start || process.uid != uid || table.zombie(process.pid) {
        return true;
    }
    let Ok(registry) = pin.directory.join("session.json").canonicalize() else {
        return false;
    };
    let open = table.open_files(process.pid);
    if open.is_empty() {
        return false;
    }
    let held = open
        .iter()
        .any(|open| open == &registry || open.canonicalize().ok().as_ref() == Some(&registry));
    !held && table.process(process.pid) == Some(process)
}

/// Whether delivery may go to `binding`, the one live binding of the
/// registration's session now, without writing anything.
pub(super) fn accepts(
    config: &PiConfig,
    table: &dyn ProcessTable,
    uid: u32,
    registration: &Registration,
    binding: &Binding,
) -> bool {
    let chain = chain(config, uid, registration);
    chain.last().is_some_and(|current| {
        current.reference == binding.reference
            || (chain.len() < MAX_LINKS && holder_gone(table, uid, current))
    })
}

fn changed(name: &str) -> InjectOutcome {
    InjectOutcome::Refused(format!(
        "The {name} session binding changed; turn this agent off, then add the session again."
    ))
}

/// Makes `binding` the registration's current pin, and brings every message
/// still queued under an earlier pin to it. `Ok` when it is the current pin
/// or its predecessor's holder is proven gone; otherwise the outcome to
/// report.
///
/// The successor link is written before anything moves, so the chain always
/// reaches every directory a message was copied to; the moves are resumed
/// on every later delivery until each earlier directory is drained. The
/// holders of earlier pins were proven gone when they were followed.
pub(super) fn follow(
    config: &PiConfig,
    table: &dyn ProcessTable,
    uid: u32,
    registration: &Registration,
    binding: &Binding,
) -> Result<(), InjectOutcome> {
    let name = config.name();
    let mut chain = chain(config, uid, registration);
    let Some(current) = chain.last() else {
        return Err(changed(name));
    };
    if current.reference != binding.reference {
        if binding.registry.session_id != registration.target.id
            || chain.iter().any(|pin| pin.directory == binding.directory)
        {
            return Err(changed(name));
        }
        if !holder_gone(table, uid, current) {
            return Err(InjectOutcome::Waiting(format!(
                "Waiting for the earlier {name} process to release this session."
            )));
        }
        // Every link must stay reachable: past the limit, nothing follows.
        if chain.len() >= MAX_LINKS {
            return Err(changed(name));
        }
        let link = Successor {
            version: 1,
            session_id: registration.target.id.clone(),
            reference: binding.reference.clone(),
        };
        serde_json::to_vec(&link)
            .map_err(std::io::Error::other)
            .and_then(|bytes| atomic_write(&current.directory.join(SUCCESSOR), &bytes))
            .map_err(|_| {
                InjectOutcome::Waiting(format!(
                    "Could not record this session's new {name} process yet."
                ))
            })?;
    } else {
        chain.pop();
    }
    // Newest first, so the latest copy of each message is the one kept: an
    // older copy left behind by an interrupted move never overrides a
    // claim or a receipt a later process made.
    let mut seen = present(&binding.directory);
    for earlier in chain.iter().rev() {
        move_queued(
            uid,
            registration,
            &earlier.directory,
            &binding.directory,
            &mut seen,
        )
        .map_err(|_| {
            InjectOutcome::Waiting(format!(
                "Could not move this session's queued messages to its new {name} process yet."
            ))
        })?;
    }
    Ok(())
}

/// The message records already in `directory`, by file stem.
fn present(directory: &Path) -> std::collections::HashSet<String> {
    fs::read_dir(directory)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let file = entry.file_name().to_string_lossy().into_owned();
            let stem = file.strip_suffix(".json")?;
            (stem.len() == 64 && stem.bytes().all(|b| b.is_ascii_hexdigit()))
                .then(|| stem.to_string())
        })
        .collect()
}

/// Brings `from`'s unfinished messages to `to`, where the new extension
/// reads them, unless `to` has them already, then marks the old copies
/// `moved`, which no extension reads: a `pending` one was never handed to Pi,
/// so the new extension submits it; a `claimed` one was, so it is only
/// recorded once Pi's history shows it; a `recorded` one without its answer
/// yet gets its answer there. Copies get new arrival sequences, in the old
/// order. Saved owner-mode choices are copied too, with or without a
/// message. A message `seen` in a newer directory already has its latest
/// copy there: this older copy is only retired. Each step can be repeated
/// after a failure.
fn move_queued(
    uid: u32,
    registration: &Registration,
    from: &Path,
    to: &Path,
    seen: &mut std::collections::HashSet<String>,
) -> std::io::Result<()> {
    let _old = delivery_lock(from)?;
    let _new = delivery_lock(to)?;
    let mut queued = Vec::new();
    for entry in fs::read_dir(from)?.flatten() {
        let file = entry.file_name().to_string_lossy().into_owned();
        if let Some(stem) = file.strip_suffix(".native-choice") {
            if stem.len() == 64
                && fs::symlink_metadata(to.join(&file)).is_err()
                && private(&entry.path(), uid, false)
            {
                atomic_write(&to.join(&file), &fs::read(entry.path())?)?;
            }
            continue;
        }
        let Some(stem) = file.strip_suffix(".json") else {
            continue;
        };
        if stem.len() != 64 || !stem.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let Some(record) = read::<Delivery>(&entry.path(), uid) else {
            continue;
        };
        if record.session_id != registration.target.id
            || key(&record.message_id) != stem
            || record.state == "moved"
        {
            continue;
        }
        let unfinished = match record.state.as_str() {
            "pending" | "claimed" => true,
            "recorded" => record.answer.is_none(),
            _ => false,
        };
        if seen.contains(stem) {
            // A newer copy exists: this one is stale, whatever its state.
            let mut stale = record;
            stale.state = "moved".into();
            atomic_write(&entry.path(), &serde_json::to_vec(&stale)?)?;
        } else if unfinished {
            queued.push((record.sequence, stem.to_string(), record));
        } else {
            // Finished here; it stays, and older copies are stale.
            seen.insert(stem.to_string());
        }
    }
    // In arrival order, as the extension reads its inbox: records from
    // before sequences existed first.
    queued.sort_by(|a, b| (a.0.is_some(), a.0, &a.1).cmp(&(b.0.is_some(), b.0, &b.1)));
    for (_, stem, mut record) in queued {
        let file = format!("{stem}.json");
        if fs::symlink_metadata(to.join(&file)).is_err() {
            let sequence = next_sequence(to, uid)
                .ok_or_else(|| std::io::Error::other("no arrival sequence in the new directory"))?;
            let moved = Delivery {
                sequence: Some(sequence),
                ..read::<Delivery>(&from.join(&file), uid)
                    .ok_or_else(|| std::io::Error::other("unreadable queued record"))?
            };
            atomic_write(&to.join(&file), &serde_json::to_vec(&moved)?)?;
        }
        record.state = "moved".into();
        atomic_write(&from.join(&file), &serde_json::to_vec(&record)?)?;
        seen.insert(stem);
    }
    Ok(())
}

// File modes; Pi is off on Windows (`PiConfig`).
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::relay::peer::current_uid;
    use crate::relay::process::{FakeProcess, FakeProcesses};
    use std::os::unix::fs::PermissionsExt;

    const ID: &str = "b2c3d4e5-0000-4000-8000-0000000000b1";
    const OLD: &str = "11111111111111111111111111111111";
    const NEW: &str = "22222222222222222222222222222222";
    const THIRD: &str = "33333333333333333333333333333333";

    struct World {
        _temp: tempfile::TempDir,
        pi: PiConfig,
        omp: PiConfig,
        table: FakeProcesses,
    }

    fn world() -> World {
        let temp = tempfile::tempdir().unwrap();
        let pi = PiConfig {
            flavor: Flavor::Pi,
            runtime: temp.path().join("desktop/pi"),
            agent_dir: temp.path().join("pi-agent"),
            enabled: true,
        };
        let omp = PiConfig {
            flavor: Flavor::Omp,
            runtime: temp.path().join("desktop/omp"),
            agent_dir: temp.path().join("omp-agent"),
            enabled: true,
        };
        World {
            _temp: temp,
            pi,
            omp,
            table: FakeProcesses::default(),
        }
    }

    fn private_dir(path: &Path) {
        fs::create_dir_all(path).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }

    /// The extension in `pid` (started at `start`) binding session `id` in
    /// a new instance directory; the process holds only that registry.
    fn start(world: &World, config: &PiConfig, pid: i32, start: u64, instance: &str) {
        private_dir(&config.runtime);
        let directory = config.runtime.join(instance);
        private_dir(&directory);
        let path = directory.join("session.json");
        let registry = serde_json::json!({"version":1,"pid":pid,"sessionId":ID,
            "instance":instance,"cwd":"/work/invented","title":"Invented task",
            "nativeContinuation":1});
        atomic_write(&path, registry.to_string().as_bytes()).unwrap();
        world.table.insert(
            pid,
            FakeProcess {
                uid: current_uid(),
                start,
                open_files: vec![path.canonicalize().unwrap()],
                ..FakeProcess::default()
            },
        );
    }

    /// The process `pid` exited, as the kernel reports.
    fn exit(world: &World, pid: i32) {
        world.table.remove(pid);
        world.table.gone.lock().unwrap().insert(pid);
    }

    /// The process `pid` closed its registry, as `/reload` does.
    fn release(world: &World, pid: i32) {
        world
            .table
            .processes
            .lock()
            .unwrap()
            .get_mut(&pid)
            .unwrap()
            .open_files = vec![PathBuf::from("/dev/null")];
    }

    fn registration(config: &PiConfig, world: &World) -> Registration {
        let reference = binding(config, &world.table, current_uid(), ID)
            .unwrap()
            .reference;
        serde_json::from_value(serde_json::json!({"name":"pi-invented","agentID":"a-1",
            "target":{"kind":config.flavor.kind().as_str(),"id":ID},
            "baseURL":"https://cast.agentrelay.com",
            "registeredAt":"2026-10-20T00:00:00Z","routeBinding":reference}))
        .unwrap()
    }

    fn deliver(world: &World, config: &PiConfig, r: &Registration, id: &str) -> InjectOutcome {
        send(
            config,
            &world.table,
            current_uid(),
            r,
            id,
            "an invented note",
        )
    }

    fn record(config: &PiConfig, instance: &str, message_id: &str) -> Option<Delivery> {
        read(
            &config
                .runtime
                .join(instance)
                .join(format!("{}.json", key(message_id))),
            current_uid(),
        )
    }

    /// What the extension does once Pi's history shows the message: it is
    /// recorded, with the turn's final answer.
    fn answer(config: &PiConfig, instance: &str, message_id: &str, text: &str) {
        let mut saved = record(config, instance, message_id).unwrap();
        saved.state = "recorded".into();
        saved.answer = Some(text.into());
        let path = config
            .runtime
            .join(instance)
            .join(format!("{}.json", key(message_id)));
        atomic_write(&path, &serde_json::to_vec(&saved).unwrap()).unwrap();
    }

    fn successor(config: &PiConfig, instance: &str) -> bool {
        config.runtime.join(instance).join(SUCCESSOR).exists()
    }

    #[test]
    fn after_reload_delivery_follows_the_new_instance_of_the_same_process() {
        let world = world();
        start(&world, &world.pi, 900, 5, OLD);
        let r = registration(&world.pi, &world);
        assert!(matches!(
            deliver(&world, &world.pi, &r, "m-1"),
            InjectOutcome::Accepted(_)
        ));
        answer(&world.pi, OLD, "m-1", "first invented answer");
        // `/reload`: the same process, a new instance directory.
        release(&world, 900);
        start(&world, &world.pi, 900, 5, NEW);
        assert!(matches!(
            deliver(&world, &world.pi, &r, "m-2"),
            InjectOutcome::Accepted(_)
        ));
        assert_eq!(record(&world.pi, NEW, "m-2").unwrap().state, "pending");
        assert!(successor(&world.pi, OLD));
        // The receipt and answer recorded before the reload still settle.
        assert!(matches!(
            deliver(&world, &world.pi, &r, "m-1"),
            InjectOutcome::Delivered
        ));
        assert!(record(&world.pi, NEW, "m-1").is_none());
        let uid = current_uid();
        assert_eq!(
            final_answer(&world.pi, uid, &r, &MessageRef::of("m-1")).as_deref(),
            Some("first invented answer")
        );
        answer(&world.pi, NEW, "m-2", "second invented answer");
        assert_eq!(
            final_answer(&world.pi, uid, &r, &MessageRef::of("m-2")).as_deref(),
            Some("second invented answer")
        );
        // And again after a second reload.
        release(&world, 900);
        start(&world, &world.pi, 900, 5, THIRD);
        assert!(matches!(
            deliver(&world, &world.pi, &r, "m-3"),
            InjectOutcome::Accepted(_)
        ));
        assert!(record(&world.pi, THIRD, "m-3").is_some());
        assert!(matches!(
            deliver(&world, &world.pi, &r, "m-2"),
            InjectOutcome::Delivered
        ));
    }

    #[test]
    fn after_a_restart_delivery_follows_the_new_process() {
        let world = world();
        start(&world, &world.pi, 900, 5, OLD);
        let r = registration(&world.pi, &world);
        exit(&world, 900);
        start(&world, &world.pi, 901, 6, NEW);
        assert!(matches!(
            deliver(&world, &world.pi, &r, "m-1"),
            InjectOutcome::Accepted(_)
        ));
        assert!(record(&world.pi, NEW, "m-1").is_some());
    }

    #[test]
    fn an_old_pid_now_naming_another_process_is_gone() {
        let world = world();
        start(&world, &world.omp, 900, 5, OLD);
        let r = registration(&world.omp, &world);
        start(&world, &world.omp, 902, 7, NEW);
        world.table.insert(
            900,
            FakeProcess {
                uid: current_uid(),
                start: 99,
                ..FakeProcess::default()
            },
        );
        assert!(matches!(
            deliver(&world, &world.omp, &r, "m-1"),
            InjectOutcome::Accepted(_)
        ));
        assert!(record(&world.omp, NEW, "m-1").is_some());
    }

    #[test]
    fn an_old_holder_still_alive_keeps_the_pin() {
        let world = world();
        start(&world, &world.pi, 900, 5, OLD);
        let r = registration(&world.pi, &world);
        let old = world.table.processes.lock().unwrap()[&900].clone();
        // A second process binds the same session while the first still
        // holds it: no binding is unique, and nothing is delivered.
        start(&world, &world.pi, 901, 6, NEW);
        world.table.insert(900, old.clone());
        assert!(matches!(
            deliver(&world, &world.pi, &r, "m-1"),
            InjectOutcome::Waiting(_)
        ));
        // The new binding alone, while the old holder still runs and holds
        // its registry: waiting, never a rebind.
        world.table.insert(
            900,
            FakeProcess {
                open_files: vec![],
                ..old.clone()
            },
        );
        let new = binding(&world.pi, &world.table, current_uid(), ID).unwrap();
        world.table.insert(900, old);
        assert!(!accepts(&world.pi, &world.table, current_uid(), &r, &new));
        assert!(matches!(
            follow(&world.pi, &world.table, current_uid(), &r, &new),
            Err(InjectOutcome::Waiting(_))
        ));
        assert!(!successor(&world.pi, OLD));
        assert!(record(&world.pi, NEW, "m-1").is_none());
        assert!(record(&world.pi, OLD, "m-1").is_none());
    }

    #[test]
    fn two_live_holders_get_nothing() {
        let world = world();
        start(&world, &world.pi, 900, 5, OLD);
        let r = registration(&world.pi, &world);
        exit(&world, 900);
        start(&world, &world.pi, 901, 6, NEW);
        start(&world, &world.pi, 902, 7, THIRD);
        assert!(matches!(
            deliver(&world, &world.pi, &r, "m-1"),
            InjectOutcome::Waiting(_)
        ));
        assert!(!successor(&world.pi, OLD));
        assert!(record(&world.pi, NEW, "m-1").is_none());
        assert!(record(&world.pi, THIRD, "m-1").is_none());
    }

    #[test]
    fn an_omp_registration_never_follows_a_pi_binding() {
        let world = world();
        start(&world, &world.omp, 900, 5, OLD);
        let r = registration(&world.omp, &world);
        exit(&world, 900);
        // The same session id, bound by Pi's extension.
        start(&world, &world.pi, 901, 6, NEW);
        assert!(matches!(
            deliver(&world, &world.omp, &r, "m-1"),
            InjectOutcome::Waiting(_)
        ));
        assert!(!successor(&world.omp, OLD));
        // Nor is a Pi pin followed under Oh My Pi's runtime.
        let pi = registration(&world.pi, &world);
        assert!(chain(&world.omp, current_uid(), &pi).is_empty());
        assert!(record(&world.pi, NEW, "m-1").is_none());
    }

    #[test]
    fn queued_messages_move_once_across_a_rebind() {
        let world = world();
        start(&world, &world.pi, 900, 5, OLD);
        let r = registration(&world.pi, &world);
        // m-1 waits for Pi to be idle; m-2 was already handed to Pi.
        assert!(matches!(
            deliver(&world, &world.pi, &r, "m-1"),
            InjectOutcome::Accepted(_)
        ));
        assert!(matches!(
            deliver(&world, &world.pi, &r, "m-2"),
            InjectOutcome::Accepted(_)
        ));
        let claimed = config_path(&world.pi, OLD, "m-2");
        let mut saved = record(&world.pi, OLD, "m-2").unwrap();
        saved.state = "claimed".into();
        atomic_write(&claimed, &serde_json::to_vec(&saved).unwrap()).unwrap();

        release(&world, 900);
        start(&world, &world.pi, 900, 5, NEW);
        // Any delivery follows the session, and takes the queue with it.
        assert!(matches!(
            deliver(&world, &world.pi, &r, "m-3"),
            InjectOutcome::Accepted(_)
        ));
        assert_eq!(record(&world.pi, NEW, "m-1").unwrap().state, "pending");
        assert_eq!(record(&world.pi, NEW, "m-2").unwrap().state, "claimed");
        assert_eq!(record(&world.pi, OLD, "m-1").unwrap().state, "moved");
        assert_eq!(record(&world.pi, OLD, "m-2").unwrap().state, "moved");
        // Arrival order is kept in the new directory.
        let sequence = |id| record(&world.pi, NEW, id).unwrap().sequence.unwrap();
        assert!(sequence("m-1") < sequence("m-2"));
        assert!(sequence("m-2") < sequence("m-3"));

        // Retries neither copy nor resubmit them.
        let before = fs::read_dir(world.pi.runtime.join(NEW)).unwrap().count();
        for id in ["m-1", "m-2", "m-3"] {
            assert!(matches!(
                deliver(&world, &world.pi, &r, id),
                InjectOutcome::Accepted(_)
            ));
        }
        assert_eq!(
            fs::read_dir(world.pi.runtime.join(NEW)).unwrap().count(),
            before
        );
        assert_eq!(record(&world.pi, NEW, "m-2").unwrap().state, "claimed");

        // Recorded in the new directory, each settles exactly once.
        answer(&world.pi, NEW, "m-1", "an invented answer");
        assert!(matches!(
            deliver(&world, &world.pi, &r, "m-1"),
            InjectOutcome::Delivered
        ));
        assert_eq!(
            final_answer(&world.pi, current_uid(), &r, &MessageRef::of("m-1")).as_deref(),
            Some("an invented answer")
        );
    }

    fn config_path(config: &PiConfig, instance: &str, message_id: &str) -> PathBuf {
        config
            .runtime
            .join(instance)
            .join(format!("{}.json", key(message_id)))
    }

    #[test]
    fn a_holder_that_cannot_be_read_is_not_gone() {
        let world = world();
        start(&world, &world.pi, 900, 5, OLD);
        let r = registration(&world.pi, &world);
        // No process information, without the kernel saying it exited.
        let old = world.table.processes.lock().unwrap()[&900].clone();
        world.table.remove(900);
        start(&world, &world.pi, 901, 6, NEW);
        assert!(matches!(
            deliver(&world, &world.pi, &r, "m-1"),
            InjectOutcome::Waiting(_)
        ));
        // Running, with a descriptor table that cannot be read.
        world.table.insert(
            900,
            FakeProcess {
                open_files: vec![],
                ..old
            },
        );
        assert!(matches!(
            deliver(&world, &world.pi, &r, "m-1"),
            InjectOutcome::Waiting(_)
        ));
        assert!(!successor(&world.pi, OLD));
        assert!(record(&world.pi, NEW, "m-1").is_none());
    }

    #[test]
    fn a_queued_owner_message_moves_on_its_own_retry() {
        let world = world();
        start(&world, &world.pi, 900, 5, OLD);
        let r = registration(&world.pi, &world);
        let native = |id| {
            send_native(
                &world.pi,
                &world.table,
                current_uid(),
                &r,
                id,
                "an invented note",
            )
        };
        assert!(matches!(native("m-1"), InjectOutcome::Accepted(_)));
        assert_eq!(record(&world.pi, OLD, "m-1").unwrap().version, 2);
        exit(&world, 900);
        start(&world, &world.pi, 901, 6, NEW);
        // Its retry alone brings it to the new process, once.
        assert!(matches!(native("m-1"), InjectOutcome::Accepted(_)));
        assert_eq!(record(&world.pi, NEW, "m-1").unwrap().state, "pending");
        assert_eq!(record(&world.pi, OLD, "m-1").unwrap().state, "moved");
        let choice = |instance: &str| {
            world
                .pi
                .runtime
                .join(instance)
                .join(format!("{}.native-choice", key("m-1")))
                .exists()
        };
        assert!(choice(NEW));
    }

    #[test]
    fn a_saved_choice_without_a_message_moves_too() {
        let world = world();
        start(&world, &world.pi, 900, 5, OLD);
        let r = registration(&world.pi, &world);
        let name = format!("{}.native-choice", key("m-9"));
        atomic_write(&world.pi.runtime.join(OLD).join(&name), b"not decodable").unwrap();
        exit(&world, 900);
        start(&world, &world.pi, 901, 6, NEW);
        assert!(matches!(
            deliver(&world, &world.pi, &r, "m-1"),
            InjectOutcome::Accepted(_)
        ));
        assert_eq!(
            fs::read(world.pi.runtime.join(NEW).join(&name)).unwrap(),
            b"not decodable"
        );
    }

    #[test]
    fn a_recorded_message_still_waiting_for_its_answer_moves() {
        let world = world();
        start(&world, &world.pi, 900, 5, OLD);
        let r = registration(&world.pi, &world);
        assert!(matches!(
            deliver(&world, &world.pi, &r, "m-1"),
            InjectOutcome::Accepted(_)
        ));
        let mut saved = record(&world.pi, OLD, "m-1").unwrap();
        saved.state = "recorded".into();
        atomic_write(
            &config_path(&world.pi, OLD, "m-1"),
            &serde_json::to_vec(&saved).unwrap(),
        )
        .unwrap();
        release(&world, 900);
        start(&world, &world.pi, 900, 5, NEW);
        assert!(matches!(
            deliver(&world, &world.pi, &r, "m-2"),
            InjectOutcome::Accepted(_)
        ));
        assert_eq!(record(&world.pi, NEW, "m-1").unwrap().state, "recorded");
        assert_eq!(record(&world.pi, OLD, "m-1").unwrap().state, "moved");
        // The new extension writes the answer; it is found once.
        answer(&world.pi, NEW, "m-1", "a late invented answer");
        assert_eq!(
            final_answer(&world.pi, current_uid(), &r, &MessageRef::of("m-1")).as_deref(),
            Some("a late invented answer")
        );
    }

    #[test]
    fn an_interrupted_move_resumes_across_another_restart() {
        let world = world();
        start(&world, &world.pi, 900, 5, OLD);
        let r = registration(&world.pi, &world);
        assert!(matches!(
            deliver(&world, &world.pi, &r, "m-1"),
            InjectOutcome::Accepted(_)
        ));
        exit(&world, 900);
        start(&world, &world.pi, 901, 6, NEW);
        // The link was saved, then the core stopped before anything moved.
        let new = binding(&world.pi, &world.table, current_uid(), ID).unwrap();
        let link = Successor {
            version: 1,
            session_id: ID.into(),
            reference: new.reference,
        };
        atomic_write(
            &world.pi.runtime.join(OLD).join(SUCCESSOR),
            &serde_json::to_vec(&link).unwrap(),
        )
        .unwrap();
        // And the second process exited too before any delivery.
        exit(&world, 901);
        start(&world, &world.pi, 902, 7, THIRD);
        assert!(matches!(
            deliver(&world, &world.pi, &r, "m-2"),
            InjectOutcome::Accepted(_)
        ));
        assert_eq!(record(&world.pi, THIRD, "m-1").unwrap().state, "pending");
        assert_eq!(record(&world.pi, OLD, "m-1").unwrap().state, "moved");
        assert!(record(&world.pi, NEW, "m-1").is_none());
        assert!(matches!(
            deliver(&world, &world.pi, &r, "m-1"),
            InjectOutcome::Accepted(_)
        ));
    }

    #[test]
    fn a_chain_at_its_limit_follows_no_further() {
        let world = world();
        private_dir(&world.pi.runtime);
        let instance = |i: usize| format!("{i:032x}");
        let reference = |i: usize| format!("pi:{}:1:{}", 2000 + i, instance(i));
        for i in 0..MAX_LINKS {
            private_dir(&world.pi.runtime.join(instance(i)));
            world.table.gone.lock().unwrap().insert(2000 + i as i32);
            if i + 1 < MAX_LINKS {
                let link = Successor {
                    version: 1,
                    session_id: ID.into(),
                    reference: reference(i + 1),
                };
                atomic_write(
                    &world.pi.runtime.join(instance(i)).join(SUCCESSOR),
                    &serde_json::to_vec(&link).unwrap(),
                )
                .unwrap();
            }
        }
        let r: Registration = serde_json::from_value(serde_json::json!({"name":"pi-invented",
            "agentID":"a-1","target":{"kind":"pi","id":ID},"baseURL":"https://cast.agentrelay.com",
            "registeredAt":"2026-10-20T00:00:00Z","routeBinding":reference(0)}))
        .unwrap();
        assert_eq!(chain(&world.pi, current_uid(), &r).len(), MAX_LINKS);
        start(&world, &world.pi, 901, 6, NEW);
        assert!(matches!(
            deliver(&world, &world.pi, &r, "m-1"),
            InjectOutcome::Refused(_)
        ));
        assert!(!successor(&world.pi, &instance(MAX_LINKS - 1)));
        assert!(record(&world.pi, NEW, "m-1").is_none());
    }

    /// A move from the first process to the second copied `m-1` but stopped
    /// before retiring the first copy; the second process then claimed it.
    fn interrupted_copy_then(world: &World, state: &str, answer: Option<&str>) -> Registration {
        start(world, &world.pi, 900, 5, OLD);
        let r = registration(&world.pi, world);
        assert!(matches!(
            deliver(world, &world.pi, &r, "m-1"),
            InjectOutcome::Accepted(_)
        ));
        exit(world, 900);
        start(world, &world.pi, 901, 6, NEW);
        let new = binding(&world.pi, &world.table, current_uid(), ID).unwrap();
        let link = Successor {
            version: 1,
            session_id: ID.into(),
            reference: new.reference,
        };
        atomic_write(
            &world.pi.runtime.join(OLD).join(SUCCESSOR),
            &serde_json::to_vec(&link).unwrap(),
        )
        .unwrap();
        let mut copy = record(&world.pi, OLD, "m-1").unwrap();
        copy.state = state.into();
        copy.answer = answer.map(str::to_owned);
        atomic_write(
            &config_path(&world.pi, NEW, "m-1"),
            &serde_json::to_vec(&copy).unwrap(),
        )
        .unwrap();
        exit(world, 901);
        start(world, &world.pi, 902, 7, THIRD);
        r
    }

    #[test]
    fn a_stale_older_copy_never_overrides_a_newer_claim() {
        let world = world();
        let r = interrupted_copy_then(&world, "claimed", None);
        assert!(matches!(
            deliver(&world, &world.pi, &r, "m-2"),
            InjectOutcome::Accepted(_)
        ));
        // The claim made by the second process reaches the third; the first
        // process's pending copy is retired, never resubmitted.
        assert_eq!(record(&world.pi, THIRD, "m-1").unwrap().state, "claimed");
        assert_eq!(record(&world.pi, OLD, "m-1").unwrap().state, "moved");
        assert_eq!(record(&world.pi, NEW, "m-1").unwrap().state, "moved");
    }

    #[test]
    fn a_stale_older_copy_never_hides_a_newer_answer() {
        let world = world();
        let r = interrupted_copy_then(&world, "recorded", Some("an invented answer"));
        assert!(matches!(
            deliver(&world, &world.pi, &r, "m-2"),
            InjectOutcome::Accepted(_)
        ));
        // The finished copy stays where it was recorded; the stale one is
        // retired and nothing goes to the third process.
        assert!(record(&world.pi, THIRD, "m-1").is_none());
        assert_eq!(record(&world.pi, OLD, "m-1").unwrap().state, "moved");
        assert!(matches!(
            deliver(&world, &world.pi, &r, "m-1"),
            InjectOutcome::Delivered
        ));
        assert_eq!(
            final_answer(&world.pi, current_uid(), &r, &MessageRef::of("m-1")).as_deref(),
            Some("an invented answer")
        );
    }
}
