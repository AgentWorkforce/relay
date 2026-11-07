use super::*;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;

fn write_frame(stream: &mut UnixStream, value: &Value) {
    let bytes = serde_json::to_vec(value).unwrap();
    stream
        .write_all(&crate::relay::codex::ipc::encode_frame(&bytes).unwrap())
        .unwrap();
}
fn read_frame(stream: &mut UnixStream) -> Value {
    let mut header = [0; 4];
    stream.read_exact(&mut header).unwrap();
    let size = u32::from_le_bytes(header) as usize;
    assert!(size < 4 * 1024 * 1024);
    let mut payload = vec![0; size];
    stream.read_exact(&mut payload).unwrap();
    serde_json::from_slice(&payload).unwrap()
}

#[test]
fn fragmented_frames_preserve_boundaries_and_deadline() {
    let (client, mut server) = UnixStream::pair().unwrap();
    let mut socket = Socket::from_stream(client).unwrap();
    let first = json!({"kind":"first"});
    let second = json!({"kind":"second"});
    let frame =
        crate::relay::codex::ipc::encode_frame(&serde_json::to_vec(&first).unwrap()).unwrap();
    server.write_all(&frame[..2]).unwrap();
    assert_eq!(
        socket
            .receive(Instant::now() + Duration::from_millis(10))
            .unwrap(),
        None
    );
    server.write_all(&frame[2..]).unwrap();
    write_frame(&mut server, &second);
    assert_eq!(
        socket
            .receive(Instant::now() + Duration::from_secs(1))
            .unwrap(),
        Some(first)
    );
    assert_eq!(
        socket
            .receive(Instant::now() + Duration::from_secs(1))
            .unwrap(),
        Some(second)
    );
    drop(server);
    assert_eq!(
        socket.receive(Instant::now() + Duration::from_secs(1)),
        Err(Error::Disconnected)
    );
}

#[test]
fn malformed_and_oversized_frames_fail_without_large_allocation() {
    for bytes in [
        vec![0, 0, 0, 0],
        (4 * 1024 * 1024_u32 + 1).to_le_bytes().to_vec(),
        vec![1, 0, 0, 0, b'x'],
    ] {
        let (client, mut server) = UnixStream::pair().unwrap();
        let mut socket = Socket::from_stream(client).unwrap();
        server.write_all(&bytes).unwrap();
        assert_eq!(
            socket.receive(Instant::now() + Duration::from_secs(1)),
            Err(Error::InvalidFrame)
        );
    }
}

#[test]
fn actual_socket_admission_recovers_without_duplicate_decision_and_unfollows() {
    let (client, mut server) = UnixStream::pair().unwrap();
    server
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let worker = std::thread::spawn(move || {
        let mut follow_count = 0;
        let mut decision_count = 0;
        loop {
            let message = read_frame(&mut server);
            match message["method"].as_str().unwrap() {
                "initialize" => write_frame(
                    &mut server,
                    &json!({"type":"response","requestId":message["requestId"],"resultType":"success","result":{"clientId":"follower"}}),
                ),
                "thread-owner-discovery" => write_frame(
                    &mut server,
                    &json!({"type":"response","requestId":message["requestId"],"resultType":"success","handledByClientId":OWNER,"result":{"ok":true}}),
                ),
                "thread-stream-following-changed" => {
                    assert_eq!(message["version"], 1);
                    assert_eq!(message["targetClientIds"], json!([OWNER]));
                    if message["params"]["following"] == false {
                        break;
                    }
                    follow_count += 1;
                    write_frame(&mut server, &snapshot(state(), 1));
                }
                "thread-follower-command-approval-decision" => {
                    decision_count += 1;
                    assert_eq!(message["targetClientId"], OWNER);
                    assert_eq!(
                        message["params"],
                        json!({"conversationId":THREAD,"requestId":42,"decision":"decline"})
                    );
                    write_frame(
                        &mut server,
                        &json!({"type":"response","requestId":message["requestId"],"resultType":"success","handledByClientId":OWNER,"result":{"ok":true}}),
                    );
                }
                other => panic!("unexpected method {other}"),
            }
        }
        assert_eq!(follow_count, 3);
        assert_eq!(decision_count, 1);
    });
    let mut follower =
        Follower::attach(Socket::from_stream(client).unwrap(), THREAD, OWNER).unwrap();
    follower.poll(Duration::from_secs(1)).unwrap();
    let request = follower.registry().pending()[0].clone();
    assert_eq!(
        follower.decide(&request, Decision::Decline, &|| false),
        DecisionOutcome::Refused
    );
    assert_eq!(
        follower.decide(&request, Decision::Decline, &|| true),
        DecisionOutcome::AcknowledgedUnconfirmed
    );
    assert_eq!(
        follower.decide(&request, Decision::Decline, &|| panic!(
            "accepted request replay"
        )),
        DecisionOutcome::AcknowledgedUnconfirmed
    );
    follower.close().unwrap();
    worker.join().unwrap();
}
