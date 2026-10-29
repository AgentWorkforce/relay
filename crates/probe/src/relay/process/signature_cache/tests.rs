use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Barrier, Condvar};
use std::time::Duration;

#[derive(Default)]
struct Release(Mutex<bool>, Condvar);
impl Release {
    fn wait(&self) {
        let mut released = self.0.lock().unwrap();
        while !*released {
            released = self.1.wait(released).unwrap();
        }
    }
    fn release(&self) {
        *self.0.lock().unwrap() = true;
        self.1.notify_all();
    }
}

#[test]
fn concurrent_callers_share_one_unfinished_verification_and_its_verdict() {
    let cache = Arc::new(Cache::<u64>::default());
    let release = Arc::new(Release::default());
    let start = Arc::new(Barrier::new(13));
    let calls = Arc::new(AtomicUsize::new(0));
    let (entered, notifications) = mpsc::channel();
    let mut threads = Vec::new();
    for _ in 0..12 {
        let (cache, release, start, calls, entered) = (
            cache.clone(),
            release.clone(),
            start.clone(),
            calls.clone(),
            entered.clone(),
        );
        threads.push(std::thread::spawn(move || {
            start.wait();
            cache.trusted(
                Path::new("/codex"),
                |_| Some(7),
                |_| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    entered.send(()).unwrap();
                    release.wait();
                    true
                },
            )
        }));
    }
    start.wait();
    notifications.recv_timeout(Duration::from_secs(2)).unwrap();
    let duplicate = notifications
        .recv_timeout(Duration::from_millis(100))
        .is_ok();
    release.release();
    for thread in threads {
        assert!(thread.join().unwrap());
    }
    assert!(
        !duplicate,
        "concurrent requests started duplicate file verification"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn verifying_one_binary_does_not_serialize_unrelated_binaries() {
    let cache = Arc::new(Cache::<u64>::default());
    let release = Arc::new(Release::default());
    let (entered, started) = mpsc::channel();
    let (first_cache, first_release) = (cache.clone(), release.clone());
    let first = std::thread::spawn(move || {
        first_cache.trusted(
            Path::new("/first"),
            |_| Some(1),
            |_| {
                entered.send(()).unwrap();
                first_release.wait();
                true
            },
        )
    });
    started.recv_timeout(Duration::from_secs(2)).unwrap();
    let (completed, result) = mpsc::channel();
    let second = std::thread::spawn(move || {
        completed
            .send(cache.trusted(Path::new("/second"), |_| Some(2), |_| true))
            .unwrap()
    });
    let independent = result.recv_timeout(Duration::from_secs(2));
    release.release();
    assert!(first.join().unwrap());
    second.join().unwrap();
    assert_eq!(independent.ok(), Some(true));
}

#[test]
fn replacement_while_verifying_never_inherits_or_overwrites_a_new_verdict() {
    let cache = Arc::new(Cache::<usize>::default());
    let identity = Arc::new(AtomicUsize::new(1));
    let release = Arc::new(Release::default());
    let (entered, started) = mpsc::channel();
    let (first_cache, first_identity, first_release) =
        (cache.clone(), identity.clone(), release.clone());
    let first = std::thread::spawn(move || {
        first_cache.trusted(
            Path::new("/codex"),
            |_| Some(first_identity.load(Ordering::SeqCst)),
            |_| {
                entered.send(()).unwrap();
                first_release.wait();
                true
            },
        )
    });
    started.recv_timeout(Duration::from_secs(2)).unwrap();
    identity.store(2, Ordering::SeqCst);
    let (new_cache, new_identity) = (cache.clone(), identity.clone());
    let (sent, result) = mpsc::channel();
    let second = std::thread::spawn(move || {
        sent.send(new_cache.trusted(
            Path::new("/codex"),
            |_| Some(new_identity.load(Ordering::SeqCst)),
            |_| true,
        ))
        .unwrap()
    });
    let fresh = result.recv_timeout(Duration::from_secs(2));
    release.release();
    assert!(!first.join().unwrap());
    second.join().unwrap();
    assert_eq!(fresh.ok(), Some(true));
    assert!(cache.trusted(
        Path::new("/codex"),
        |_| Some(2),
        |_| panic!("new identity must retain its own verified verdict")
    ));
}

#[test]
fn failed_verdicts_are_shared_and_changed_files_are_reverified() {
    let cache = Cache::<u64>::default();
    assert!(!cache.trusted(Path::new("/codex"), |_| Some(1), |_| false));
    assert!(!cache.trusted(
        Path::new("/codex"),
        |_| Some(1),
        |_| panic!("cached rejection")
    ));
    assert!(cache.trusted(Path::new("/codex"), |_| Some(2), |_| true));
    assert!(!cache.trusted(
        Path::new("/codex"),
        |_| None,
        |_| panic!("missing identity")
    ));
}

#[test]
fn replacement_during_a_cached_lookup_is_rejected_too() {
    let cache = Cache::<u64>::default();
    assert!(cache.trusted(Path::new("/codex"), |_| Some(1), |_| true));
    let reads = AtomicUsize::new(0);
    assert!(!cache.trusted(
        Path::new("/codex"),
        |_| Some(if reads.fetch_add(1, Ordering::SeqCst) == 0 {
            1
        } else {
            2
        }),
        |_| panic!("cached lookup must not rerun verification")
    ));
}
