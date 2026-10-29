//! A streaming writer may flush for minutes before closing its descriptor.
use super::*;

#[test]
fn held_open_writer_is_acknowledged_while_the_archive_round_is_unfinished() {
    let install = Install::new();
    let home = fs::canonicalize(install.home.path()).unwrap();
    let directory = fs::canonicalize(&install.directory).unwrap();
    let project = home.join(".claude/projects/streaming");
    fs::create_dir_all(&project).unwrap();
    let active = project.join("active.jsonl");
    fs::write(&active, line("active", "streaming-initial")).unwrap();
    // Seed only the active session through explicit synthetic provider roots.
    // Its known locator must be in the bounded recent window before cold work.
    let roots = ai_hist::ProviderRoots::from_home(
        home.clone(),
        home.join(".local/share/opencode/opencode.db"),
    );
    let store = ai_hist::SessionStore::open(
        ai_hist::StoreOptions::default()
            .db_path(directory.join("history.db"))
            .roots(roots),
    )
    .unwrap();
    store
        .sync(ai_hist::SyncOptions::default().sources([ai_hist::Source::Claude]))
        .unwrap();
    assert_eq!(
        store
            .sessions(ai_hist::CatalogQuery::default())
            .next()
            .unwrap()
            .unwrap()
            .session_id,
        "active"
    );
    drop(store);
    for n in 0..1000 {
        let id = format!("archive-{n}");
        // Historical timestamps keep active inside the 32 most recent rows.
        let text: String = (0..8)
            .map(|i| {
                let mut value: Value =
                    serde_json::from_str(&line(&id, &format!("old-{n}-{i}"))).unwrap();
                value["timestamp"] = json!("2020-01-01T00:00:00Z");
                format!("{value}\n")
            })
            .collect();
        fs::write(project.join(format!("{id}.jsonl")), text).unwrap();
    }
    let mut collector = isolated_collector(&install, &home, &directory);
    let diagnose = || install.diagnose();
    wait_for(
        &install.received,
        "streaming-initial",
        Duration::from_secs(45),
        &diagnose,
    );
    let ready = Instant::now();
    loop {
        let report: Value = fs::read(directory.join("cycle.json"))
            .ok()
            .and_then(|data| serde_json::from_slice(&data).ok())
            .unwrap_or_default();
        let metrics = &report["capture_metrics"];
        if metrics["driver"] == "fs-events"
            && metrics["fallback_reason"].is_null()
            && metrics["cold_paths"].as_u64().unwrap_or(0) >= 8
            && metrics["ticks_by_trigger"]["poll"].as_u64().unwrap_or(0) >= 1
        {
            break;
        }
        assert!(
            ready.elapsed() < Duration::from_secs(45),
            "native watcher/cold slices not ready: {}",
            diagnose()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    // Let the initial recent-path capture and startup notifications settle;
    // a previously queued pass must not accidentally capture this new marker.
    std::thread::sleep(Duration::from_secs(5));
    let mut writer = fs::OpenOptions::new().append(true).open(&active).unwrap();
    let marker = format!("streaming-held-open-{}", std::process::id());
    let written = Instant::now();
    writer
        .write_all(line("active", &marker).as_bytes())
        .unwrap();
    writer.flush().unwrap();
    let ack = wait_for(
        &install.received,
        &marker,
        Duration::from_secs(15),
        &diagnose,
    );
    // writer remains live until AFTER the unique durable receipt and archive
    // check. On macOS its close event cannot be the capture mechanism.
    let conn = rusqlite::Connection::open_with_flags(
        directory.join("history.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let catalogued: usize = conn
        .query_row(
            "SELECT COUNT(*) FROM sessions WHERE session_id LIKE 'archive-%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        catalogued < 1000,
        "ACK must precede completion of archive discovery"
    );
    eprintln!(
        "held_open_ack_ms={} archive_catalogued={catalogued}/1000",
        ack.saturating_duration_since(written).as_millis()
    );
    drop(conn);
    // An empty create may be processed before its first complete JSON record.
    // Observe the actual native create callback as well as a subsequent hot
    // attempt; then write the identity while BOTH descriptors remain open.
    std::thread::sleep(Duration::from_millis(100));
    let fs_ticks = || -> u64 {
        fs::read(directory.join("cycle.json"))
            .ok()
            .and_then(|data| serde_json::from_slice::<Value>(&data).ok())
            .and_then(|report| report["capture_metrics"]["ticks_by_trigger"]["fs-event"].as_u64())
            .unwrap_or(0)
    };
    let before_create = fs_ticks();
    let late = project.join("late-streaming.jsonl");
    let event_path = late.clone();
    let (notices, received) = std::sync::mpsc::channel();
    use notify::Watcher;
    let mut observer = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = event {
            if matches!(event.kind, notify::EventKind::Create(_))
                && event.paths.contains(&event_path)
            {
                let _ = notices.send(());
            }
        }
    })
    .unwrap();
    observer
        .watch(&project, notify::RecursiveMode::Recursive)
        .unwrap();
    let mut late_writer = fs::File::create(&late).unwrap();
    received
        .recv_timeout(Duration::from_secs(10))
        .expect("native empty-create event must arrive while descriptor stays open");
    let attempted = Instant::now();
    while fs_ticks() <= before_create {
        assert!(
            attempted.elapsed() < Duration::from_secs(30),
            "empty create was not attempted: {}",
            diagnose()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let conn = rusqlite::Connection::open_with_flags(
        directory.join("history.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let absent: bool = conn
        .query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM sessions WHERE session_id='late-streaming')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        absent,
        "the create attempt must precede a parsable identity"
    );
    drop(conn);
    let late_marker = format!("late-held-open-{}", std::process::id());
    let written = Instant::now();
    late_writer
        .write_all(line("late-streaming", &late_marker).as_bytes())
        .unwrap();
    late_writer.flush().unwrap();
    let ack = wait_for(
        &install.received,
        &late_marker,
        Duration::from_secs(15),
        &diagnose,
    );
    eprintln!(
        "empty_create_held_open_ack_ms={}",
        ack.saturating_duration_since(written).as_millis()
    );
    drop(late_writer);
    drop(writer);
    install.stop(&mut collector);
}

fn isolated_collector(install: &Install, home: &Path, directory: &Path) -> Running {
    let mut cmd = command(home);
    let env: Vec<_> = cmd
        .get_envs()
        .filter_map(|(key, value)| value.map(|value| (key.to_owned(), value.to_owned())))
        .collect();
    cmd.env_clear()
        .envs(env)
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
    Running(
        cmd.args(["run", "--directory"])
            .arg(directory)
            .args(["--startup-id", "live-test"])
            .stderr(fs::File::create(install.log()).unwrap())
            .spawn()
            .unwrap(),
    )
}

#[test]
fn selected_member_held_open_writer_is_acknowledged_without_close_event() {
    let install = Install::new();
    let home = fs::canonicalize(install.home.path()).unwrap();
    let directory = fs::canonicalize(&install.directory).unwrap();
    let project = home.join(".claude/projects/selected-streaming");
    fs::create_dir_all(&project).unwrap();
    let active = project.join("member.jsonl");
    fs::write(&active, line("member", "selected-initial")).unwrap();
    let roots = ai_hist::ProviderRoots::from_home(
        home.clone(),
        home.join(".local/share/opencode/opencode.db"),
    );
    let store = ai_hist::SessionStore::open(
        ai_hist::StoreOptions::default()
            .db_path(directory.join("history.db"))
            .roots(roots),
    )
    .unwrap();
    store
        .sync(ai_hist::SyncOptions::default().sources([ai_hist::Source::Claude]))
        .unwrap();
    drop(store);
    let mut config: Value =
        serde_json::from_slice(&fs::read(directory.join("config.json")).unwrap()).unwrap();
    let conn = delivery::open_db(&directory.join("history.db")).unwrap();
    let old = delivery::status(&conn, config["job_id"].as_str().unwrap()).unwrap();
    delivery::cancel_job(&conn, &old.job_id).unwrap();
    let job = delivery::create_session_job(&conn, &old.config, 0).unwrap();
    delivery::set_job_session(
        &conn,
        &job.job_id,
        &delivery::SessionIdentity {
            source: "claude".into(),
            session_id: "member".into(),
        },
        true,
    )
    .unwrap();
    drop(conn);
    config["job_id"] = json!(job.job_id);
    config["sharing_mode"] = json!("selected");
    fs::write(
        directory.join("config.json"),
        serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    let mut collector = isolated_collector(&install, &home, &directory);
    let diagnose = || install.diagnose();
    wait_for(
        &install.received,
        "selected-initial",
        Duration::from_secs(30),
        &diagnose,
    );
    let ready = Instant::now();
    loop {
        let report: Value = fs::read(directory.join("cycle.json"))
            .ok()
            .and_then(|data| serde_json::from_slice(&data).ok())
            .unwrap_or_default();
        let metrics = &report["capture_metrics"];
        if metrics["driver"] == "member-events" && metrics["hydrations"].as_u64().unwrap_or(0) >= 1
        {
            break;
        }
        assert!(
            ready.elapsed() < Duration::from_secs(30),
            "selected native member not ready: {}",
            diagnose()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    std::thread::sleep(Duration::from_secs(2));
    let mut writer = fs::OpenOptions::new().append(true).open(&active).unwrap();
    let marker = format!("selected-held-open-{}", std::process::id());
    let written = Instant::now();
    writer
        .write_all(line("member", &marker).as_bytes())
        .unwrap();
    writer.flush().unwrap();
    let ack = wait_for(
        &install.received,
        &marker,
        Duration::from_secs(15),
        &diagnose,
    );
    eprintln!(
        "selected_held_open_ack_ms={}",
        ack.saturating_duration_since(written).as_millis()
    );
    drop(writer);
    install.stop(&mut collector);
}
