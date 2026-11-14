//! A name another node holds: the node takes an alternate of it, keeps it,
//! and never retries the conflict forever.
use super::enrollment::named_for;
use super::*;
use crate::relay::harness::codex;
use crate::relay::spawn::wire::{Configured, Live};
use crate::relay::spawn::{lifecycle, resources};
use futures_util::StreamExt;
use serde_json::json;
use std::path::Path;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const CONFLICT: (&str, &str) = (
    "409 Conflict",
    r#"{"ok":false,"error":{"code":"node_name_conflict","message":"Node name \"mac-desktop\" is already enrolled by another node"}}"#,
);
const ENROLLED: (&str, &str) = (
    "201 Created",
    r#"{"ok":true,"data":{"id":"node_desktop_new","token":"nt_live_new"}}"#,
);

/// A Relaycast that answers each HTTP request in turn from `answers`, then
/// accepts the node's socket on the same port; returns the requests (lower
/// case, with their bodies).
struct Scripted {
    base_url: String,
    listener: tokio::net::TcpListener,
}

impl Scripted {
    async fn new() -> Scripted {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        Scripted { base_url, listener }
    }

    /// Answers one request with `(status, body)`.
    async fn answer(&self, (status, body): (&str, &str)) -> String {
        let reply = (status.to_string(), body.to_string());
        self.answer_with(move |_| reply).await
    }

    /// Answers one request as `reply` says for it (lower case, with its
    /// body).
    async fn answer_with(&self, reply: impl FnOnce(&str) -> (String, String)) -> String {
        let (mut stream, _) = self.listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let text = String::from_utf8_lossy(&request).to_lowercase();
            if let Some(end) = text.find("\r\n\r\n") {
                let length = text
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .and_then(|value| value.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if request.len() >= end + 4 + length {
                    break;
                }
            }
            let read = stream.read(&mut buffer).await.unwrap();
            if read == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..read]);
        }
        let request = String::from_utf8_lossy(&request).to_lowercase();
        let (status, body) = reply(&request);
        let reply = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(reply.as_bytes()).await.unwrap();
        stream.shutdown().await.ok();
        request
    }
}

/// Relaycast's answer to a `POST /v1/nodes`: `Idempotency-Key` without the
/// node token is refused before anything is looked up (it replays only
/// rotations); otherwise `enrolled`.
fn keyed_without_proof_refused(
    (status, body): (&str, &str),
) -> impl FnOnce(&str) -> (String, String) {
    let enrolled = (status.to_string(), body.to_string());
    move |request| {
        if request.contains("idempotency-key:") && !request.contains("x-relaycast-node-token:") {
            (
                "400 Bad Request".to_string(),
                r#"{"ok":false,"error":{"code":"node_rotation_idempotency_requires_current_token","message":"Idempotency-Key requires X-Relaycast-Node-Token"}}"#.to_string(),
            )
        } else {
            enrolled
        }
    }
}

fn config(base_url: &str, directory: &Path) -> NodeConfig {
    NodeConfig {
        base_url: base_url.into(),
        workspace_key: Secret::new("rk_live_one".to_string()),
        control_url: None,
        node_name: "mac-desktop".into(),
        version: "1.0.0".into(),
        app_data_dir: directory.to_path_buf(),
        harnesses: vec![codex::ID],
        repositories: Vec::new(),
    }
}

fn enrollment(config: &NodeConfig, id: &str, name: &str, key: &str) -> Enrollment {
    Enrollment {
        node_id: id.into(),
        node_name: name.into(),
        token: Secret::new("nt_live_x".to_string()),
        base_url: config.base_url.clone(),
        workspace: fingerprint(&Secret::new(key.to_string())),
        rotation_key: None,
    }
}

/// The JSON body of a request.
fn body(request: &str) -> Value {
    serde_json::from_str(&request[request.find("\r\n\r\n").unwrap() + 4..]).unwrap()
}

fn idempotency_key(request: &str) -> Option<String> {
    request
        .lines()
        .find_map(|line| line.strip_prefix("idempotency-key: "))
        .map(|key| key.trim().to_string())
}

#[test]
fn an_alternate_is_the_name_and_four_hex_digits() {
    let name = alternate("mac-desktop");
    assert!(named_for(&name, "mac-desktop"), "{name}");
    assert!(named_for("mac-desktop", "mac-desktop"));
    assert!(named_for("mac-desktop-3f9a", "mac-desktop"));
    for other in [
        "mac-desktop-3F9A",
        "mac-desktop-3f9",
        "mac-desktop-3f9a1",
        "mac-desktop-zzzz",
        "mac-desktop-extra-3f9a",
        "mac-desktop3f9a",
        "other-desktop",
    ] {
        assert!(!named_for(other, "mac-desktop"), "{other}");
    }
}

#[test]
fn a_saved_alternate_is_this_computers_node() {
    let folder = tempfile::tempdir().unwrap();
    let config = config("https://cast.example", folder.path());
    let saved = enrollment(&config, "node_desktop_1", "mac-desktop-3f9a", "rk_live_one");
    save(&node_file(&config), &saved).unwrap();
    assert_eq!(load(&config), Some(saved));
    assert_eq!(
        enrolled_name(folder.path(), &config.base_url, "mac-desktop"),
        "mac-desktop-3f9a"
    );
    // Not another machine's name, nor another origin's node.
    assert_eq!(
        enrolled_name(folder.path(), &config.base_url, "pc-desktop"),
        "pc-desktop"
    );
    assert_eq!(
        enrolled_name(folder.path(), "https://other.example", "mac-desktop"),
        "mac-desktop"
    );
}

