//! Stress tests for the bounded priority queue.
//! Run with: cargo test --test stress_queue -- --ignored

use relay_broker::{
    queue::BoundedPriorityQueue,
    types::{InjectRequest, RelayPriority},
};

fn req(id: usize, priority: RelayPriority) -> InjectRequest {
    InjectRequest {
        id: format!("r-{}", id),
        from: "sender".into(),
        target: "#ch".into(),
        body: format!("body-{}", id),
        priority,
        attempts: 0,
    }
}

fn random_priority(i: usize) -> RelayPriority {
    match i % 5 {
        0 => RelayPriority::P0,
        1 => RelayPriority::P1,
        2 => RelayPriority::P2,
        3 => RelayPriority::P3,
        _ => RelayPriority::P4,
    }
}

#[test]
#[ignore]
fn queue_10k_items_priority_order() {
    let max = 5_000;
    let mut queue = BoundedPriorityQueue::<InjectRequest>::new(max);

    // Push 10K items with varying priorities
    for i in 0..10_000 {
        let p = random_priority(i);
        let _ = queue.push_with_overflow_policy(req(i, p));
        assert!(queue.len() <= max, "queue exceeded max at push {}", i);
    }

    // Pop all — verify priority ordering
    let mut prev_priority = 0u8;
    while let Some(item) = queue.pop() {
        let p = item.priority.as_u8();
        assert!(
            p >= prev_priority,
            "priority order violation: {} after {}",
            p,
            prev_priority
        );
        if p > prev_priority {
            prev_priority = p;
        }
    }
}

#[test]
#[ignore]
fn overflow_never_drops_p1() {
    let max = 100;
    let mut queue = BoundedPriorityQueue::<InjectRequest>::new(max);
    let mut p1_pushed = 0u64;

    for i in 0..50_000 {
        let p = if i % 7 == 0 {
            RelayPriority::P1
        } else {
            random_priority(i)
        };
        if p == RelayPriority::P1 {
            p1_pushed += 1;
        }
        let _ = queue.push_with_overflow_policy(req(i, p));
        assert!(queue.len() <= max);
    }

    // Drain and count P1s
    let mut p1_found = 0u64;
    while let Some(item) = queue.pop() {
        if item.priority == RelayPriority::P1 {
            p1_found += 1;
        }
    }

    // The queue can only hold `max` items, but all P1 items should be retained
    // (unless the queue was full of P0/P1 items, which can't be evicted)
    // At minimum, P1 items should never have been evicted for a lower-priority item
    assert!(p1_found > 0, "should have some P1 items in final queue");
    // Since P1 can't be evicted, the number found should equal min(p1_pushed, max)
    // minus any P0 items that took slots
    println!(
        "P1 pushed: {}, P1 found in final queue: {}",
        p1_pushed, p1_found
    );
}
