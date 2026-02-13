//! Integration tests for the inbound message pipeline:
//! WS event → message_bridge → dedup → scheduler → queue → injector

use std::time::{Duration, Instant};

use relay_broker::{
    dedup::DedupCache,
    events::EventEmitter,
    inject::Injector,
    message_bridge::{map_ws_event, to_inject_request},
    queue::BoundedPriorityQueue,
    scheduler::Scheduler,
    types::{InjectRequest, RelayPriority},
};
use serde_json::json;

/// Build a ServerEvent-shaped JSON value for message.created
fn make_channel_event(
    msg_id: &str,
    channel: &str,
    agent_name: &str,
    text: &str,
) -> serde_json::Value {
    json!({
        "type": "message.created",
        "channel": channel,
        "message": {
            "id": msg_id,
            "agent_name": agent_name,
            "text": text,
            "attachments": []
        }
    })
}

/// Build a ServerEvent-shaped JSON value for dm.received
fn make_dm_event(msg_id: &str, conv_id: &str, agent_name: &str, text: &str) -> serde_json::Value {
    json!({
        "type": "dm.received",
        "conversation_id": conv_id,
        "message": {
            "id": msg_id,
            "agent_name": agent_name,
            "text": text
        }
    })
}

fn make_inject_request(
    id: &str,
    from: &str,
    target: &str,
    body: &str,
    priority: RelayPriority,
) -> InjectRequest {
    InjectRequest {
        id: id.into(),
        from: from.into(),
        target: target.into(),
        body: body.into(),
        priority,
        attempts: 0,
    }
}

#[tokio::test]
async fn ws_event_flows_to_injection() {
    let events = EventEmitter::new(false);
    let injector = Injector::new(3, 300, events);
    let mut scheduler = Scheduler::new(3000, 500);
    let mut queue = BoundedPriorityQueue::<InjectRequest>::new(200);
    let mut dedup = DedupCache::new(Duration::from_secs(300), 1000);

    let ws_event = make_channel_event("e1", "general", "alice", "hello world");

    // Step 1: Map WS event
    let mapped = map_ws_event(&ws_event).expect("should map");

    // Step 2: Dedup check
    assert!(dedup.insert_if_new(&mapped.event_id, Instant::now()));

    // Step 3: Convert to inject request
    let req = to_inject_request(mapped).expect("should convert");
    assert_eq!(req.body, "hello world");

    // Step 4: Push through scheduler
    let now = Instant::now();
    let flushed = scheduler.push(req, now);
    assert!(flushed.is_none()); // First message, no flush

    // Step 5: Drain after coalesce window
    let ready = scheduler.drain_ready(now + Duration::from_millis(600));
    assert_eq!(ready.len(), 1);

    // Step 6: Enqueue
    queue.push(ready.into_iter().next().unwrap()).unwrap();

    // Step 7: Pop and inject
    let to_inject = queue.pop().unwrap();
    let result = injector.deliver_with(to_inject, |_r| Ok(())).await;
    assert!(result.delivered);
}

#[test]
fn duplicate_events_deduplicated() {
    let mut dedup = DedupCache::new(Duration::from_secs(300), 1000);
    let mut queue = BoundedPriorityQueue::<InjectRequest>::new(200);
    let mut scheduler = Scheduler::new(3000, 500);
    let now = Instant::now();

    let ws_event = make_dm_event("dup-1", "conv_1", "bob", "hello");

    // First time — should go through
    let mapped1 = map_ws_event(&ws_event).unwrap();
    assert!(dedup.insert_if_new(&mapped1.event_id, now));
    let req1 = to_inject_request(mapped1).unwrap();
    scheduler.push(req1, now);

    // Second time — same event_id, should be blocked
    let mapped2 = map_ws_event(&ws_event).unwrap();
    assert!(!dedup.insert_if_new(&mapped2.event_id, now));

    // Drain and enqueue
    for req in scheduler.drain_ready(now + Duration::from_millis(600)) {
        queue.push(req).unwrap();
    }
    assert_eq!(queue.len(), 1, "only one event should reach the queue");
}

#[test]
fn priority_preserved_across_pipeline() {
    let mut scheduler = Scheduler::new(3000, 500);
    let mut queue = BoundedPriorityQueue::<InjectRequest>::new(200);
    let now = Instant::now();

    let dm_event = make_dm_event("dm1", "conv_1", "bob", "private msg");
    let mapped = map_ws_event(&dm_event).unwrap();
    assert_eq!(mapped.priority, RelayPriority::P2);

    let req = to_inject_request(mapped).unwrap();
    assert_eq!(req.priority, RelayPriority::P2);

    scheduler.push(req, now);
    for req in scheduler.drain_ready(now + Duration::from_millis(600)) {
        queue.push(req).unwrap();
    }

    let popped = queue.pop().unwrap();
    assert_eq!(popped.priority, RelayPriority::P2);
}

#[test]
fn coalesced_messages_single_injection() {
    let mut scheduler = Scheduler::new(3000, 500);
    let mut queue = BoundedPriorityQueue::<InjectRequest>::new(200);
    let now = Instant::now();

    // Push 3 messages from same sender within coalesce window
    scheduler.push(
        make_inject_request("1", "alice", "#general", "msg-a", RelayPriority::P3),
        now,
    );
    scheduler.push(
        make_inject_request("2", "alice", "#general", "msg-b", RelayPriority::P3),
        now + Duration::from_millis(100),
    );
    scheduler.push(
        make_inject_request("3", "alice", "#general", "msg-c", RelayPriority::P3),
        now + Duration::from_millis(200),
    );

    // Drain after window expires
    let ready = scheduler.drain_ready(now + Duration::from_millis(800));
    assert_eq!(ready.len(), 1);

    let coalesced = &ready[0];
    assert!(coalesced.body.contains("msg-a"));
    assert!(coalesced.body.contains("msg-b"));
    assert!(coalesced.body.contains("msg-c"));
    assert_eq!(coalesced.body, "msg-a\nmsg-b\nmsg-c");

    queue.push(ready.into_iter().next().unwrap()).unwrap();
    assert_eq!(queue.len(), 1);
}

#[test]
fn cooldown_blocks_p3() {
    let mut scheduler = Scheduler::new(3000, 500);
    let now = Instant::now();
    scheduler.record_human_input(now);
    assert!(!scheduler.can_inject(RelayPriority::P3, now + Duration::from_millis(500)));
}

#[test]
fn cooldown_allows_p1() {
    let mut scheduler = Scheduler::new(3000, 500);
    let now = Instant::now();
    scheduler.record_human_input(now);
    assert!(scheduler.can_inject(RelayPriority::P1, now));
}