/// (a) another computer of the same name in this workspace, and (b) this
/// computer's own node from an install whose `spawn-node.json` is gone:
/// either way nothing here can prove the node holding the name, so this
/// one takes an alternate, and every restart reuses it.
#[tokio::test]
async fn a_name_another_node_holds_enrolls_an_alternate_kept_across_restarts() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let config = config(&relaycast.base_url, folder.path());
    let (enrolled, requests) = tokio::join!(enroll_named(&config, None), async {
        vec![
            relaycast.answer(CONFLICT).await,
            relaycast.answer(ENROLLED).await,
        ]
    });
    let enrolled = enrolled.expect("enrolled under another name");
    assert_eq!(body(&requests[0])["name"], "mac-desktop");
    let alternate = body(&requests[1])["name"].as_str().unwrap().to_string();
    assert!(alternate.starts_with("mac-desktop-"), "{alternate}");
    assert!(named_for(&alternate, "mac-desktop"));
    // A new node: no proof of a node it does not have.
    assert!(!requests[1].contains("x-relaycast-node-token"));
    assert_eq!(enrolled.node_name, alternate);
    assert_eq!(enrolled.node_id, "node_desktop_new");
    // A restart takes the saved node as it is, asking Relaycast nothing.
    assert_eq!(saved(&config).await, Ok(Some(enrolled.clone())));
    assert_eq!(load(&config), Some(enrolled));
}

/// (c) the saved node, enrolled with another key, is not the one holding
/// its name in this workspace: a new node is enrolled, under an alternate.
#[tokio::test]
async fn a_saved_node_whose_name_another_node_holds_is_replaced_by_an_alternate() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let current = config(&relaycast.base_url, folder.path());
    let kept = enrollment(&current, "node_desktop_1", "mac-desktop", "rk_live_old");
    save(&node_file(&current), &kept).unwrap();
    let (found, asked) = tokio::join!(
        saved(&current),
        relaycast.answer((
            "200 OK",
            r#"{"ok":true,"data":{"id":"node_desktop_2","name":"mac-desktop"}}"#,
        ))
    );
    assert!(asked.starts_with("get /v1/nodes/mac-desktop "), "{asked}");
    assert_eq!(found, Ok(None));
    let (enrolled, requests) = tokio::join!(enroll_named(&current, None), async {
        vec![
            relaycast.answer(CONFLICT).await,
            relaycast.answer(ENROLLED).await,
        ]
    });
    let enrolled = enrolled.unwrap();
    assert!(named_for(&enrolled.node_name, "mac-desktop"));
    assert_ne!(enrolled.node_name, "mac-desktop");
    assert_eq!(body(&requests[1])["name"], enrolled.node_name.as_str());
    assert_eq!(load(&current), Some(enrolled));
}

/// #671: a new key for the same workspace keeps the node Relaycast lists
/// under its name, the alternate one included, before anything is enrolled.
#[tokio::test]
async fn a_new_key_keeps_the_node_under_its_alternate_name() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let current = config(&relaycast.base_url, folder.path());
    let kept = enrollment(
        &current,
        "node_desktop_1",
        "mac-desktop-3f9a",
        "rk_live_old",
    );
    save(&node_file(&current), &kept).unwrap();
    let (found, asked) = tokio::join!(
        saved(&current),
        relaycast.answer((
            "200 OK",
            r#"{"ok":true,"data":{"id":"node_desktop_1","name":"mac-desktop-3f9a"}}"#,
        ))
    );
    assert!(
        asked.starts_with("get /v1/nodes/mac-desktop-3f9a "),
        "{asked}"
    );
    let adopted = found.unwrap().expect("adopted");
    assert_eq!(adopted.node_id, "node_desktop_1");
    assert_eq!(adopted.node_name, "mac-desktop-3f9a");
    assert_eq!(adopted.token, kept.token);
    assert_eq!(load(&current), Some(adopted));
}

/// A rotation whose node Relaycast no longer has under its name, now
/// another node's: renamed under its own id, so its agents stay bound to it.
#[tokio::test]
async fn a_rotation_whose_name_another_node_took_renames_the_same_node() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let config = config(&relaycast.base_url, folder.path());
    let current = enrollment(&config, "node_desktop_1", "mac-desktop", "rk_live_one");
    save(&node_file(&config), &current).unwrap();
    let (rotated, requests) = tokio::join!(rotate(&config, &current), async {
        vec![
            relaycast.answer(CONFLICT).await,
            relaycast
                .answer((
                    "201 Created",
                    r#"{"ok":true,"data":{"id":"node_desktop_1","token":"nt_live_y"}}"#,
                ))
                .await,
        ]
    });
    let rotated = rotated.unwrap();
    assert_eq!(rotated.node_id, "node_desktop_1");
    assert!(named_for(&rotated.node_name, "mac-desktop"));
    assert_ne!(rotated.node_name, "mac-desktop");
    for request in &requests {
        assert_eq!(body(request)["node_id"], "node_desktop_1");
        assert!(request.contains("x-relaycast-node-token: nt_live_x"));
    }
    assert_eq!(body(&requests[1])["name"], rotated.node_name.as_str());
    // Another body under another key: not a replay of the refused one.
    let keys: Vec<_> = requests.iter().map(|r| idempotency_key(r)).collect();
    assert!(keys.iter().all(Option::is_some));
    assert_ne!(keys[0], keys[1]);
    assert_eq!(load(&config), Some(rotated));
}

/// A rename whose answer was lost is replayed as it was sent: the same
/// name under the same key, so Relaycast recognizes it.
#[tokio::test]
async fn a_rename_whose_answer_was_lost_is_replayed_with_its_name_and_key() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let config = config(&relaycast.base_url, folder.path());
    let current = enrollment(&config, "node_desktop_1", "mac-desktop", "rk_live_one");
    save(&node_file(&config), &current).unwrap();
    let (first, requests) = tokio::join!(rotate(&config, &current), async {
        vec![
            relaycast.answer(CONFLICT).await,
            relaycast
                .answer((
                    "400 Bad Request",
                    r#"{"ok":false,"error":{"code":"invalid_request","message":"lost"}}"#,
                ))
                .await,
        ]
    });
    assert!(first.is_err());
    let pending = read(&config).expect("the node is kept");
    assert_eq!(pending.node_id, "node_desktop_1");
    assert_eq!(body(&requests[1])["name"], pending.node_name.as_str());
    let (second, replayed) = tokio::join!(
        rotate(&config, &pending),
        relaycast.answer((
            "201 Created",
            r#"{"ok":true,"data":{"id":"node_desktop_1","token":"nt_live_y"}}"#,
        ))
    );
    assert_eq!(body(&replayed)["name"], body(&requests[1])["name"]);
    assert_eq!(idempotency_key(&replayed), idempotency_key(&requests[1]));
    assert_eq!(second.unwrap().node_name, pending.node_name);
}

