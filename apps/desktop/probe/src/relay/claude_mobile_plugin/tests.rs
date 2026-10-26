use super::*;

fn paths(temp: &tempfile::TempDir) -> (PathBuf, PathBuf) {
    (temp.path().join(".claude"), temp.path().join("relay.sock"))
}

#[test]
fn installs_and_updates_only_owned_files_with_private_modes() {
    let temp = tempfile::tempdir().unwrap();
    let (config, socket) = paths(&temp);
    install(&config, &socket).unwrap();
    let root = config.join("skills/agent-relay-mobile");
    assert_eq!(fs::read(root.join(MARKER)).unwrap(), OWNER.as_bytes());
    let bridge: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("bridge.json")).unwrap()).unwrap();
    assert!(bridge.get("helper").is_none());
    assert_eq!(bridge.as_object().unwrap().len(), 1);
    assert_eq!(bridge["socket"], socket.to_string_lossy().as_ref());
    assert_eq!(
        fs::read_to_string(root.join("hooks/register.mjs")).unwrap(),
        REGISTER
    );
    assert_eq!(
        fs::read_to_string(root.join("hooks/hooks.json")).unwrap(),
        HOOKS
    );
    assert_eq!(
        fs::read_to_string(root.join(".claude-plugin/plugin.json")).unwrap(),
        MANIFEST
    );
    fs::write(root.join("personal-note"), "keep").unwrap();
    let replacement = temp.path().join("new-relay.sock");
    install(&config, &replacement).unwrap();
    assert_eq!(
        fs::read_to_string(root.join("personal-note")).unwrap(),
        "keep"
    );
    let bridge: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("bridge.json")).unwrap()).unwrap();
    assert_eq!(bridge["socket"], replacement.to_string_lossy().as_ref());
    #[cfg(unix)]
    {
        assert_eq!(
            fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        for file in [
            MARKER,
            "bridge.json",
            "hooks/register.mjs",
            "hooks/hooks.json",
            ".claude-plugin/plugin.json",
        ] {
            assert_eq!(
                fs::metadata(root.join(file)).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}

#[test]
fn refuses_unmarked_existing_destination_without_changing_it() {
    let temp = tempfile::tempdir().unwrap();
    let (config, socket) = paths(&temp);
    let root = config.join("skills/agent-relay-mobile");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("user-data"), "untouched").unwrap();
    assert!(install(&config, &socket).is_err());
    assert_eq!(
        fs::read_to_string(root.join("user-data")).unwrap(),
        "untouched"
    );
    assert!(!root.join(MARKER).exists());
    assert!(!root.join("bridge.json").exists());
}

#[test]
fn relative_bridge_paths_do_not_create_a_plugin() {
    let temp = tempfile::tempdir().unwrap();
    let (config, _) = paths(&temp);
    assert!(install(&config, Path::new("relay.sock")).is_err());
    assert!(!config.exists());
}

#[cfg(unix)]
#[test]
fn refuses_symlinked_directories_and_files_before_overwriting_assets() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let (config, socket) = paths(&temp);
    let outside = temp.path().join("outside");
    fs::create_dir(&outside).unwrap();
    symlink(&outside, &config).unwrap();
    assert!(install(&config, &socket).is_err());
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    fs::remove_file(&config).unwrap();
    install(&config, &socket).unwrap();
    let root = config.join("skills/agent-relay-mobile");
    let old_bridge = fs::read(root.join("bridge.json")).unwrap();
    let other_file = outside.join("foreign.mjs");
    fs::write(&other_file, "untouched").unwrap();
    fs::remove_file(root.join("hooks/register.mjs")).unwrap();
    symlink(&other_file, root.join("hooks/register.mjs")).unwrap();
    assert!(install(&config, &temp.path().join("other.sock")).is_err());
    assert_eq!(fs::read(root.join("bridge.json")).unwrap(), old_bridge);
    assert_eq!(fs::read_to_string(other_file).unwrap(), "untouched");
}

#[cfg(unix)]
#[tokio::test]
async fn startup_refresh_requires_persisted_opt_in_and_updates_the_bridge() {
    use crate::relay::daemon::Config;
    use crate::relay::paths::CorePaths;
    let temp = tempfile::tempdir().unwrap();
    let config = Config {
        paths: CorePaths::for_socket(temp.path().join("run/core.sock")).unwrap(),
        home: temp.path().into(),
        app_data_dir: temp.path().join("app-data"),
        env: Default::default(),
        version: "test".into(),
        host_name: "test".into(),
        rediscover_every: std::time::Duration::from_secs(3600),
        push_timing: Default::default(),
        delivery_timing: Default::default(),
    };
    let plugin = temp.path().join(".claude/skills/agent-relay-mobile");
    let (core, _) = Core::new(config.clone());
    assert!(
        !plugin.exists(),
        "starting with the setting off installs nothing"
    );
    core.store
        .update(|store| store.mobile_claude_handoff = Some(true))
        .unwrap();
    drop(core);
    let (core, _) = Core::new(config.clone());
    assert!(plugin.join("bridge.json").is_file());
    fs::write(plugin.join("bridge.json"), "old socket").unwrap();
    drop(core);
    let (core, _) = Core::new(config.clone());
    let bridge: serde_json::Value =
        serde_json::from_slice(&fs::read(plugin.join("bridge.json")).unwrap()).unwrap();
    assert_eq!(
        bridge["socket"],
        crate::relay::outbound::default_socket(
            &|key| config.env.get(key).cloned(),
            &config.app_data_dir,
            crate::relay::peer::current_uid()
        )
        .to_string_lossy()
        .as_ref()
    );
    core.store
        .update(|store| store.mobile_claude_handoff = Some(false))
        .unwrap();
    fs::write(plugin.join("bridge.json"), "leave disabled plugin alone").unwrap();
    drop(core);
    let (_core, _) = Core::new(config);
    assert_eq!(
        fs::read_to_string(plugin.join("bridge.json")).unwrap(),
        "leave disabled plugin alone"
    );
}

#[test]
fn installation_cache_tracks_late_roots_revocation_socket_changes_and_retry() {
    use crate::relay::store::{SessionKind, Target};
    use std::collections::BTreeMap;
    use std::time::{Duration, Instant};
    let temp = tempfile::tempdir().unwrap();
    let (default, socket) = paths(&temp);
    let extra = temp.path().join(".claude-work");
    let first = Target::new(SessionKind::ClaudeTerminal, "first");
    let second = Target::new(SessionKind::ClaudeTerminal, "second");
    let targets: BTreeMap<_, _> = [
        (first.clone(), default.clone()),
        (second.clone(), extra.clone()),
    ]
    .into();
    let cache = Installations::default();
    let now = Instant::now();
    let one = cache.refresh(vec![default.clone()], targets.clone(), &socket, false, now);
    assert!(one.errors.is_empty());
    assert!(cache.contains(&first));
    assert!(
        !cache.contains(&second),
        "a target outside installed scope is not native-capable"
    );
    let bridge = default.join("skills/agent-relay-mobile/bridge.json");
    fs::write(&bridge, "do not rewrite cached plugin on each discovery").unwrap();
    let same = cache.refresh(vec![default.clone()], targets.clone(), &socket, false, now);
    assert!(!same.attempted && same.changed.is_empty());
    assert_eq!(
        fs::read_to_string(&bridge).unwrap(),
        "do not rewrite cached plugin on each discovery"
    );
    let late = cache.refresh(
        vec![default.clone(), extra.clone()],
        targets.clone(),
        &socket,
        false,
        now,
    );
    assert!(late.errors.is_empty() && cache.contains(&second));
    assert!(late.changed.contains(&second));
    let revoked = cache.refresh(vec![default.clone()], targets.clone(), &socket, false, now);
    assert!(!cache.contains(&second) && revoked.changed.contains(&second));
    cache.acknowledge_revoked(&revoked.revoked);
    let moved_socket = temp.path().join("moved.sock");
    let moved = cache.refresh(
        vec![default.clone()],
        targets.clone(),
        &moved_socket,
        false,
        now,
    );
    cache.acknowledge_revoked(&moved.revoked);
    assert!(fs::read_to_string(&bridge).unwrap().contains("moved.sock"));
    // A foreign reserved directory must not be overwritten, or advertised.
    let foreign = temp.path().join("foreign");
    fs::create_dir_all(foreign.join("skills/agent-relay-mobile")).unwrap();
    let denied = [(second.clone(), foreign.clone())].into();
    let failure = cache.refresh(vec![foreign.clone()], denied, &socket, false, now);
    assert!(!failure.errors.is_empty() && !cache.contains(&second));
    cache.acknowledge_revoked(&failure.revoked);
    let retry = cache.refresh(
        vec![foreign.clone()],
        BTreeMap::new(),
        &socket,
        false,
        now + Duration::from_secs(1),
    );
    assert!(
        !retry.attempted,
        "failed roots have a bounded retry cadence"
    );
    fs::remove_dir(foreign.join("skills/agent-relay-mobile")).unwrap();
    let retry = cache.refresh(
        vec![foreign.clone()],
        [(second.clone(), foreign)].into(),
        &socket,
        false,
        now + Duration::from_secs(31),
    );
    assert!(retry.errors.is_empty() && cache.contains(&second));
}

#[test]
fn native_config_root_resolution_rejects_duplicate_session_ids() {
    let temp = tempfile::tempdir().unwrap();
    let config = crate::relay::claude::ClaudeConfig::resolve(&|_| None, temp.path(), &[]);
    let mut session = crate::relay::claude::TerminalSession::decode(br#"{"sessionId":"00000000-0000-4000-8000-000000000001","pid":123,"messagingSocketPath":"/tmp/claude.sock","kind":"interactive"}"#).unwrap();
    let target = crate::relay::store::Target::new(
        crate::relay::store::SessionKind::ClaudeTerminal,
        &session.session_id,
    );
    assert_eq!(
        session_roots(&config, &[session.clone()])[&target],
        config.home
    );
    session.registry = Some(temp.path().join("work/sessions"));
    assert_eq!(
        session_roots(&config, &[session.clone()])[&target],
        temp.path().join("work")
    );
    let mut duplicate = session.clone();
    duplicate.pid = 124;
    duplicate.registry = None;
    assert!(session_roots(&config, &[session.clone(), duplicate]).is_empty());
    session.kind = Some("unknown".into());
    assert!(session_roots(&config, &[session]).is_empty());
}

#[test]
fn transient_registry_absence_keeps_generation_but_explicit_revocation_is_acknowledged() {
    use crate::relay::store::{SessionKind, Target};
    use std::time::Instant;
    let temp = tempfile::tempdir().unwrap();
    let (root, socket) = paths(&temp);
    let target = Target::new(SessionKind::ClaudeTerminal, "session");
    let targets = [(target.clone(), root.clone())].into();
    let cache = Installations::default();
    let now = Instant::now();
    cache.refresh(vec![root.clone()], targets, &socket, false, now);
    let missing = cache.refresh(vec![root.clone()], Default::default(), &socket, false, now);
    assert!(
        missing.revoked.is_empty(),
        "a provider registry rewrite is not explicit revocation"
    );
    let unshared = cache.refresh(vec![], Default::default(), &socket, false, now);
    assert!(
        unshared.revoked.contains(&target),
        "remember the root even while its registry was absent"
    );
    let reshared = cache.refresh(
        vec![root.clone()],
        [(target.clone(), root.clone())].into(),
        &socket,
        false,
        now,
    );
    assert!(reshared.revoked.contains(&target));
    assert!(
        !cache.contains(&target),
        "failed durable revocation must block re-admission"
    );
    cache.acknowledge_revoked(&reshared.revoked);
    cache.refresh(
        vec![root.clone()],
        [(target.clone(), root)].into(),
        &socket,
        false,
        now,
    );
    assert!(
        cache.contains(&target),
        "a fresh snapshot re-admits only after durable revocation succeeded"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn shared_watched_logins_install_on_opt_in_and_late_discovery_only() {
    use crate::relay::{claude_dirs::ClaudeDirs, daemon::Config, paths::CorePaths};
    let temp = tempfile::tempdir().unwrap();
    let config = Config {
        paths: CorePaths::for_socket(temp.path().join("core.sock")).unwrap(),
        home: temp.path().into(),
        app_data_dir: temp.path().join("app-data"),
        env: Default::default(),
        version: "test".into(),
        host_name: "test".into(),
        rediscover_every: std::time::Duration::from_secs(3600),
        push_timing: Default::default(),
        delivery_timing: Default::default(),
    };
    let relay_home = crate::relay::workspace::relay_home(&|_| None, &config.home);
    fs::create_dir_all(&relay_home).unwrap();
    let dirs = ClaudeDirs::from_env(&|_| None, &config.home, &relay_home);
    let default = config.home.join(".claude");
    let shared = config.home.join("work-login");
    let unshared = config.home.join("private-login");
    for root in [&shared, &unshared] {
        fs::create_dir(root).unwrap();
    }
    dirs.set_added(
        &[
            shared.to_string_lossy().into(),
            unshared.to_string_lossy().into(),
        ],
        &config.home,
    )
    .unwrap();
    dirs.set_shared(unshared.to_str().unwrap(), false, &default)
        .unwrap();
    let (core, _) = Core::new(config);
    let plugin = |root: &Path| root.join("skills/agent-relay-mobile/bridge.json");
    core.refresh_mobile_claude_plugin();
    assert!(
        !plugin(&shared).exists(),
        "a watched root alone does not opt in"
    );
    core.store
        .update(|store| store.mobile_claude_handoff = Some(true))
        .unwrap();
    core.install_mobile_claude_plugin().unwrap();
    assert!(plugin(&default).is_file() && plugin(&shared).is_file());
    assert!(!plugin(&unshared).exists());
    let late = temp.path().join("late-login");
    fs::create_dir(&late).unwrap();
    assert!(dirs.record_running(std::slice::from_ref(&late)));
    core.refresh_mobile_claude_plugin();
    assert!(
        plugin(&late).is_file(),
        "a newly discovered shared login receives the plugin"
    );
    dirs.set_shared(late.to_str().unwrap(), false, &default)
        .unwrap();
    fs::write(plugin(&late), "leave unshared login unchanged").unwrap();
    core.refresh_mobile_claude_plugin();
    assert_eq!(
        fs::read_to_string(plugin(&late)).unwrap(),
        "leave unshared login unchanged"
    );
}

#[test]
fn unreadable_consent_never_becomes_permission_to_install_or_revoke() {
    use crate::relay::claude_dirs::{ClaudeDirs, Recorded};
    use crate::relay::store::{SessionKind, Target};
    let temp = tempfile::tempdir().unwrap();
    let default = temp.path().join(".claude");
    let file = temp.path().join("folders.json");
    let dirs = ClaudeDirs {
        environment: vec![],
        file: Some(file.clone()),
    };
    let cache = Installations::default();
    let target = Target::new(SessionKind::ClaudeTerminal, "session");
    fs::write(&file, serde_json::to_vec(&Recorded::default()).unwrap()).unwrap();
    let roots = scope::shared_roots(&dirs, &default, &cache).unwrap();
    cache.refresh(
        roots,
        [(target.clone(), default.clone())].into(),
        &temp.path().join("socket"),
        false,
        std::time::Instant::now(),
    );
    fs::write(&file, "{broken sharing choices").unwrap();
    let discovered = temp.path().join("new-login");
    fs::create_dir(&discovered).unwrap();
    assert!(!dirs.record_running(&[discovered]));
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        "{broken sharing choices"
    );
    let error = scope::shared_roots(&dirs, &default, &cache).unwrap_err();
    let uncertain = cache.uncertain(error);
    assert!(!cache.contains(&target) && uncertain.revoked.is_empty());
    fs::write(&file, serde_json::to_vec(&Recorded::default()).unwrap()).unwrap();
    let roots = scope::shared_roots(&dirs, &default, &cache).unwrap();
    let restored = cache.refresh(
        roots,
        [(target.clone(), default)].into(),
        &temp.path().join("socket"),
        false,
        std::time::Instant::now(),
    );
    assert!(restored.revoked.is_empty() && cache.contains(&target));
    fs::remove_file(&file).unwrap();
    assert!(scope::shared_roots(&dirs, &temp.path().join(".claude"), &cache).is_err());
}
