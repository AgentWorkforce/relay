//! Integration tests for priority queue + scheduler interaction

use relay_broker::{
    queue::BoundedPriorityQueue,
    types::{InjectRequest, RelayPriority},
};

fn req(id: &str, priority: RelayPriority) -> InjectRequest {
    InjectRequest {
        id: id.into(),
        from: "sender".into(),
        target: "#general".into(),
        body: format!("body-{}", id),
        priority,
        attempts: 0,
    }
}

#[test]
fn overflow_preserves_high_priority() {
    let mut queue = BoundedPriorityQueue::<InjectRequest>::new(3);

    // Fill with P3
    queue.push(req("a", RelayPriority::P3)).unwrap();
    queue.push(req("b", RelayPriority::P3)).unwrap();
    queue.push(req("c", RelayPriority::P3)).unwrap();
    assert_eq!(queue.len(), 3);

    // Push P1 with overflow — should drop a P3
    let dropped = queue
        .push_with_overflow_policy(req("high", RelayPriority::P1))
        .unwrap();
    assert!(dropped.is_some());
    assert_eq!(dropped.unwrap().priority, RelayPriority::P3);
    assert_eq!(queue.len(), 3);

    // P1 should be first to dequeue
    let first = queue.pop().unwrap();
    assert_eq!(first.priority, RelayPriority::P1);
    assert_eq!(first.id, "high");
}

#[test]
fn mixed_priority_pop_order() {
    let mut queue = BoundedPriorityQueue::<InjectRequest>::new(10);

    queue.push(req("p4", RelayPriority::P4)).unwrap();
    queue.push(req("p0", RelayPriority::P0)).unwrap();
    queue.push(req("p2", RelayPriority::P2)).unwrap();
    queue.push(req("p1", RelayPriority::P1)).unwrap();
    queue.push(req("p3", RelayPriority::P3)).unwrap();

    let expected_order = [
        RelayPriority::P0,
        RelayPriority::P1,
        RelayPriority::P2,
        RelayPriority::P3,
        RelayPriority::P4,
    ];

    for expected in expected_order {
        let item = queue.pop().unwrap();
        assert_eq!(
            item.priority, expected,
            "expected {:?} but got {:?}",
            expected, item.priority
        );
    }
    assert!(queue.pop().is_none());
}