/// An answer the node reads as lost: not one the SDK tries again itself.
const LOST: (&str, &str) = (
    "400 Bad Request",
    r#"{"ok":false,"error":{"code":"invalid_request","message":"lost"}}"#,
);
const PROOF_REQUIRED: (&str, &str) = (
    "409 Conflict",
    r#"{"ok":false,"error":{"code":"node_token_proof_required","message":"Node token changed before enrollment completed; retry with the current node token"}}"#,
);

/// A first enrollment asks for the same node on every attempt: its id is
/// saved before the first `POST`, so a failure does not have the next
/// attempt ask for another. Without an `Idempotency-Key`: Relaycast
/// replays only rotations, and refuses a key sent without the token.
#[tokio::test]
async fn a_first_enrollment_asks_for_the_same_node_without_a_key_until_answered() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let config = config(&relaycast.base_url, folder.path());
    let (first, request) = tokio::join!(enroll_named(&config, None), relaycast.answer(LOST));
    assert!(matches!(first, Err(Refused::Failed(_))), "{first:?}");
    let asked = pending(&config).expect("the node asked for is saved");
    assert_eq!(body(&request)["node_id"], asked.node_id.as_str());
    assert_eq!(body(&request)["name"], "mac-desktop");
    assert!(
        asked.node_id.starts_with("node_desktop_"),
        "{}",
        asked.node_id
    );
    // A new node: no proof of a node it does not have, and no key.
    assert!(!request.contains("x-relaycast-node-token"));
    assert_eq!(idempotency_key(&request), None);
    // Not this computer's node yet: nothing is sent as it, and nothing is
    // asked of Relaycast for it. Kept beside the enrollment, not as one.
    assert!(!node_file(&config).exists());
    assert_eq!(load(&config), None);
    assert_eq!(read(&config), None);
    assert_eq!(saved(&config).await, Ok(None));
    let (second, again) = tokio::join!(
        enroll_named(&config, None),
        relaycast.answer((
            "201 Created",
            r#"{"ok":true,"data":{"id":"node_desktop_new","token":"nt_live_new"}}"#,
        ))
    );
    assert_eq!(body(&again)["node_id"], asked.node_id.as_str());
    assert_eq!(idempotency_key(&again), None);
    assert!(!again.contains("x-relaycast-node-token"));
    let enrolled = second.unwrap();
    assert_eq!(enrolled.node_id, "node_desktop_new");
    assert_eq!(enrolled.token, Secret::new("nt_live_new".to_string()));
    assert_eq!(load(&config), Some(enrolled.clone()));
    assert_eq!(pending(&config), None);
    // A rotation of it is proved by the token and keyed, as before.
    let (rotated, rotation) = tokio::join!(
        rotate(&config, &enrolled),
        relaycast.answer((
            "201 Created",
            r#"{"ok":true,"data":{"id":"node_desktop_new","token":"nt_live_y"}}"#,
        ))
    );
    assert!(rotated.is_ok(), "{rotated:?}");
    assert!(rotation.contains("x-relaycast-node-token: nt_live_new"));
    assert!(idempotency_key(&rotation).is_some_and(|key| key.len() == 48));
}

/// The client never sends what Relaycast refuses before any lookup: a key
/// without the token. A Relaycast that refuses that enrolls the node, and
/// rotates it, as asked.
#[tokio::test]
async fn a_key_is_never_sent_without_the_token_relaycast_requires_for_it() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let config = config(&relaycast.base_url, folder.path());
    let (enrolled, requests) = tokio::join!(enroll_named(&config, None), async {
        vec![
            relaycast
                .answer_with(keyed_without_proof_refused(CONFLICT))
                .await,
            relaycast
                .answer_with(keyed_without_proof_refused(ENROLLED))
                .await,
        ]
    });
    let enrolled = enrolled.expect("enrolled, not refused for a key");
    assert_eq!(enrolled.node_id, "node_desktop_new");
    assert!(named_for(&enrolled.node_name, "mac-desktop"));
    for request in &requests {
        assert_eq!(idempotency_key(request), None, "{request}");
    }
    const ROTATED: (&str, &str) = (
        "201 Created",
        r#"{"ok":true,"data":{"id":"node_desktop_new","token":"nt_live_y"}}"#,
    );
    let (rotated, rotation) = tokio::join!(
        rotate(&config, &enrolled),
        relaycast.answer_with(keyed_without_proof_refused(ROTATED))
    );
    assert_eq!(rotated.unwrap().token, Secret::new("nt_live_y".to_string()));
    assert!(rotation.contains("x-relaycast-node-token: nt_live_new"));
    assert!(idempotency_key(&rotation).is_some());
}

/// A name refused is not asked for again in the series: the alternate is
/// saved with the node asked for, so a failure on the alternate leaves the
/// next attempt asking for the alternate, not the name another node holds.
#[tokio::test]
async fn a_name_another_node_holds_is_not_asked_for_again_after_a_failure_on_its_alternate() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let config = config(&relaycast.base_url, folder.path());
    let (first, requests) = tokio::join!(enroll_named(&config, None), async {
        vec![
            relaycast.answer(CONFLICT).await,
            relaycast.answer(LOST).await,
        ]
    });
    assert!(matches!(first, Err(Refused::Failed(_))), "{first:?}");
    let asked = pending(&config).expect("the node asked for is saved");
    let alternate = body(&requests[1])["name"].as_str().unwrap().to_string();
    assert!(named_for(&alternate, "mac-desktop") && alternate != "mac-desktop");
    assert_eq!(asked.node_name, alternate);
    // One of the series' alternates taken, counted across restarts.
    assert_eq!(asked.alternates, 1);
    // The same node under each name; a new node is never keyed.
    assert_eq!(body(&requests[0])["node_id"], asked.node_id.as_str());
    assert_eq!(body(&requests[1])["node_id"], asked.node_id.as_str());
    assert!(requests.iter().all(|r| idempotency_key(r).is_none()));
    let (second, again) = tokio::join!(enroll_named(&config, None), relaycast.answer(ENROLLED));
    assert_eq!(body(&again)["name"], alternate.as_str());
    assert_eq!(body(&again)["node_id"], asked.node_id.as_str());
    assert_eq!(idempotency_key(&again), None);
    assert_eq!(second.unwrap().node_name, alternate);
}

