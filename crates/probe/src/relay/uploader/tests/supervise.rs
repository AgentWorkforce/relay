use super::*;

/// Answers `status` with `live` as `upgrade_required_live` (absent for
/// `None`, like an older probe) and counts `start` runs.
struct GateProbe {
    starts: AtomicU64,
    live: Option<bool>,
    status_fails: bool,
    /// Lets a test detach mid-read: `status` signals `began`, waits for
    /// `release`, then fails.
    status_gate: Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>,
}

impl ProbeRunner for GateProbe {
    fn run(
        &self,
        args: Vec<String>,
        _timeout: Option<Duration>,
    ) -> BoxFuture<'_, Result<Value, UploaderError>> {
        Box::pin(async move {
            match args.first().map(String::as_str) {
                Some("status") => {
                    if let Some((began, release)) = &self.status_gate {
                        began.notify_one();
                        release.notified().await;
                    }
                    if self.status_fails {
                        return Err(UploaderError::new("store unreadable"));
                    }
                    let mut status = json!({"running": false, "paused": false});
                    if let Some(live) = self.live {
                        status["upgrade_required_live"] = json!(live);
                    }
                    Ok(status)
                }
                Some("start") => {
                    self.starts.fetch_add(1, Ordering::SeqCst);
                    Ok(json!({"running": true}))
                }
                _ => Ok(json!({})),
            }
        })
    }

    fn install(
        &self,
        _args: Vec<String>,
        _bearer: Option<Secret>,
    ) -> Result<InstallRun, UploaderError> {
        Err(UploaderError::new("unused"))
    }

    fn cancel_all(&self) -> BoxFuture<'_, Result<(), UploaderError>> {
        Box::pin(async { Ok(()) })
    }
}

fn attached_install(upgrade_required: bool) -> Option<Install> {
    Install::from_json(&json!({
        "site_url": "https://example.test", "account_id": "u1",
        "workspace_id": "w1", "upgrade_required": upgrade_required,
    }))
}

#[tokio::test]
async fn supervise_starts_over_a_claim_a_dead_process_left() {
    // The cached flag from attach still says a newer build owns the
    // install; the fresh status read says its claim is dead.
    let probe = Arc::new(GateProbe {
        starts: AtomicU64::new(0),
        live: Some(false),
        status_fails: false,
        status_gate: None,
    });
    let uploader = Uploader::new(probe.clone());
    uploader.attach(attached_install(true));
    let (_, status) = uploader.supervise().await.unwrap();
    assert_eq!(status["needs_start"], true);
    assert_eq!(probe.starts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn supervise_defers_to_a_live_newer_claim() {
    let probe = Arc::new(GateProbe {
        starts: AtomicU64::new(0),
        live: Some(true),
        status_fails: false,
        status_gate: None,
    });
    let uploader = Uploader::new(probe.clone());
    uploader.attach(attached_install(false));
    uploader.supervise().await.unwrap();
    assert_eq!(probe.starts.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn supervise_keeps_the_cached_claim_for_older_probes() {
    // A probe that does not report the live flag keeps its install's
    // attach-time answer, so nothing there changes.
    let probe = Arc::new(GateProbe {
        starts: AtomicU64::new(0),
        live: None,
        status_fails: false,
        status_gate: None,
    });
    let uploader = Uploader::new(probe.clone());
    uploader.attach(attached_install(true));
    uploader.supervise().await.unwrap();
    assert_eq!(probe.starts.load(Ordering::SeqCst), 0);
    uploader.attach(attached_install(false));
    uploader.supervise().await.unwrap();
    assert_eq!(probe.starts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn supervise_attempts_start_when_status_cannot_be_read() {
    // A dead newer build can leave a store this build cannot open and a
    // last cycle that reported success, so `status` fails before the
    // liveness gate is reached. Supervision still tries the start: the
    // probe's own `start` re-checks the live claim and the collector
    // reports the unreadable store as its own cycle instead of the
    // failure never being surfaced.
    let probe = Arc::new(GateProbe {
        starts: AtomicU64::new(0),
        live: None,
        status_fails: true,
        status_gate: None,
    });
    let uploader = Uploader::new(probe.clone());
    uploader.attach(attached_install(false));
    assert!(uploader.supervise().await.is_none());
    assert_eq!(probe.starts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn supervise_does_not_start_a_detached_install_when_status_fails() {
    // Sign-out lands while the status read is in flight, then the read
    // fails. The error-recovery start must not relaunch the install that
    // was attached when the read began — the former install's collector
    // belongs to an account this daemon no longer serves.
    let began = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let probe = Arc::new(GateProbe {
        starts: AtomicU64::new(0),
        live: None,
        status_fails: true,
        status_gate: Some((began.clone(), release.clone())),
    });
    let uploader = Uploader::new(probe.clone());
    uploader.attach(attached_install(false));

    let detach_mid_read = async {
        began.notified().await;
        uploader.attach(None);
        release.notify_one();
    };
    let (result, ()) = tokio::join!(uploader.supervise(), detach_mid_read);

    assert!(result.is_none());
    assert_eq!(probe.starts.load(Ordering::SeqCst), 0);
}
