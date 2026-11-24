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

/// Whether the process `pin` names no longer holds its registry: it exited,
/// its pid now names another process, it is a zombie, or it closed the file,
/// as Pi's `/reload` does. A live holder that cannot be checked is not gone.
fn holder_gone(table: &dyn ProcessTable, uid: u32, pin: &Pin) -> bool {
    let Some(process) = table.process(pin.pid) else {
        return true;
    };
    if process.start != pin.start || process.uid != uid || table.zombie(process.pid) {
        return true;
    }
    let Ok(registry) = pin.directory.join("session.json").canonicalize() else {
        return false;
    };
    let held = table
        .open_files(process.pid)
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
    chain(config, uid, registration)
        .last()
        .is_some_and(|current| {
            current.reference == binding.reference || holder_gone(table, uid, current)
        })
}

/// Makes `binding` the registration's current pin. `Ok` when it already is,
/// or when the current pin's holder is proven gone and its queued messages
/// moved to `binding`'s directory; otherwise the outcome to report.
pub(super) fn follow(
    config: &PiConfig,
    table: &dyn ProcessTable,
    uid: u32,
    registration: &Registration,
    binding: &Binding,
) -> Result<(), InjectOutcome> {
    let name = config.name();
    let chain = chain(config, uid, registration);
    let Some(current) = chain.last() else {
        return Err(InjectOutcome::Refused(format!(
            "The {name} session binding changed; turn this agent off, then add the session again."
        )));
    };
    if current.reference == binding.reference {
        return Ok(());
    }
    if binding.registry.session_id != registration.target.id
        || chain.iter().any(|pin| pin.directory == binding.directory)
    {
        return Err(InjectOutcome::Refused(format!(
            "The {name} session binding changed; turn this agent off, then add the session again."
        )));
    }
    if !holder_gone(table, uid, current) {
        return Err(InjectOutcome::Waiting(format!(
            "Waiting for the earlier {name} process to release this session."
        )));
    }
    move_queued(uid, registration, &current.directory, &binding.directory)
        .and_then(|()| {
            let link = Successor {
                version: 1,
                session_id: registration.target.id.clone(),
                reference: binding.reference.clone(),
            };
            let bytes = serde_json::to_vec(&link).map_err(std::io::Error::other)?;
            atomic_write(&current.directory.join(SUCCESSOR), &bytes)
        })
        .map_err(|_| {
            InjectOutcome::Waiting(format!(
                "Could not move this session's queued messages to its new {name} process yet."
            ))
        })
}

/// Copies every message still `pending` or `claimed` in `from` into `to`
/// (with a new arrival sequence there), unless `to` has it already, then
/// marks the old copy `moved`, which no extension reads. A pending message
/// was never handed to Pi, so the new extension submits it; a claimed one
/// was, so the new extension only records it once Pi's history shows it.
/// Each step can be repeated after a failure.
fn move_queued(
    uid: u32,
    registration: &Registration,
    from: &Path,
    to: &Path,
) -> std::io::Result<()> {
    let _old = delivery_lock(from)?;
    let _new = delivery_lock(to)?;
    let mut queued = Vec::new();
    for entry in fs::read_dir(from)?.flatten() {
        let file = entry.file_name().to_string_lossy().into_owned();
        let Some(stem) = file.strip_suffix(".json") else {
            continue;
        };
        if stem.len() != 64 || !stem.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let Some(record) = read::<Delivery>(&entry.path(), uid) else {
            continue;
        };
        if record.session_id == registration.target.id
            && key(&record.message_id) == stem
            && matches!(record.state.as_str(), "pending" | "claimed")
        {
            queued.push((record.sequence, stem.to_string(), record));
        }
    }
    // In arrival order, as the extension reads its inbox: records from
    // before sequences existed first.
    queued.sort_by(|a, b| (a.0.is_some(), a.0, &a.1).cmp(&(b.0.is_some(), b.0, &b.1)));
    for (_, stem, mut record) in queued {
        let file = format!("{stem}.json");
        let choice = format!("{stem}.native-choice");
        if fs::symlink_metadata(to.join(&choice)).is_err() {
            if let Some(saved) = read::<serde_json::Value>(&from.join(&choice), uid) {
                atomic_write(&to.join(&choice), &serde_json::to_vec(&saved)?)?;
            }
        }
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
            "instance":instance,"cwd":"/work/invented","title":"Invented task"});
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

    /// The process `pid` closed its registry, as `/reload` does.
    fn release(world: &World, pid: i32) {
        world
            .table
            .processes
            .lock()
            .unwrap()
            .get_mut(&pid)
            .unwrap()
            .open_files
            .clear();
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
        world.table.remove(900);
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
        world.table.remove(900);
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
        world.table.remove(900);
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
}