/// An id Relaycast already has a node under, whose token nothing here holds
/// (a first enrollment it completed whose answer was lost): a fresh id is
/// asked for under the same name. That node holds the name, offline; a
/// Relaycast that replaces an offline holder enrolls the fresh one under
/// it, and one that does not answers `node_name_conflict`, whereupon the
/// alternate follows as it would for any other holder.
#[tokio::test]
async fn an_id_relaycast_has_a_node_under_is_replaced_under_the_same_name() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let config = config(&relaycast.base_url, folder.path());
    let (first, request) = tokio::join!(enroll_named(&config, None), relaycast.answer(LOST));
    assert!(first.is_err());
    let asked = pending(&config).unwrap();
    assert_eq!(body(&request)["name"], "mac-desktop");
    let (enrolled, requests) = tokio::join!(enroll_named(&config, None), async {
        vec![
            relaycast.answer(PROOF_REQUIRED).await,
            relaycast.answer(CONFLICT).await,
            relaycast.answer(ENROLLED).await,
        ]
    });
    let enrolled = enrolled.unwrap();
    assert_eq!(enrolled.node_id, "node_desktop_new");
    // The lost answer's node, asked for again; then a fresh one under the
    // same name; then, that name refused, the fresh one under an alternate.
    assert_eq!(body(&requests[0])["node_id"], asked.node_id.as_str());
    assert_eq!(body(&requests[0])["name"], "mac-desktop");
    let fresh = body(&requests[1])["node_id"].as_str().unwrap().to_string();
    assert_ne!(fresh, asked.node_id);
    assert!(fresh.starts_with("node_desktop_"), "{fresh}");
    assert_eq!(body(&requests[1])["name"], "mac-desktop");
    assert_eq!(body(&requests[2])["node_id"], fresh.as_str());
    let next = body(&requests[2])["name"].as_str().unwrap().to_string();
    assert!(
        named_for(&next, "mac-desktop") && next != "mac-desktop",
        "{next}"
    );
    for request in &requests {
        assert!(!request.contains("x-relaycast-node-token"));
        assert_eq!(idempotency_key(request), None);
    }
    assert_eq!(enrolled.node_name, next);
    assert_eq!(load(&config), Some(enrolled));
    assert_eq!(pending(&config), None);
}

/// An id another node has (`node_id_conflict`): a fresh one is asked for
/// under the same name, which did not conflict.
#[tokio::test]
async fn an_id_another_node_has_is_replaced_under_the_same_name() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let config = config(&relaycast.base_url, folder.path());
    const ID_CONFLICT: (&str, &str) = (
        "409 Conflict",
        r#"{"ok":false,"error":{"code":"node_id_conflict","message":"Node id is already enrolled"}}"#,
    );
    let (enrolled, requests) = tokio::join!(enroll_named(&config, None), async {
        vec![
            relaycast.answer(ID_CONFLICT).await,
            relaycast.answer(ENROLLED).await,
        ]
    });
    assert_eq!(enrolled.unwrap().node_id, "node_desktop_new");
    assert_ne!(body(&requests[0])["node_id"], body(&requests[1])["node_id"]);
    assert_eq!(body(&requests[0])["name"], "mac-desktop");
    assert_eq!(body(&requests[1])["name"], "mac-desktop");
    assert_eq!(pending(&config), None);
}

/// A pending node persisted under an alternate (taken after a conflict in
/// this series) is asked for as it is: the alternate, not the base name.
#[tokio::test]
async fn a_pending_alternate_is_asked_for_as_it_is() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let config = config(&relaycast.base_url, folder.path());
    let asked = Pending::new(&config, "mac-desktop-3f9a");
    save_pending(&pending_file(&config), &asked).unwrap();
    let (enrolled, request) = tokio::join!(enroll_named(&config, None), relaycast.answer(ENROLLED));
    assert_eq!(body(&request)["node_id"], asked.node_id.as_str());
    assert_eq!(body(&request)["name"], "mac-desktop-3f9a");
    assert_eq!(enrolled.unwrap().node_name, "mac-desktop-3f9a");
}

/// The alternates a series may take are counted in the pending node, so a
/// restart does not start the count over: one that has taken them all is
/// refused once more, then gives up, rather than trying three more.
#[tokio::test]
async fn the_alternates_of_a_series_are_counted_across_restarts() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let config = config(&relaycast.base_url, folder.path());
    let asked = Pending {
        alternates: ALTERNATES,
        ..Pending::new(&config, "mac-desktop-3f9a")
    };
    save_pending(&pending_file(&config), &asked).unwrap();
    let (refused, request) = tokio::join!(enroll_named(&config, None), relaycast.answer(CONFLICT));
    assert!(matches!(refused, Err(Refused::NoName(_))), "{refused:?}");
    assert_eq!(body(&request)["name"], "mac-desktop-3f9a");
    assert!(
        tokio::time::timeout(Duration::from_millis(300), relaycast.listener.accept())
            .await
            .is_err()
    );
    assert_eq!(pending(&config), None);
}

