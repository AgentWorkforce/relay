use super::*;
use crate::relay::contract::{Availability, Done, Method, MethodSpec, NoParams};
use crate::relay::daemon::{Config, MethodExtension, Plugins};
use crate::relay::delivery::DeliveryTiming;
use crate::relay::paths::CorePaths;
use crate::relay::push::PushTiming;
use futures_util::future::BoxFuture;
use serde_json::json;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Notify;

#[tokio::test]
async fn a_stalled_writer_is_aborted_before_connection_cleanup() {
    let (started, running) = tokio::sync::oneshot::channel();
    let writer = tokio::spawn(async move {
        let _ = started.send(());
        std::future::pending::<()>().await;
    });
    running.await.unwrap();

    tokio::time::timeout(
        Duration::from_secs(1),
        finish_writer(writer, Duration::from_millis(10)),
    )
    .await
    .expect("a client that stopped reading must not hold cleanup open");
}

struct Ping;

impl Method for Ping {
    const NAME: &'static str = "test.ping";
    type Params = NoParams;
    type Result = Done;
}

/// Stands in for a long poll such as `spawn_callers.inbox.next`.
struct Slow;

impl Method for Slow {
    const NAME: &'static str = "test.slow";
    type Params = NoParams;
    type Result = Done;
}

/// An effect that is admitted, waits, and is then recorded, as a spawn admit
/// or an HTTP send is.
struct Effect;

impl Method for Effect {
    const NAME: &'static str = "test.effect";
    type Params = NoParams;
    type Result = Done;
}

/// Answers `test.ping` at once; `test.slow` when released or when its
/// connection's `connection_closed` wakes it, as a long poll's extension
/// would; and `test.effect` once its gate opens. Keeps when each connection
/// was reported closed.
#[derive(Default)]
struct Probe {
    closed: std::sync::Mutex<Vec<(CallContext, Instant)>>,
    /// Connections reported closed, for calls that wait on the hook.
    closed_ids: std::sync::Mutex<HashSet<Option<u64>>>,
    hook_fired: Notify,
    slow_started: Notify,
    release_slow: Notify,
    slow_finished: AtomicBool,
    /// The slow call ended because its connection's hook woke it.
    slow_woken: AtomicBool,
    /// A pending call's future was dropped before it finished.
    slow_dropped: AtomicBool,
    effect_admitted: Notify,
    effect_gate: Notify,
    effect_finished: AtomicBool,
    admitted: AtomicUsize,
    recorded: AtomicUsize,
    /// Times `test.ping` entered the extension.
    ping_calls: AtomicUsize,
}

/// Marks the probe's `slow_dropped` when a call is dropped before `finished`.
struct Dropped<'a>(&'a Probe, &'a AtomicBool);

impl Drop for Dropped<'_> {
    fn drop(&mut self) {
        if !self.1.load(Ordering::SeqCst) {
            self.0.slow_dropped.store(true, Ordering::SeqCst);
        }
    }
}

impl Probe {
    /// Waits until `connection_closed` fired for `connection`.
    async fn hook_for(&self, connection: Option<u64>) {
        loop {
            let fired = self.hook_fired.notified();
            let mut fired = std::pin::pin!(fired);
            fired.as_mut().enable();
            if self.closed_ids.lock().unwrap().contains(&connection) {
                return;
            }
            fired.await;
        }
    }
}

impl MethodExtension for Probe {
    fn specs(&self) -> Vec<MethodSpec> {
        vec![
            MethodSpec::of::<Ping>(Availability::Always),
            MethodSpec::of::<Slow>(Availability::Always),
            MethodSpec::of::<Effect>(Availability::Always),
        ]
    }

