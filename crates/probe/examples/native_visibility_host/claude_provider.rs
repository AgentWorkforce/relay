//! The synthetic Claude inbox still satisfies the production kernel PID check.
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};

pub(super) fn listener_pid() -> i32 {
    std::process::id() as i32
}

pub(super) async fn receive(
    stream: tokio::net::UnixStream,
) -> std::io::Result<Option<(Value, Value)>> {
    let mut lines = BufReader::new(stream).lines();
    // Identity refusal connects but sends no authentication. Keep listening.
    let Some(auth) = lines.next_line().await? else {
        return Ok(None);
    };
    let message = lines.next_line().await?.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "missing Claude message frame",
        )
    })?;
    let parse = |line: &str| {
        serde_json::from_str(line)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
    };
    Ok(Some((parse(&auth)?, parse(&message)?)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_relay_probe::relay::{
        claude::{self, ClaudeConfig},
        inject::InjectOutcome,
        process::{FakeProcess, FakeProcesses, StartClock},
    };
    use serde_json::json;
    use std::time::Duration;

    #[tokio::test]
    async fn production_sender_requires_the_real_fixture_listener_pid_and_preserves_its_frames() {
        let home = tempfile::Builder::new()
            .prefix("nv-peer-")
            .tempdir_in("/tmp")
            .unwrap();
        let config = ClaudeConfig::from_env(&|_| None, home.path());
        let registry = config.home.join("sessions");
        std::fs::create_dir_all(&registry).unwrap();
        let socket = home.path().join("peer.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let receiver = tokio::spawn(async move {
            let (rejected, _) = listener.accept().await.unwrap();
            assert!(
                receive(rejected).await.unwrap().is_none(),
                "Foreign PID must receive no auth or payload"
            );
            let (accepted, _) = listener.accept().await.unwrap();
            receive(accepted)
                .await
                .unwrap()
                .expect("Complete authenticated message")
        });
        let id = "727cce8d-8074-4ea3-94a0-dea144bf8747";
        let expected = listener_pid();
        assert_eq!(expected, std::process::id() as i32);
        let sender = tokio::task::spawn_blocking(move || {
            let table = FakeProcesses {
                clock: Some(StartClock::Ticks),
                ..Default::default()
            };
            for (pid, matches_listener) in [(expected + 1, false), (expected, true)] {
                let entry = registry.join(format!("{pid}.json"));
                let key = registry.join(format!("{pid}.fixture.key"));
                std::fs::write(&entry, json!({"sessionId":id,"pid":pid,"procStart":"100","peerProtocol":1,"messagingSocketPath":socket,"cwd":home.path(),"name":"Exact fixture"}).to_string()).unwrap();
                std::fs::write(
                    &key,
                    json!({"peerToken":"synthetic-peer-token","procStart":"100"}).to_string(),
                )
                .unwrap();
                table.insert(
                    pid,
                    FakeProcess {
                        parent: 1,
                        uid: agent_relay_probe::relay::peer::current_uid(),
                        start: 100,
                        ..Default::default()
                    },
                );
                let outcome =
                    claude::send_to_terminal(&config, &table, id, "exact-message", "exact payload");
                if matches_listener {
                    assert!(matches!(outcome, InjectOutcome::Delivered), "{outcome:?}");
                } else {
                    assert!(matches!(outcome, InjectOutcome::Retry(_)), "{outcome:?}");
                }
                std::fs::remove_file(entry).unwrap();
                std::fs::remove_file(key).unwrap();
                table.remove(pid);
            }
        });
        let (auth, message) = tokio::time::timeout(Duration::from_secs(5), receiver)
            .await
            .unwrap()
            .unwrap();
        sender.await.unwrap();
        assert_eq!(auth, json!({"type":"auth","token":"synthetic-peer-token"}));
        assert!(agent_relay_probe::relay::store::is_uuid(
            message["uuid"].as_str().unwrap()
        ));
        let mut message = message;
        message.as_object_mut().unwrap().remove("uuid");
        assert_eq!(
            message,
            json!({"type":"user","msg_id":"exact-message","priority":"next","message":{"role":"user","content":"exact payload"}})
        );
    }
}