/// The saved node of another key, not the holder of its name here, stays
/// on disk until a new node replaces it: an enrollment that fails before
/// Relaycast answers loses nothing.
#[tokio::test]
async fn another_keys_node_is_kept_until_a_new_one_is_enrolled() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let current = config(&relaycast.base_url, folder.path());
    let kept = enrollment(&current, "node_desktop_1", "mac-desktop", "rk_live_old");
    save(&node_file(&current), &kept).unwrap();
    let (found, _) = tokio::join!(
        saved(&current),
        relaycast.answer((
            "200 OK",
            r#"{"ok":true,"data":{"id":"node_desktop_2","name":"mac-desktop"}}"#,
        ))
    );
    assert_eq!(found, Ok(None));
    let (first, _) = tokio::join!(enroll_named(&current, None), relaycast.answer(LOST));
    assert!(first.is_err());
    assert_eq!(read(&current), Some(kept));
    assert!(pending(&current).is_some());
    let (second, _) = tokio::join!(enroll_named(&current, None), relaycast.answer(ENROLLED));
    let enrolled = second.unwrap();
    assert_eq!(read(&current), Some(enrolled.clone()));
    assert_eq!(load(&current), Some(enrolled));
    assert_eq!(pending(&current), None);
}

/// A rotation's key Relaycast refuses as a key: replaced once, and a
/// refusal of the new one is a failure to try again later, with the new
/// key kept so it is not sent again.
#[tokio::test]
async fn a_key_relaycast_refuses_is_replaced_once() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let config = config(&relaycast.base_url, folder.path());
    let current = enrollment(&config, "node_desktop_1", "mac-desktop", "rk_live_one");
    save(&node_file(&config), &current).unwrap();
    const KEY_REFUSED: (&str, &str) = (
        "400 Bad Request",
        r#"{"ok":false,"error":{"code":"node_rotation_idempotency_key_mismatch","message":"Idempotency-Key was used for another body"}}"#,
    );
    let (rotated, requests) = tokio::join!(rotate(&config, &current), async {
        vec![
            relaycast.answer(KEY_REFUSED).await,
            relaycast.answer(KEY_REFUSED).await,
        ]
    });
    assert!(matches!(rotated, Err(Refused::Failed(_))), "{rotated:?}");
    let keys: Vec<_> = requests.iter().map(|r| idempotency_key(r)).collect();
    assert!(keys
        .iter()
        .all(|key| key.as_ref().is_some_and(|k| k.len() == 48)));
    assert_ne!(keys[0], keys[1]);
    for request in &requests {
        assert_eq!(body(request)["name"], "mac-desktop");
        assert!(request.contains("x-relaycast-node-token: nt_live_x"));
    }
    let kept = read(&config).expect("the node is kept");
    assert_eq!(kept.token, current.token);
    assert_eq!(kept.rotation_key, keys[1]);
    let (again, replayed) = tokio::join!(
        rotate(&config, &kept),
        relaycast.answer((
            "201 Created",
            r#"{"ok":true,"data":{"id":"node_desktop_1","token":"nt_live_y"}}"#,
        ))
    );
    assert_eq!(idempotency_key(&replayed), keys[1]);
    assert_eq!(again.unwrap().rotation_key, None);
}

/// A pending node of another workspace, origin or name is not the one asked
/// for: a new one is.
#[test]
fn a_pending_node_is_asked_for_only_in_its_workspace_origin_and_name() {
    let folder = tempfile::tempdir().unwrap();
    let config = config("https://cast.example", folder.path());
    let asked = Pending::new(&config, "mac-desktop-3f9a");
    save_pending(&pending_file(&config), &asked).unwrap();
    assert_eq!(pending(&config), Some(asked));
    for other in [
        NodeConfig {
            workspace_key: Secret::new("rk_live_two".to_string()),
            ..config.clone()
        },
        NodeConfig {
            base_url: "https://other.example".into(),
            ..config.clone()
        },
        NodeConfig {
            node_name: "pc-desktop".into(),
            ..config.clone()
        },
    ] {
        assert_eq!(pending(&other), None);
    }
}

/// A recording host: each status, and each claim's node.
#[derive(Default)]
struct Recording {
    states: Mutex<Vec<SpawnStatus>>,
    claims: Mutex<Vec<String>>,
    changed: Arc<Notify>,
}

impl NodeHost for Recording {
    fn invoke(&self, _link: NodeLink, _invoke: Invoke) -> BoxFuture<'static, Value> {
        Box::pin(async { Value::Null })
    }
    fn inventory(&self, _node: &NodeInfo) -> Vec<InventoryAgent> {
        Vec::new()
    }
    fn deliver(&self, _agent: &str, _frame: Value) {}
    fn state(&self, status: SpawnStatus) {
        self.states.lock().unwrap().push(status);
    }
    fn advertisement(&self, _harnesses: &[HarnessId], repositories: &[String]) -> Advertisement {
        Advertisement {
            configured: Configured {
                max_agents: lifecycle::DEFAULT_MAX_AGENTS,
                machine: "mac".into(),
                teammates: false,
                repositories: repositories.to_vec(),
                harnesses: Vec::new(),
            },
            live: Live {
                observed_at: lifecycle::iso(chrono::Utc::now()),
                slots: Default::default(),
                work: Default::default(),
                resources: resources::Resources::default(),
                agents: Vec::new(),
                reclaimed: Vec::new(),
            },
        }
    }
    fn heartbeat_sent(&self) {}
    fn claim(&self, node: &NodeInfo, _token: &Secret) {
        self.claims.lock().unwrap().push(node.node_name.clone());
    }
    fn changed(&self) -> Arc<Notify> {
        self.changed.clone()
    }
}