    fn call<'a>(
        &'a self,
        _core: &'a Arc<Core>,
        context: &'a CallContext,
        method: &'a str,
        _raw: Value,
    ) -> BoxFuture<'a, Option<Result<Value, RpcError>>> {
        Box::pin(async move {
            match method {
                Ping::NAME => {
                    self.ping_calls.fetch_add(1, Ordering::SeqCst);
                    Some(Ok(json!({})))
                }
                Slow::NAME => {
                    let _dropped = Dropped(self, &self.slow_finished);
                    self.slow_started.notify_one();
                    let woken = tokio::select! {
                        () = self.release_slow.notified() => false,
                        () = self.hook_for(context.connection_id) => true,
                        () = tokio::time::sleep(Duration::from_secs(30)) => false,
                    };
                    self.slow_woken.store(woken, Ordering::SeqCst);
                    self.slow_finished.store(true, Ordering::SeqCst);
                    Some(Ok(json!({})))
                }
                Effect::NAME => {
                    let _dropped = Dropped(self, &self.effect_finished);
                    self.admitted.fetch_add(1, Ordering::SeqCst);
                    self.effect_admitted.notify_one();
                    self.effect_gate.notified().await;
                    self.recorded.fetch_add(1, Ordering::SeqCst);
                    self.effect_finished.store(true, Ordering::SeqCst);
                    Some(Ok(json!({})))
                }
                _ => None,
            }
        })
    }

    fn connection_closed(&self, context: &CallContext) {
        self.closed.lock().unwrap().push((*context, Instant::now()));
        self.closed_ids
            .lock()
            .unwrap()
            .insert(context.connection_id);
        self.hook_fired.notify_waiters();
    }
}

