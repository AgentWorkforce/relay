//! Stress tests for the scheduler coalescing logic.
//! Run with: cargo test --test stress_scheduler -- --ignored

use std::collections::HashSet;
use std::time::{Duration, Instant};

use relay_broker::{
    scheduler::Scheduler,
    types::{InjectRequest, RelayPriority},
};

fn req(id: usize, from: &str, target: &str, body: &str) -> InjectRequest {
    InjectRequest {
        id: format!("r-{}", id),
        from: from.into(),
        target: target.into(),
        body: body.into(),
        priority: RelayPriority::P3,
        attempts: 0,
    }
}

#[test]
#[ignore]
fn coalesce_correctness_rapid_fire() {
    let mut scheduler = Scheduler::new(3000, 500);
    let start = Instant::now();

    let senders: Vec<String> = (0..10).map(|i| format!("sender-{}", i)).collect();
    let targets: Vec<String> = (0..10).map(|i| format!("#ch-{}", i)).collect();

    // Push 1000 messages across 10 senders x 10 targets, advancing 10ms each
    let mut all_bodies = Vec::new();
    let mut flushed_bodies = Vec::new();

    for i in 0..1000 {
        let sender = &senders[i % 10];
        let target = &targets[(i / 10) % 10];
        let body = format!("msg-{}", i);
        all_bodies.push(body.clone());

        let time = start + Duration::from_millis(i as u64 * 10);
        if let Some(flushed) = scheduler.push(req(i, sender, target, &body), time) {
            // Collect all bodies from flushed (may be coalesced with \n)
            for part in flushed.body.split('\n') {
                flushed_bodies.push(part.to_string());
            }
        }
    }

    // Drain everything remaining
    let final_time = start + Duration::from_millis(15_000);
    for ready in scheduler.drain_ready(final_time) {
        for part in ready.body.split('\n') {
            flushed_bodies.push(part.to_string());
        }
    }

    // Verify no message was lost
    let all_set: HashSet<&str> = all_bodies.iter().map(String::as_str).collect();
    let flushed_set: HashSet<&str> = flushed_bodies.iter().map(String::as_str).collect();

    for body in &all_set {
        assert!(
            flushed_set.contains(body),
            "message '{}' was lost during coalescing",
            body
        );
    }

    assert_eq!(
        all_bodies.len(),
        flushed_bodies.len(),
        "total message count mismatch: expected {}, got {}",
        all_bodies.len(),
        flushed_bodies.len()
    );
}