async fn until(host: &Recording, done: impl Fn(&[SpawnStatus]) -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !done(&host.states.lock().unwrap()) {
        assert!(std::time::Instant::now() < deadline, "no such status");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn the_node_registers_claims_and_reports_under_the_name_it_enrolled_with() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let config = config(&relaycast.base_url, folder.path());
    let host = Arc::new(Recording::default());
    let node = SpawnNode::start(config.clone(), host.clone());
    relaycast.answer(CONFLICT).await;
    let alternate = body(&relaycast.answer(ENROLLED).await)["name"]
        .as_str()
        .unwrap()
        .to_string();
    let (stream, _) = relaycast.listener.accept().await.unwrap();
    let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
    let register = loop {
        let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        if let Message::Text(text) = message {
            break serde_json::from_str::<Value>(&text).unwrap();
        }
    };
    assert_eq!(register["type"], "node.register");
    assert_eq!(register["name"], alternate.as_str());
    assert_eq!(register["node_id"], "node_desktop_new");
    assert_eq!(*host.claims.lock().unwrap(), [alternate.clone()]);
    socket
        .send(Message::Text(
            json!({"v": 1, "id": register["id"], "type": "reply", "ok": true}).to_string(),
        ))
        .await
        .unwrap();
    until(&host, |states| {
        states.iter().any(|s| s.state == SpawnState::Live)
    })
    .await;
    let live = host
        .states
        .lock()
        .unwrap()
        .iter()
        .find(|s| s.state == SpawnState::Live)
        .cloned()
        .unwrap();
    assert_eq!(live.node_name.as_deref(), Some(alternate.as_str()));
    // The configuration still names the machine's own name: the node is
    // not restarted for having another.
    assert_eq!(node.config(), &config);
    node.stop().await;
}

#[tokio::test]
async fn a_name_no_alternate_frees_stops_the_node_and_says_so() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let config = config(&relaycast.base_url, folder.path());
    let host = Arc::new(Recording::default());
    let node = SpawnNode::start(config, host.clone());
    for _ in 0..=ALTERNATES {
        relaycast.answer(CONFLICT).await;
    }
    until(&host, |states| {
        states.iter().any(|s| s.state == SpawnState::Off)
    })
    .await;
    // Given up: no further enrollment is tried.
    assert!(
        tokio::time::timeout(Duration::from_millis(300), relaycast.listener.accept())
            .await
            .is_err()
    );
    let states = host.states.lock().unwrap().clone();
    let off = states.last().unwrap();
    assert_eq!(off.state, SpawnState::Off);
    let error = off.error.as_deref().unwrap();
    assert!(
        error.contains("other nodes in this workspace already use \"mac-desktop\""),
        "{error}"
    );
    assert!(error.contains("Turn Accept spawns from Agent Relay off and on"));
    assert!(!states.iter().any(|s| s.state == SpawnState::Waiting));
    assert!(!node_file(&host_config(folder.path())).exists());
    assert!(!pending_file(&host_config(folder.path())).exists());
    node.stop().await;
}

/// The socket refused for the workspace key (`workspace_expired`, as a
/// trial's is), and so the rotation: never the token, which is kept, with
/// the node, for when the workspace is back. Nothing is given up, however
/// many times in a row.
#[tokio::test]
async fn a_workspace_refused_keeps_the_node_and_its_token_and_tries_again() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let config = config(&relaycast.base_url, folder.path());
    let current = enrollment(&config, "node_desktop_1", "mac-desktop", "rk_live_one");
    save(&node_file(&config), &current).unwrap();
    let host = Arc::new(Recording::default());
    let node = SpawnNode::start(config.clone(), host.clone());
    const EXPIRED: (&str, &str) = (
        "401 Unauthorized",
        r#"{"ok":false,"error":{"code":"workspace_expired","message":"Workspace trial expired"}}"#,
    );
    for _ in 0..TOKEN_REFUSALS {
        let socket = relaycast.answer(EXPIRED).await;
        assert!(socket.starts_with("get "), "{socket}");
        let rotation = relaycast.answer(EXPIRED).await;
        assert!(rotation.starts_with("post /v1/nodes "), "{rotation}");
        assert!(rotation.contains("x-relaycast-node-token: nt_live_x"));
    }
    // Tried again after the backoff, as it was.
    let next = tokio::time::timeout(Duration::from_secs(30), relaycast.answer(EXPIRED))
        .await
        .expect("tried again");
    assert!(next.starts_with("get "), "{next}");
    let states = host.states.lock().unwrap().clone();
    assert!(!states.iter().any(|s| s.state == SpawnState::Off));
    assert!(states.iter().any(|s| s.state == SpawnState::Waiting));
    let kept = load(&config).expect("the node is kept");
    assert_eq!(kept.node_id, current.node_id);
    assert_eq!(kept.token, current.token);
    node.stop().await;
}