impl Probe {
    /// Waits for the slow call to run to completion.
    async fn slow_finishes(&self) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while !self.slow_finished.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the slow call finishes");
    }

    fn closed_count(&self) -> usize {
        self.closed.lock().unwrap().len()
    }

    /// When the hook first fired, waiting up to `limit` for it.
    async fn first_closed(&self, limit: Duration) -> Instant {
        tokio::time::timeout(limit, async {
            loop {
                if let Some((_, at)) = self.closed.lock().unwrap().first() {
                    return *at;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("connection_closed fires")
    }
}

struct Served {
    _home: tempfile::TempDir,
    core: Arc<Core>,
    probe: Arc<Probe>,
    socket: std::path::PathBuf,
    stop: watch::Sender<bool>,
    server: tokio::task::JoinHandle<()>,
}

fn serve() -> Served {
    let probe = Arc::new(Probe::default());
    let home = tempfile::tempdir().unwrap();
    let config = Config {
        paths: CorePaths::for_socket(home.path().join("core.sock")).unwrap(),
        home: home.path().into(),
        app_data_dir: home.path().join("app-data"),
        env: Default::default(),
        version: "test".into(),
        host_name: "Test Desk.local".into(),
        rediscover_every: Duration::from_secs(3600),
        push_timing: PushTiming::default(),
        delivery_timing: DeliveryTiming::default(),
    };
    let plugins = Plugins {
        extensions: vec![probe.clone()],
        ..Plugins::default()
    };
    let core = Core::with_plugins(config, plugins).0;
    let socket = home.path().join("bridge.sock");
    let listener = CoreListener::bind(&socket).unwrap();
    let (stop, stopped) = watch::channel(false);
    let server = tokio::spawn(accept_loop(listener, core.clone(), stopped));
    Served {
        _home: home,
        core,
        probe,
        socket,
        stop,
        server,
    }
}

impl Served {
    /// Settles, then stops the server with every connection's end reported.
    async fn finish(self) -> Arc<Probe> {
        tokio::time::sleep(Duration::from_millis(100)).await;
        self.core.request_shutdown();
        self.stop.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(5), self.server)
            .await
            .expect("the server stops")
            .unwrap();
        self.probe
    }
}

type Lines = tokio::io::Lines<BufReader<crate::relay::transport::CoreReadHalf>>;
type Write = crate::relay::transport::CoreWriteHalf;

async fn send(write: &mut Write, id: u64, method: &str, params: Value) {
    let request = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
    write
        .write_all(format!("{request}\n").as_bytes())
        .await
        .unwrap();
}

async fn reply(lines: &mut Lines) -> Value {
    let line = tokio::time::timeout(Duration::from_secs(5), lines.next_line())
        .await
        .expect("a reply")
        .unwrap()
        .expect("an open connection");
    serde_json::from_str(&line).unwrap()
}

/// A client that has said hello.
async fn greeted(socket: &std::path::Path) -> (Lines, Write) {
    let (read, mut write) = CoreStream::connect(socket).await.unwrap().into_split();
    let mut lines = BufReader::new(read).lines();
    send(
        &mut write,
        1,
        "hello",
        json!({"bridge_version": BRIDGE_VERSION}),
    )
    .await;
    let hello = reply(&mut lines).await;
    assert!(hello.get("error").is_none(), "{hello}");
    (lines, write)
}

#[tokio::test]
async fn a_close_with_no_call_pending_fires_connection_closed_once() {
    let served = serve();
    let (mut lines, mut write) = greeted(&served.socket).await;
    send(&mut write, 2, Ping::NAME, json!({})).await;
    assert_eq!(reply(&mut lines).await["id"], 2);
    drop((lines, write));
    served.probe.first_closed(Duration::from_secs(2)).await;
    let probe = served.finish().await;
    assert_eq!(probe.closed_count(), 1);
    assert_eq!(probe.closed.lock().unwrap()[0].0.connection_id, Some(1));
}

#[tokio::test]
async fn a_drop_during_pending_inbox_next_fires_connection_closed_promptly() {
    let served = serve();
    let (lines, mut write) = greeted(&served.socket).await;
    send(&mut write, 2, Slow::NAME, json!({})).await;
    tokio::time::timeout(Duration::from_secs(5), served.probe.slow_started.notified())
        .await
        .expect("the slow call starts");
    let dropped_at = Instant::now();
    drop((lines, write));
    let fired_at = served.probe.first_closed(Duration::from_secs(2)).await;
    let elapsed = fired_at.duration_since(dropped_at);
    eprintln!("connection_closed fired {elapsed:?} after the client dropped");
    assert!(elapsed < Duration::from_secs(2), "{elapsed:?}");
    served.probe.slow_finishes().await;
    assert!(served.probe.slow_woken.load(Ordering::SeqCst));
    assert!(!served.probe.slow_dropped.load(Ordering::SeqCst));
    let probe = served.finish().await;
    assert_eq!(probe.closed_count(), 1);
}

#[tokio::test]
async fn a_hang_up_behind_a_queued_request_still_fires_connection_closed_once() {
    let served = serve();
    let (lines, mut write) = greeted(&served.socket).await;
    send(&mut write, 2, Slow::NAME, json!({})).await;
    send(&mut write, 3, Ping::NAME, json!({})).await;
    tokio::time::timeout(Duration::from_secs(5), served.probe.slow_started.notified())
        .await
        .expect("the slow call starts");
    drop((lines, write));
    served.probe.first_closed(Duration::from_secs(2)).await;
    served.probe.slow_finishes().await;
    assert!(!served.probe.slow_dropped.load(Ordering::SeqCst));
    let probe = served.finish().await;
    assert_eq!(probe.closed_count(), 1);
}

#[tokio::test]
async fn requests_read_during_a_call_are_answered_after_it_in_order() {
    let served = serve();
    let (mut lines, mut write) = greeted(&served.socket).await;
    send(&mut write, 2, Slow::NAME, json!({})).await;
    send(&mut write, 3, Ping::NAME, json!({})).await;
    tokio::time::timeout(Duration::from_secs(5), served.probe.slow_started.notified())
        .await
        .expect("the slow call starts");
    assert!(
        tokio::time::timeout(Duration::from_millis(200), lines.next_line())
            .await
            .is_err(),
        "the ping waits for the slow call"
    );
    served.probe.release_slow.notify_one();
    assert_eq!(reply(&mut lines).await["id"], 2);
    assert_eq!(reply(&mut lines).await["id"], 3);
    assert_eq!(served.probe.closed_count(), 0);
    drop((lines, write));
    served.probe.first_closed(Duration::from_secs(2)).await;
    let probe = served.finish().await;
    assert_eq!(probe.closed_count(), 1);
    assert!(!probe.slow_dropped.load(Ordering::SeqCst));
}

/// The client stops reading but keeps writing: the reply to its next request
/// cannot be written, and the connection ends without a read EOF.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_write_failure_fires_connection_closed_once() {
    let served = serve();
    let stream = tokio::net::UnixStream::connect(&served.socket)
        .await
        .unwrap();
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    let hello = json!({"jsonrpc":"2.0","id":1,"method":"hello","params":{"bridge_version": BRIDGE_VERSION}});
    write
        .write_all(format!("{hello}\n").as_bytes())
        .await
        .unwrap();
    lines.next_line().await.unwrap().unwrap();
    let stream = lines.into_inner().into_inner().reunite(write).unwrap();
    let stream = stream.into_std().unwrap();
    stream.shutdown(std::net::Shutdown::Read).unwrap();
    let mut stream = tokio::net::UnixStream::from_std(stream).unwrap();
    let ping = json!({"jsonrpc":"2.0","id":2,"method":Ping::NAME,"params":{}});
    stream
        .write_all(format!("{ping}\n").as_bytes())
        .await
        .unwrap();
    served.probe.first_closed(Duration::from_secs(2)).await;
    let probe = served.finish().await;
    assert_eq!(probe.closed_count(), 1);
    drop(stream);
}

#[tokio::test]
async fn server_shutdown_fires_connection_closed_once() {
    let served = serve();
    let (mut lines, write) = greeted(&served.socket).await;
    // As the daemon stops: shutdown requested, then the event published.
    served.core.request_shutdown();
    served.core.hub().shutting_down();
    assert_eq!(reply(&mut lines).await["params"]["topic"], "shutdown");
    served.probe.first_closed(Duration::from_secs(2)).await;
    // The server closed the connection; the client never hung up.
    assert!(lines.next_line().await.unwrap().is_none());
    let probe = served.finish().await;
    assert_eq!(probe.closed_count(), 1);
    drop((lines, write));
}

#[tokio::test]
async fn server_shutdown_during_a_pending_call_fires_connection_closed_once() {
    let served = serve();
    let (mut lines, mut write) = greeted(&served.socket).await;
    send(&mut write, 2, Slow::NAME, json!({})).await;
    tokio::time::timeout(Duration::from_secs(5), served.probe.slow_started.notified())
        .await
        .expect("the slow call starts");
    let stopped_at = Instant::now();
    served.core.request_shutdown();
    let fired_at = served.probe.first_closed(Duration::from_secs(2)).await;
    assert!(fired_at.duration_since(stopped_at) < Duration::from_secs(2));
    served.probe.slow_finishes().await;
    assert!(served.probe.slow_woken.load(Ordering::SeqCst));
    assert!(!served.probe.slow_dropped.load(Ordering::SeqCst));
    // The slow call is still answered, then the server closes the connection.
    let rest = rest(&mut lines).await;
    assert_eq!(rest.len(), 1, "{rest:?}");
    assert_eq!(rest[0]["id"], 2);
    let probe = served.finish().await;
    assert_eq!(probe.closed_count(), 1);
    drop(write);
}

#[tokio::test]
async fn an_effect_admitted_before_the_client_dropped_is_still_recorded_once() {
    let served = serve();
    let (lines, mut write) = greeted(&served.socket).await;
    send(&mut write, 2, Effect::NAME, json!({})).await;
    tokio::time::timeout(
        Duration::from_secs(5),
        served.probe.effect_admitted.notified(),
    )
    .await
    .expect("the effect is admitted");
    let dropped_at = Instant::now();
    drop((lines, write));
    let fired_at = served.probe.first_closed(Duration::from_secs(2)).await;
    assert!(fired_at.duration_since(dropped_at) < Duration::from_secs(2));
    assert_eq!(served.probe.recorded.load(Ordering::SeqCst), 0);
    served.probe.effect_gate.notify_one();
    tokio::time::timeout(Duration::from_secs(2), async {
        while !served.probe.effect_finished.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the effect is recorded");
    let probe = served.finish().await;
    assert_eq!(probe.admitted.load(Ordering::SeqCst), 1);
    assert_eq!(probe.recorded.load(Ordering::SeqCst), 1);
    assert!(!probe.slow_dropped.load(Ordering::SeqCst));
    assert_eq!(probe.closed_count(), 1);
}

/// Every line until the server closes the connection.
async fn rest(lines: &mut Lines) -> Vec<Value> {
    let mut rest = Vec::new();
    while let Some(line) = tokio::time::timeout(Duration::from_secs(5), lines.next_line())
        .await
        .expect("the server closes the connection")
        .unwrap()
    {
        rest.push(serde_json::from_str(&line).unwrap());
    }
    rest
}

/// A built-in method: it drains normally after the hook.
const BUILT_IN: &str = method::StatusGet::NAME;

/// Starts the slow call and sends `count` built-in requests behind it, ids
/// from 100.
async fn queue_behind_slow(served: &Served, write: &mut Write, count: usize) {
    send(write, 2, Slow::NAME, json!({})).await;
    tokio::time::timeout(Duration::from_secs(5), served.probe.slow_started.notified())
        .await
        .expect("the slow call starts");
    for id in 0..count as u64 {
        send(write, 100 + id, BUILT_IN, json!({})).await;
    }
}

const OVERFLOW: &str = "Too many requests were sent before the previous one was answered.";

#[tokio::test]
async fn a_hang_up_behind_a_full_read_ahead_fires_connection_closed_once() {
    let served = serve();
    let (lines, mut write) = greeted(&served.socket).await;
    queue_behind_slow(&served, &mut write, frames::READ_AHEAD_LINES).await;
    let dropped_at = Instant::now();
    drop((lines, write));
    let fired_at = served.probe.first_closed(Duration::from_secs(2)).await;
    assert!(fired_at.duration_since(dropped_at) < Duration::from_secs(2));
    served.probe.slow_finishes().await;
    assert!(!served.probe.slow_dropped.load(Ordering::SeqCst));
    let probe = served.finish().await;
    assert_eq!(probe.closed_count(), 1);
}

#[tokio::test]
async fn a_client_exceeding_the_line_cap_during_a_call_is_ended_with_an_error() {
    let served = serve();
    let (mut lines, mut write) = greeted(&served.socket).await;
    // One more than the read-ahead keeps; the client stays connected.
    queue_behind_slow(&served, &mut write, frames::READ_AHEAD_LINES + 1).await;
    served.probe.first_closed(Duration::from_secs(2)).await;
    served.probe.slow_finishes().await;
    assert!(served.probe.slow_woken.load(Ordering::SeqCst));
    assert!(!served.probe.slow_dropped.load(Ordering::SeqCst));
    // The in-flight answer, the read-ahead answered in order up to its
    // capacity (the request past it is never read), the error, then EOF.
    let rest = rest(&mut lines).await;
    assert_eq!(rest.len(), frames::READ_AHEAD_LINES + 2, "{rest:?}");
    assert_eq!(rest[0]["id"], 2);
    assert!(rest[0].get("error").is_none(), "{}", rest[0]);
    for (at, reply) in rest[1..=frames::READ_AHEAD_LINES].iter().enumerate() {
        assert_eq!(reply["id"], 100 + at as u64);
        assert!(reply.get("error").is_none(), "{reply}");
    }
    let error = rest.last().unwrap();
    assert_eq!(error["id"], Value::Null);
    assert_eq!(error["error"]["message"], OVERFLOW);
    let probe = served.finish().await;
    assert_eq!(probe.closed_count(), 1);
    drop(write);
}

#[tokio::test]
async fn a_client_exceeding_the_byte_cap_during_a_call_is_ended_with_an_error() {
    let served = serve();
    let (mut lines, mut write) = greeted(&served.socket).await;
    send(&mut write, 2, Slow::NAME, json!({})).await;
    tokio::time::timeout(Duration::from_secs(5), served.probe.slow_started.notified())
        .await
        .expect("the slow call starts");
    // Three requests of about 0.4 of the byte limit each, well under the
    // line cap: the third reaches the byte cap.
    let pad = "x".repeat(MAX_FRAME_BYTES * 2 / 5);
    let writing = tokio::spawn(async move {
        for id in 100..103u64 {
            let request = json!({"jsonrpc":"2.0","id":id,"method":BUILT_IN,"params":{},"pad":pad});
            write
                .write_all(format!("{request}\n").as_bytes())
                .await
                .unwrap();
        }
        write
    });
    served.probe.first_closed(Duration::from_secs(2)).await;
    served.probe.slow_finishes().await;
    assert!(served.probe.slow_woken.load(Ordering::SeqCst));
    assert!(!served.probe.slow_dropped.load(Ordering::SeqCst));
    let write = tokio::time::timeout(Duration::from_secs(5), writing)
        .await
        .expect("the client's writes are read")
        .unwrap();
    let rest = rest(&mut lines).await;
    assert_eq!(rest.len(), 5, "{rest:?}");
    assert_eq!(rest[0]["id"], 2);
    for (at, reply) in rest[1..4].iter().enumerate() {
        assert_eq!(reply["id"], 100 + at as u64);
    }
    assert_eq!(rest[4]["id"], Value::Null);
    assert_eq!(rest[4]["error"]["message"], OVERFLOW);
    let probe = served.finish().await;
    assert_eq!(probe.closed_count(), 1);
    drop(write);
}

#[tokio::test]
async fn a_queued_extension_call_fails_closed_after_the_hook_without_running() {
    let served = serve();
    let (mut lines, mut write) = greeted(&served.socket).await;
    send(&mut write, 2, Slow::NAME, json!({})).await;
    send(&mut write, 3, Ping::NAME, json!({})).await;
    send(&mut write, 4, BUILT_IN, json!({})).await;
    tokio::time::timeout(Duration::from_secs(5), served.probe.slow_started.notified())
        .await
        .expect("the slow call starts");
    write.shutdown().await.unwrap();
    served.probe.first_closed(Duration::from_secs(2)).await;
    served.probe.release_slow.notify_one();
    let slow = reply(&mut lines).await;
    assert_eq!(slow["id"], 2);
    assert!(slow.get("error").is_none(), "{slow}");
    let ping = reply(&mut lines).await;
    assert_eq!(ping["id"], 3);
    assert_eq!(
        ping["error"]["message"],
        "The connection is closing; this request was not run."
    );
    let built_in = reply(&mut lines).await;
    assert_eq!(built_in["id"], 4);
    assert!(built_in.get("error").is_none(), "{built_in}");
    assert_eq!(rest(&mut lines).await, Vec::<Value>::new());
    let probe = served.finish().await;
    assert_eq!(probe.ping_calls.load(Ordering::SeqCst), 0);
    assert_eq!(probe.closed_count(), 1);
    drop(write);
}

#[tokio::test]
async fn an_oversized_frame_during_a_pending_call_ends_the_connection() {
    let served = serve();
    let (mut lines, mut write) = greeted(&served.socket).await;
    send(&mut write, 2, Slow::NAME, json!({})).await;
    tokio::time::timeout(Duration::from_secs(5), served.probe.slow_started.notified())
        .await
        .expect("the slow call starts");
    let sent_at = Instant::now();
    // The server stops reading part-way, so the write finishes (or fails)
    // only once the connection is gone.
    let writing = tokio::spawn(async move {
        let mut huge = vec![b'x'; MAX_FRAME_BYTES + 1];
        huge.push(b'\n');
        let _ = write.write_all(&huge).await;
        write
    });
    let fired_at = served.probe.first_closed(Duration::from_secs(2)).await;
    assert!(fired_at.duration_since(sent_at) < Duration::from_secs(2));
    served.probe.slow_finishes().await;
    assert!(!served.probe.slow_dropped.load(Ordering::SeqCst));
    let rest = rest(&mut lines).await;
    assert_eq!(rest.len(), 2, "{rest:?}");
    assert_eq!(rest[0]["id"], 2);
    assert_eq!(rest[1]["error"]["message"], "The request is too large.");
    let write = tokio::time::timeout(Duration::from_secs(5), writing)
        .await
        .expect("the client's write ends")
        .unwrap();
    let probe = served.finish().await;
    assert_eq!(probe.closed_count(), 1);
    drop(write);
}

#[tokio::test]
async fn a_client_that_half_closes_still_gets_its_pending_answer() {
    let served = serve();
    let (mut lines, mut write) = greeted(&served.socket).await;
    send(&mut write, 2, Slow::NAME, json!({})).await;
    send(&mut write, 3, BUILT_IN, json!({})).await;
    tokio::time::timeout(Duration::from_secs(5), served.probe.slow_started.notified())
        .await
        .expect("the slow call starts");
    // Closes only the sending side; the client keeps reading.
    let closed_at = Instant::now();
    write.shutdown().await.unwrap();
    let fired_at = served.probe.first_closed(Duration::from_secs(2)).await;
    assert!(fired_at.duration_since(closed_at) < Duration::from_secs(2));
    served.probe.release_slow.notify_one();
    assert_eq!(reply(&mut lines).await["id"], 2);
    let queued = reply(&mut lines).await;
    assert_eq!(queued["id"], 3);
    assert!(queued.get("error").is_none(), "{queued}");
    assert_eq!(rest(&mut lines).await, Vec::<Value>::new());
    assert!(!served.probe.slow_dropped.load(Ordering::SeqCst));
    let probe = served.finish().await;
    assert_eq!(probe.closed_count(), 1);
    drop(write);
}