/// A token Relaycast no longer takes as proof (the socket refused, the
/// rotation refused as `node_token_proof_required` `TOKEN_REFUSALS` times
/// in a row): the node stops and says so, and the enrollment is
/// forgotten, so the next start enrolls a new node rather than asking with
/// the dead token forever.
#[tokio::test]
async fn a_token_refused_as_proof_three_times_stops_the_node_and_forgets_the_enrollment() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let config = config(&relaycast.base_url, folder.path());
    let current = enrollment(&config, "node_desktop_1", "mac-desktop", "rk_live_one");
    save(&node_file(&config), &current).unwrap();
    let host = Arc::new(Recording::default());
    let node = SpawnNode::start(config.clone(), host.clone());
    const INVALID: (&str, &str) = (
        "401 Unauthorized",
        r#"{"ok":false,"error":{"code":"invalid_token","message":"invalid token"}}"#,
    );
    let mut rotations = Vec::new();
    for _ in 0..TOKEN_REFUSALS {
        let socket = relaycast.answer(INVALID).await;
        assert!(socket.starts_with("get "), "{socket}");
        rotations.push(relaycast.answer(PROOF_REQUIRED).await);
    }
    for rotation in &rotations {
        assert!(rotation.starts_with("post /v1/nodes "), "{rotation}");
        assert_eq!(body(rotation)["node_id"], "node_desktop_1");
        assert!(rotation.contains("x-relaycast-node-token: nt_live_x"));
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while !host
        .states
        .lock()
        .unwrap()
        .iter()
        .any(|s| s.state == SpawnState::Off)
    {
        assert!(
            std::time::Instant::now() < deadline,
            "the node did not stop"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // Given up: no further rotation is tried.
    assert!(
        tokio::time::timeout(Duration::from_millis(300), relaycast.listener.accept())
            .await
            .is_err()
    );
    let states = host.states.lock().unwrap().clone();
    let off = states.last().unwrap();
    assert_eq!(off.state, SpawnState::Off);
    let error = off.error.as_deref().unwrap();
    assert!(
        error.starts_with("Agent Relay no longer accepts this computer's node token."),
        "{error}"
    );
    assert!(
        error.contains("Turn Accept spawns from Agent Relay off and on"),
        "{error}"
    );
    assert!(error.contains("sign in again"), "{error}");
    // Each refusal before the last was said while waiting to try again.
    let waits: Vec<&SpawnStatus> = states
        .iter()
        .filter(|s| s.state == SpawnState::Waiting)
        .collect();
    assert_eq!(waits.len(), TOKEN_REFUSALS as usize - 1);
    for wait in waits {
        let error = wait.error.as_deref().unwrap();
        assert!(
            error.contains("no longer accepts this computer's node token"),
            "{error}"
        );
    }
    // Forgotten: the next start enrolls a new node.
    assert!(!node_file(&config).exists());
    assert_eq!(saved(&config).await, Ok(None));
    node.stop().await;
}

fn host_config(directory: &Path) -> NodeConfig {
    config("http://unused", directory)
}

// ---------------------------------------------------------------------------
// A node-scoped credential: node lookup and enrolment go to Control's broker.

const NODE_KEY: &str = "sh_wk_fixture0123456789";

fn node_scoped(relaycast: &str, control: &str, directory: &Path) -> NodeConfig {
    NodeConfig {
        workspace_key: Secret::new(NODE_KEY.to_string()),
        control_url: Some(control.to_string()),
        ..config(relaycast, directory)
    }
}

/// Nothing reached `server` for a moment.
async fn untouched(server: &Scripted) -> bool {
    tokio::time::timeout(Duration::from_millis(300), server.listener.accept())
        .await
        .is_err()
}

/// A rotation under a node credential goes to
/// `<control_url>/relay-node/v1/nodes` with both headers and the credential
/// as bearer, never to Relaycast; the node keeps Relaycast as its origin.
#[tokio::test]
async fn a_node_credential_enrolls_through_the_control_broker() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let control = Scripted::new().await;
    let config = node_scoped(&relaycast.base_url, &control.base_url, folder.path());
    let current = enrollment(&config, "node_desktop_1", "mac-desktop", NODE_KEY);
    save(&node_file(&config), &current).unwrap();
    let (rotated, request) = tokio::join!(
        rotate(&config, &current),
        control.answer((
            "201 Created",
            r#"{"ok":true,"data":{"id":"node_desktop_1","token":"nt_live_y"}}"#,
        ))
    );
    assert!(
        request.starts_with("post /relay-node/v1/nodes "),
        "{request}"
    );
    assert!(request.contains("x-relaycast-node-token: nt_live_x"));
    assert!(idempotency_key(&request).is_some());
    assert!(request.contains(&format!("authorization: bearer {NODE_KEY}")));
    assert_eq!(body(&request)["name"], "mac-desktop");
    let rotated = rotated.unwrap();
    assert_eq!(rotated.base_url, relaycast.base_url);
    assert_eq!(load(&config), Some(rotated));
    assert!(untouched(&relaycast).await);
}

/// The same rotation under a workspace key goes to Relaycast, whatever
/// Control origin is recorded beside it.
#[tokio::test]
async fn a_workspace_key_enrolls_at_relaycast() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let control = Scripted::new().await;
    let config = NodeConfig {
        control_url: Some(control.base_url.clone()),
        ..config(&relaycast.base_url, folder.path())
    };
    let current = enrollment(&config, "node_desktop_1", "mac-desktop", "rk_live_one");
    save(&node_file(&config), &current).unwrap();
    let (rotated, request) = tokio::join!(
        rotate(&config, &current),
        relaycast.answer((
            "201 Created",
            r#"{"ok":true,"data":{"id":"node_desktop_1","token":"nt_live_y"}}"#,
        ))
    );
    assert!(request.starts_with("post /v1/nodes "), "{request}");
    assert!(request.contains("x-relaycast-node-token: nt_live_x"));
    assert!(idempotency_key(&request).is_some());
    rotated.unwrap();
    assert!(untouched(&control).await);
}

/// A node enrolled under the workspace key is kept when the key is rotated
/// to a node credential for the same workspace: Control's broker lists its
/// id under its name, so it is adopted, not enrolled again, and the saved
/// record's fingerprint follows the new credential.
#[tokio::test]
async fn a_rotation_to_a_node_credential_keeps_the_enrolled_node() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let control = Scripted::new().await;
    let config = node_scoped(&relaycast.base_url, &control.base_url, folder.path());
    let kept = enrollment(&config, "node_desktop_1", "mac-desktop", "rk_live_old");
    save(&node_file(&config), &kept).unwrap();
    assert_eq!(load(&config), None);
    let (found, asked) = tokio::join!(
        saved(&config),
        control.answer((
            "200 OK",
            r#"{"ok":true,"data":{"id":"node_desktop_1","name":"mac-desktop"}}"#,
        ))
    );
    assert!(
        asked.starts_with("get /relay-node/v1/nodes/mac-desktop "),
        "{asked}"
    );
    let adopted = found.unwrap().expect("adopted");
    assert_eq!(adopted.node_id, "node_desktop_1");
    assert_eq!(adopted.token, kept.token);
    assert_eq!(load(&config), Some(adopted));
    assert!(untouched(&relaycast).await);
}

/// A node credential bound to another node name: the node does not start,
/// says which node is configured, and never names the credential.
#[tokio::test]
async fn a_node_credential_for_another_node_stops_the_node_and_says_so() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let control = Scripted::new().await;
    let config = node_scoped(&relaycast.base_url, &control.base_url, folder.path());
    let host = Arc::new(Recording::default());
    let node = SpawnNode::start(config, host.clone());
    let request = control
        .answer((
            "403 Forbidden",
            r#"{"ok":false,"error":{"code":"node_mismatch","message":"name differs"}}"#,
        ))
        .await;
    assert!(
        request.starts_with("post /relay-node/v1/nodes "),
        "{request}"
    );
    until(&host, |states| {
        states.iter().any(|s| s.state == SpawnState::Off)
    })
    .await;
    // Given up: no alternate and no retry.
    assert!(untouched(&control).await);
    let states = host.states.lock().unwrap().clone();
    let error = states.last().unwrap().error.clone().unwrap();
    assert!(error.contains("bound to another node name"), "{error}");
    assert!(error.contains("\"mac-desktop\""), "{error}");
    assert!(!error.contains("sh_wk_"), "{error}");
    assert!(!states.iter().any(|s| s.state == SpawnState::Waiting));
    node.stop().await;
}

/// A name another node holds, under a node credential: Control's broker
/// passes Relaycast's `409 node_name_conflict` through, and the credential
/// is bound to the name, so no alternate is asked for (the broker would
/// refuse it as `node_mismatch`). The node reports the stale holder.
#[tokio::test]
async fn a_name_another_node_holds_is_reported_under_a_node_credential() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let control = Scripted::new().await;
    let config = node_scoped(&relaycast.base_url, &control.base_url, folder.path());
    let (refused, request) = tokio::join!(enroll_named(&config, None), control.answer(CONFLICT));
    assert!(
        request.starts_with("post /relay-node/v1/nodes "),
        "{request}"
    );
    assert_eq!(body(&request)["name"], "mac-desktop");
    let Err(Refused::NameTaken(reason)) = refused else {
        panic!("{refused:?}");
    };
    assert!(reason.contains("stale node"), "{reason}");
    assert!(reason.contains("\"mac-desktop\""), "{reason}");
    assert!(!reason.contains("sh_wk_"), "{reason}");
    // No second POST /v1/nodes under an alternate.
    assert!(untouched(&control).await);
    assert!(untouched(&relaycast).await);
}

/// The same for a rotation under a node credential: no alternate.
#[tokio::test]
async fn a_rotation_whose_name_another_node_took_is_reported_under_a_node_credential() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let control = Scripted::new().await;
    let config = node_scoped(&relaycast.base_url, &control.base_url, folder.path());
    let current = enrollment(&config, "node_desktop_1", "mac-desktop", NODE_KEY);
    save(&node_file(&config), &current).unwrap();
    let (refused, request) = tokio::join!(
        enroll_named(&config, Some(&current)),
        control.answer(CONFLICT)
    );
    assert!(
        request.starts_with("post /relay-node/v1/nodes "),
        "{request}"
    );
    let Err(Refused::NameTaken(reason)) = refused else {
        panic!("{refused:?}");
    };
    assert!(reason.contains("\"mac-desktop\""), "{reason}");
    assert!(untouched(&control).await);
}

/// A node saved under an alternate name (taken under a workspace key) is
/// not adopted under a node credential, which is bound to the configured
/// name: nothing is asked of the broker for it, a new node is enrolled
/// under the configured name, and a stale holder of that name is reported
/// as one, naming the saved node and the configured name.
#[tokio::test]
async fn a_saved_alternate_is_not_adopted_under_a_node_credential() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let control = Scripted::new().await;
    let config = node_scoped(&relaycast.base_url, &control.base_url, folder.path());
    let kept = enrollment(&config, "node_desktop_1", "mac-desktop-3f9a", "rk_live_old");
    save(&node_file(&config), &kept).unwrap();
    assert_eq!(saved(&config).await, Ok(None));
    assert!(untouched(&control).await);
    let (refused, request) = tokio::join!(enroll_named(&config, None), control.answer(CONFLICT));
    assert!(
        request.starts_with("post /relay-node/v1/nodes "),
        "{request}"
    );
    assert_eq!(body(&request)["name"], "mac-desktop");
    let Err(Refused::NameTaken(reason)) = refused else {
        panic!("{refused:?}");
    };
    assert!(reason.contains("stale node"), "{reason}");
    assert!(reason.contains("\"mac-desktop-3f9a\""), "{reason}");
    assert!(
        reason.contains("bound to the configured node name \"mac-desktop\""),
        "{reason}"
    );
    assert!(!reason.contains("sh_wk_"), "{reason}");
    // The saved node is kept until a new one is enrolled.
    assert_eq!(read(&config), Some(kept));
    assert!(untouched(&control).await);
    assert!(untouched(&relaycast).await);
}

/// The broker's `403 node_mismatch` for the saved node's name is kept as
/// `NodeMismatch` by `saved`, and the node stops and says so, as it does
/// for a new enrollment, rather than retrying forever.
#[tokio::test]
async fn a_saved_node_whose_credential_is_for_another_name_stops_the_node() {
    let folder = tempfile::tempdir().unwrap();
    let relaycast = Scripted::new().await;
    let control = Scripted::new().await;
    let config = node_scoped(&relaycast.base_url, &control.base_url, folder.path());
    let kept = enrollment(&config, "node_desktop_1", "mac-desktop", "rk_live_old");
    save(&node_file(&config), &kept).unwrap();
    const MISMATCH: (&str, &str) = (
        "403 Forbidden",
        r#"{"ok":false,"error":{"code":"node_mismatch","message":"name differs"}}"#,
    );
    let (found, asked) = tokio::join!(saved(&config), control.answer(MISMATCH));
    assert!(
        asked.starts_with("get /relay-node/v1/nodes/mac-desktop "),
        "{asked}"
    );
    let Err(Refused::NodeMismatch(reason)) = found else {
        panic!("{found:?}");
    };
    assert!(reason.contains("bound to another node name"), "{reason}");

    let host = Arc::new(Recording::default());
    let node = SpawnNode::start(config, host.clone());
    let asked = control.answer(MISMATCH).await;
    assert!(
        asked.starts_with("get /relay-node/v1/nodes/mac-desktop "),
        "{asked}"
    );
    until(&host, |states| {
        states.iter().any(|s| s.state == SpawnState::Off)
    })
    .await;
    // Given up: no retry.
    assert!(untouched(&control).await);
    let states = host.states.lock().unwrap().clone();
    let error = states.last().unwrap().error.clone().unwrap();
    assert!(error.contains("bound to another node name"), "{error}");
    assert!(error.contains("\"mac-desktop\""), "{error}");
    assert!(!error.contains("sh_wk_"), "{error}");
    assert!(!states.iter().any(|s| s.state == SpawnState::Waiting));
    node.stop().await;
}
