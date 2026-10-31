use super::*;
use futures_util::future::BoxFuture;
use std::sync::{Arc, Mutex};

/// One request Cloud read: method, path under `/cloud/api/v1`, JSON body and
/// the `Authorization` header.
type Request = (String, String, Option<Value>, String);

/// Cloud over HTTP, as the claim sees it: whose the held credential is
/// (`/auth/whoami`), one scripted answer for every claim, and the requests
/// made (method, path under `/cloud/api/v1`, body, bearer). Nothing goes
/// through `CloudAccess::request`: a claim only uses the held credential.
pub(crate) struct FakeCloud {
    site: String,
    pub(crate) account: Mutex<Option<CloudAccount>>,
    pub(crate) answer: Arc<Mutex<Result<Value, CloudError>>>,
    /// The user the credential belongs to; `None` refuses it.
    pub(crate) me: Arc<Mutex<Option<String>>>,
    /// Cloud refuses the held bearer until it is renewed.
    pub(crate) stale: Arc<Mutex<bool>>,
    pub(crate) requests: Arc<Mutex<Vec<Request>>>,
}

impl FakeCloud {
    pub(crate) fn answering(answer: Result<Value, CloudError>) -> FakeCloud {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let cloud = FakeCloud {
            site: format!("http://{}", listener.local_addr().unwrap()),
            account: Mutex::new(Some(account("user_me"))),
            answer: Arc::new(Mutex::new(answer)),
            me: Arc::new(Mutex::new(Some("user_me".into()))),
            stale: Arc::default(),
            requests: Arc::default(),
        };
        let (answer, me, stale, requests) = (
            cloud.answer.clone(),
            cloud.me.clone(),
            cloud.stale.clone(),
            cloud.requests.clone(),
        );
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let Some((method, path, body, bearer)) = read_request(&mut stream) else {
                    continue;
                };
                let refused = *stale.lock().unwrap() && bearer == "Bearer Bearer-held";
                let reply = if refused {
                    Err(CloudError::Rejected)
                } else if path == "/auth/whoami" {
                    match me.lock().unwrap().clone() {
                        Some(id) => Ok(json!({"user": {"id": id, "email": "me@example.com"}})),
                        None => Err(CloudError::Rejected),
                    }
                } else {
                    answer.lock().unwrap().clone()
                };
                requests.lock().unwrap().push((method, path, body, bearer));
                let (status, body) = match reply {
                    Ok(body) => (200, body),
                    Err(CloudError::Status { status, message }) => {
                        (status, json!({"error": message}))
                    }
                    Err(CloudError::Rejected | CloudError::SignedOut) => {
                        (401, json!({"error": "Unauthorized"}))
                    }
                    Err(CloudError::Unreachable) => (503, json!({})),
                };
                write_response(&mut stream, status, &body);
            }
        });
        cloud
    }

    /// Claims asked for.
    pub(crate) fn asked(&self) -> usize {
        self.claims().len()
    }

    fn claims(&self) -> Vec<Request> {
        let requests = self.requests.lock().unwrap();
        requests
            .iter()
            .filter(|(_, path, _, _)| path == "/fleet/nodes/claim")
            .cloned()
            .collect()
    }

    fn signs_in_as(&self, user: &str) {
        *self.account.lock().unwrap() = Some(account(user));
        *self.me.lock().unwrap() = Some(user.into());
    }
}

/// One request: method, path under `/cloud/api/v1`, JSON body and bearer.
fn read_request(stream: &mut std::net::TcpStream) -> Option<Request> {
    use std::io::Read;
    let mut request = Vec::new();
    let mut buffer = [0_u8; 4096];
    let (head, length) = loop {
        let read = stream.read(&mut buffer).ok()?;
        if read == 0 {
            return None;
        }
        request.extend_from_slice(&buffer[..read]);
        let text = String::from_utf8_lossy(&request).to_string();
        if let Some(end) = text.find("\r\n\r\n") {
            let length = text
                .to_lowercase()
                .lines()
                .find_map(|l| l.strip_prefix("content-length: ").map(str::to_string))
                .and_then(|l| l.trim().parse::<usize>().ok())
                .unwrap_or(0);
            while request.len() < end + 4 + length {
                let read = stream.read(&mut buffer).ok()?;
                request.extend_from_slice(&buffer[..read]);
            }
            break (text[..end].to_string(), length);
        }
    };
    let mut words = head.split_whitespace();
    let method = words.next()?.to_string();
    let path = words.next()?.strip_prefix("/cloud/api/v1")?.to_string();
    let bearer = head
        .lines()
        .find_map(|l| {
            let (name, value) = l.split_once(':')?;
            (name.eq_ignore_ascii_case("authorization")).then(|| value.trim().to_string())
        })
        .unwrap_or_default();
    let body = (length > 0)
        .then(|| serde_json::from_slice(&request[request.len() - length..]).ok())
        .flatten();
    Some((method, path, body, bearer))
}

fn write_response(stream: &mut std::net::TcpStream, status: u16, body: &Value) {
    use std::io::Write;
    let body = body.to_string();
    let _ = write!(
        stream,
        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
}

impl CloudAccess for FakeCloud {
    fn account(&self) -> Option<CloudAccount> {
        let account = self.account.lock().unwrap().clone()?;
        Some(CloudAccount {
            site_url: self.site.clone(),
            ..account
        })
    }

    fn agent_owner(&self) -> Option<crate::relay::cloud_session::AgentOwner> {
        None
    }

    fn request(
        &self,
        _method: &'static str,
        path: String,
        _body: Option<Value>,
    ) -> BoxFuture<'_, Result<Value, CloudError>> {
        panic!("a claim goes out only with the held credential, never {path}")
    }

    fn credential(&self, refused: Option<Secret>) -> BoxFuture<'_, Option<(String, Secret)>> {
        let bearer = if refused.is_some() {
            "Bearer-renewed"
        } else {
            "Bearer-held"
        };
        let held = self
            .account()
            .map(|account| (account.site_url, Secret::new(bearer.to_string())));
        Box::pin(async move { held })
    }
}

pub(crate) fn account(user: &str) -> CloudAccount {
    CloudAccount {
        site_url: "https://agentrelay.com".into(),
        workspace_id: "8d1c6f2e-7b1a-4c55-9a0e-3f1b2c4d5e6f".into(),
        user_id: Some(user.into()),
    }
}

/// Cloud's refusal of a node someone else owns (`claimNode`).
pub(crate) fn owned_elsewhere() -> CloudError {
    CloudError::Status {
        status: 409,
        message: Some(
            "Another person owns this node. They, or a workspace owner, must release it first."
                .into(),
        ),
    }
}

fn node_named(id: &str) -> NodeInfo {
    NodeInfo {
        node_id: id.into(),
        node_name: "test-desk-desktop".into(),
    }
}

fn node() -> NodeInfo {
    node_named("node_desktop_1")
}

fn token(value: &str) -> Secret {
    Secret::new(format!("nt_live_{value}"))
}

const NOW: i64 = 1_800_000_000_000;

/// One check as the core makes it: `next`, then the ask it calls for.
async fn check(
    cloud: &FakeCloud,
    dir: &Path,
    memory: &mut Memory,
    token: &Secret,
    now: i64,
) -> Option<(SpawnClaim, bool)> {
    let (claim, blocked) = match next(dir, &node(), token, cloud.account(), memory, now) {
        Next::Unchanged => return None,
        Next::Settled(claim, blocked) => {
            memory.settled();
            (claim, blocked)
        }
        Next::Ask(asked, blocked) => {
            memory.begin(asked.clone());
            let answer = ask(cloud, &asked, token).await;
            memory.settle(dir, asked, answer, blocked, now).unwrap()
        }
    };
    memory.status = Some(claim.clone());
    memory.blocked = blocked;
    Some((claim, blocked))
}

fn claimed() -> Option<(SpawnClaim, bool)> {
    Some((status(SpawnClaimState::Claimed, None), false))
}

#[tokio::test]
async fn a_claim_is_asked_once_per_token_and_account() {
    let folder = tempfile::tempdir().unwrap();
    let cloud = FakeCloud::answering(Ok(
        json!({"nodeId": "node_desktop_1", "claimed": true, "owner": "you"}),
    ));
    let dir = folder.path();
    let mut memory = Memory::default();
    let first = check(&cloud, dir, &mut memory, &token("one1one1"), NOW).await;
    assert_eq!(first, claimed());
    let requests = cloud.requests.lock().unwrap().clone();
    // One held credential for both: never another person's.
    assert!(
        requests.iter().all(|r| r.3 == "Bearer Bearer-held"),
        "{requests:?}"
    );
    // Whose the credential is, then the claim with the node's token.
    assert_eq!(requests[0].0, "GET");
    assert_eq!(requests[0].1, "/auth/whoami");
    assert_eq!(requests[1].0, "POST");
    assert_eq!(requests[1].1, "/fleet/nodes/claim");
    assert_eq!(
        requests[1].2,
        Some(
            json!({"workspaceId": "8d1c6f2e-7b1a-4c55-9a0e-3f1b2c4d5e6f",
            "nodeToken": "nt_live_one1one1"})
        )
    );
    // Kept on disk without the token: a restart does not ask again.
    let kept = std::fs::read_to_string(dir.join(CLAIM_FILE)).unwrap();
    assert!(!kept.contains("one1one1"), "{kept}");
    let mut restarted = Memory::default();
    let again = check(&cloud, dir, &mut restarted, &token("one1one1"), NOW).await;
    assert_eq!(again, claimed());
    assert_eq!(cloud.asked(), 1);
    // A new token (a rotation or an enrollment) asks again, as does another
    // account.
    check(&cloud, dir, &mut restarted, &token("two2two2"), NOW).await;
    assert_eq!(cloud.asked(), 2);
    cloud.signs_in_as("user_other");
    check(&cloud, dir, &mut restarted, &token("two2two2"), NOW).await;
    assert_eq!(cloud.asked(), 3);
}

#[tokio::test]
async fn a_node_already_mine_is_claimed() {
    let folder = tempfile::tempdir().unwrap();
    let cloud = FakeCloud::answering(Ok(
        json!({"nodeId": "node_desktop_1", "claimed": false, "owner": "you"}),
    ));
    let mut memory = Memory::default();
    let answer = check(&cloud, folder.path(), &mut memory, &token("one1one1"), NOW).await;
    assert_eq!(answer, claimed());
}

#[tokio::test]
async fn a_node_another_account_owns_takes_no_spawns_until_claimed() {
    let folder = tempfile::tempdir().unwrap();
    let dir = folder.path();
    let cloud = FakeCloud::answering(Err(owned_elsewhere()));
    let mut memory = Memory::default();
    let one = token("one1one1");
    let (claim, blocked) = check(&cloud, dir, &mut memory, &one, NOW).await.unwrap();
    assert_eq!(claim.state, SpawnClaimState::OwnedByOther);
    assert_eq!(claim.note.as_deref(), Some(OWNED_BY_OTHER));
    assert!(OWNED_BY_OTHER.starts_with("This computer's spawn node belongs to another account."));
    assert!(blocked);
    // Not asked again before `RETRY_MS`, even after a restart.
    let owned = Some((answered_other(), true));
    assert_eq!(check(&cloud, dir, &mut memory, &one, NOW + 1).await, owned);
    let mut restarted = Memory::default();
    assert_eq!(
        check(&cloud, dir, &mut restarted, &one, NOW + 1).await,
        owned
    );
    assert_eq!(cloud.asked(), 1);
    // Then asked, still refusing spawns until Cloud answers.
    let later = NOW + RETRY_MS;
    assert!(matches!(
        next(dir, &node(), &one, cloud.account(), &restarted, later),
        Next::Ask(_, true)
    ));
    // Signed out, it stays refused.
    assert_eq!(
        next(dir, &node(), &one, None, &Memory::default(), NOW),
        Next::Settled(status(SpawnClaimState::SignedOut, Some(SIGNED_OUT)), true)
    );
    // Released and claimed: spawns again.
    *cloud.answer.lock().unwrap() = Ok(json!({"claimed": true, "owner": "you"}));
    let answer = check(&cloud, dir, &mut restarted, &one, later).await;
    assert_eq!(answer, claimed());
}

#[tokio::test]
async fn without_a_sign_in_nothing_is_asked() {
    let folder = tempfile::tempdir().unwrap();
    let dir = folder.path();
    let cloud = FakeCloud::answering(Ok(json!({})));
    *cloud.account.lock().unwrap() = None;
    let mut memory = Memory::default();
    let answer = check(&cloud, dir, &mut memory, &token("one1one1"), NOW).await;
    assert_eq!(
        answer,
        Some((status(SpawnClaimState::SignedOut, Some(SIGNED_OUT)), false))
    );
    assert!(cloud.requests.lock().unwrap().is_empty());
    // A claim made before signing out holds: ownership is the computer's.
    cloud.signs_in_as("user_me");
    check(&cloud, dir, &mut memory, &token("one1one1"), NOW).await;
    *cloud.account.lock().unwrap() = None;
    assert_eq!(
        next(dir, &node(), &token("one1one1"), None, &memory, NOW),
        Next::Settled(status(SpawnClaimState::Claimed, None), false)
    );
}

#[tokio::test]
async fn a_credential_that_is_someone_else_s_never_claims() {
    let folder = tempfile::tempdir().unwrap();
    let cloud = FakeCloud::answering(Ok(json!({"claimed": true, "owner": "you"})));
    // The app is signed in as user_me; the credential requests go out with
    // (an access token in the environment, the CLI's session) is Bob's.
    *cloud.me.lock().unwrap() = Some("user_bob".into());
    let mut memory = Memory::default();
    let (claim, blocked) = check(&cloud, folder.path(), &mut memory, &token("one1one1"), NOW)
        .await
        .unwrap();
    assert_eq!(claim, status(SpawnClaimState::Failed, Some(NOT_YOURS)));
    assert!(!blocked);
    assert_eq!(cloud.asked(), 0);
    assert!(!folder.path().join(CLAIM_FILE).exists());
    // A refused credential is a sign-in to make again.
    *cloud.me.lock().unwrap() = None;
    let answer = ask(&cloud, &memory.tried.clone().unwrap().0, &token("one1one1")).await;
    assert_eq!(answer.claim.state, SpawnClaimState::SignedOut);
}

#[tokio::test]
async fn an_answer_for_a_node_since_replaced_is_dropped() {
    let folder = tempfile::tempdir().unwrap();
    let dir = folder.path();
    let cloud = FakeCloud::answering(Err(owned_elsewhere()));
    let mut memory = Memory::default();
    let old = match next(
        dir,
        &node(),
        &token("one1one1"),
        cloud.account(),
        &memory,
        NOW,
    ) {
        Next::Ask(asked, _) => asked,
        other => panic!("{other:?}"),
    };
    memory.begin(old.clone());
    // The workspace changed meanwhile: a new node checks and asks at once.
    let replaced = node_named("node_desktop_2");
    let new = match next(
        dir,
        &replaced,
        &token("two2two2"),
        cloud.account(),
        &memory,
        NOW,
    ) {
        Next::Ask(asked, blocked) => {
            assert!(!blocked);
            asked
        }
        other => panic!("{other:?}"),
    };
    memory.begin(new);
    let late = ask(&cloud, &old, &token("one1one1")).await;
    assert_eq!(memory.settle(dir, old, late, false, NOW), None);
    assert!(
        !dir.join(CLAIM_FILE).exists(),
        "nothing kept for the old node"
    );
}

#[tokio::test]
async fn an_owner_that_cannot_be_written_still_blocks() {
    let folder = tempfile::tempdir().unwrap();
    let missing = folder.path().join("missing");
    let cloud = FakeCloud::answering(Err(owned_elsewhere()));
    let mut memory = Memory::default();
    let one = token("one1one1");
    let (_, blocked) = check(&cloud, &missing, &mut memory, &one, NOW)
        .await
        .unwrap();
    assert!(blocked);
    assert!(!missing.join(CLAIM_FILE).exists());
    assert_eq!(
        next(&missing, &node(), &one, None, &memory, NOW),
        Next::Settled(status(SpawnClaimState::SignedOut, Some(SIGNED_OUT)), true)
    );
}

#[test]
fn other_answers_neither_claim_nor_block() {
    let refused = answered(Err(CloudError::Status {
        status: 403,
        message: Some("You are not an active member of this workspace.".into()),
    }));
    assert_eq!(refused.claim.state, SpawnClaimState::Failed);
    assert_eq!(
        refused.claim.note.as_deref(),
        Some("Agent Relay did not record this computer's spawn node as yours: You are not an active member of this workspace.")
    );
    assert_eq!(refused.owner, None);
    assert!(!refused.limited);
    // Another 409 is not another owner.
    let busy = answered(Err(CloudError::Status {
        status: 409,
        message: Some(
            "This node is being claimed or released right now. Try again shortly.".into(),
        ),
    }));
    assert_eq!(busy.claim.state, SpawnClaimState::Failed);
    assert_eq!(busy.owner, None);
    let rejected = answered(Err(CloudError::Rejected));
    assert_eq!(rejected.claim.state, SpawnClaimState::SignedOut);
    assert_eq!(rejected.owner, None);
    assert_eq!(
        answered(Err(CloudError::Unreachable)).claim.state,
        SpawnClaimState::Failed
    );
    let limited = answered(Err(CloudError::Status {
        status: 429,
        message: Some("Rate limit exceeded".into()),
    }));
    assert!(limited.limited);
}

#[test]
fn a_sign_in_not_yet_known_waits() {
    let folder = tempfile::tempdir().unwrap();
    let unknown = CloudAccount {
        user_id: None,
        ..account("user_me")
    };
    assert_eq!(
        next(
            folder.path(),
            &node(),
            &token("one1one1"),
            Some(unknown),
            &Memory::default(),
            NOW
        ),
        Next::Settled(status(SpawnClaimState::Pending, None), false)
    );
}

/// Cloud over HTTP: answers each request in turn with its status and body,
/// and hands back the requests it read.
fn cloud_routes(
    answers: Vec<(&'static str, Value)>,
) -> (String, std::thread::JoinHandle<Vec<String>>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let site = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        answers
            .into_iter()
            .map(|(status, body)| {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = Vec::new();
                let mut buffer = [0_u8; 4096];
                loop {
                    let text = String::from_utf8_lossy(&request).to_string();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let length = text
                            .to_lowercase()
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length: ").map(str::to_string))
                            .and_then(|l| l.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                    let read = stream.read(&mut buffer).unwrap();
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                }
                let body = body.to_string();
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
                String::from_utf8_lossy(&request).to_string()
            })
            .collect()
    });
    (site, server)
}

/// The signed-in session's Cloud access, as `relay::account` makes its
/// requests.
struct Session(String);

impl CloudAccess for Session {
    fn account(&self) -> Option<CloudAccount> {
        Some(CloudAccount {
            site_url: self.0.clone(),
            ..account("user_me")
        })
    }

    fn agent_owner(&self) -> Option<crate::relay::cloud_session::AgentOwner> {
        None
    }

    fn request(
        &self,
        method: &'static str,
        path: String,
        body: Option<Value>,
    ) -> BoxFuture<'_, Result<Value, CloudError>> {
        Box::pin(async move {
            let bearer = Secret::new("cloud_access".to_string());
            crate::relay::cloud_session::api(&self.0, &bearer, method, &path, body).await
        })
    }

    fn credential(&self, _refused: Option<Secret>) -> BoxFuture<'_, Option<(String, Secret)>> {
        let held = (self.0.clone(), Secret::new("cloud_access".to_string()));
        Box::pin(async move { Some(held) })
    }
}

#[tokio::test]
async fn cloud_s_own_refusal_of_another_owner_is_read_as_one() {
    let folder = tempfile::tempdir().unwrap();
    let (site, server) = cloud_routes(vec![
        ("200 OK", json!({"data": {"user": {"id": "user_me"}}})),
        (
            "409 Conflict",
            json!({"error": "Another person owns this node. They, or a workspace owner, must release it first."}),
        ),
    ]);
    let cloud = Session(site);
    let one = token("one1one1");
    let asked = match next(
        folder.path(),
        &node(),
        &one,
        cloud.account(),
        &Memory::default(),
        NOW,
    ) {
        Next::Ask(asked, _) => asked,
        other => panic!("a first check asks: {other:?}"),
    };
    let answer = ask(&cloud, &asked, &one).await;
    assert_eq!(answer.claim.state, SpawnClaimState::OwnedByOther);
    assert_eq!(answer.owner, Some(Owner::Other));
    let requests = server.join().unwrap();
    assert!(
        requests[0].starts_with("GET /cloud/api/v1/auth/whoami "),
        "{}",
        requests[0]
    );
    let claim = &requests[1];
    assert!(
        claim.starts_with("POST /cloud/api/v1/fleet/nodes/claim "),
        "{claim}"
    );
    assert!(claim
        .to_lowercase()
        .contains("authorization: bearer cloud_access"));
    assert!(claim.contains("\"nodeToken\":\"nt_live_one1one1\""));
}

#[tokio::test]
async fn failures_back_off_and_the_rate_limit_waits_an_hour() {
    let folder = tempfile::tempdir().unwrap();
    let dir = folder.path();
    let cloud = FakeCloud::answering(Err(CloudError::Unreachable));
    let one = token("one1one1");
    let mut memory = Memory::default();
    // A minute, then two, four...: asked only once each wait passed.
    let mut at = NOW;
    for (failure, wait) in [(1, 1), (2, 2), (3, 4)] {
        let (claim, blocked) = check(&cloud, dir, &mut memory, &one, at).await.unwrap();
        assert_eq!(claim.state, SpawnClaimState::Failed);
        assert!(!blocked, "a failed claim never holds spawning up");
        assert_eq!(cloud.asked(), failure);
        let minutes = wait * 60 * 1000;
        assert_eq!(
            check(&cloud, dir, &mut memory, &one, at + minutes - 1).await,
            None
        );
        at += minutes;
    }
    assert_eq!(backoff(20), BACKOFF_MAX_MS);
    // Cloud's rate limit: an hour.
    *cloud.answer.lock().unwrap() = Err(CloudError::Status {
        status: 429,
        message: Some("Rate limit exceeded".into()),
    });
    check(&cloud, dir, &mut memory, &one, at).await.unwrap();
    let asked = cloud.asked();
    assert_eq!(
        check(&cloud, dir, &mut memory, &one, at + BACKOFF_MAX_MS - 1).await,
        None
    );
    assert_eq!(cloud.asked(), asked);
    // Claimed: the backoff is over.
    *cloud.answer.lock().unwrap() = Ok(json!({"claimed": true, "owner": "you"}));
    let answer = check(&cloud, dir, &mut memory, &one, at + BACKOFF_MAX_MS).await;
    assert_eq!(answer, claimed());
    assert_eq!(memory.failures, 0);
}

#[tokio::test]
async fn an_answer_known_without_asking_drops_a_claim_still_in_flight() {
    let folder = tempfile::tempdir().unwrap();
    let dir = folder.path();
    let cloud = FakeCloud::answering(Ok(json!({"claimed": true, "owner": "you"})));
    let one = token("one1one1");
    let mut memory = Memory::default();
    assert_eq!(check(&cloud, dir, &mut memory, &one, NOW).await, claimed());
    // Bob signs in and his claim goes out...
    cloud.signs_in_as("user_bob");
    let bobs = match next(dir, &node(), &one, cloud.account(), &memory, NOW) {
        Next::Ask(asked, _) => asked,
        other => panic!("{other:?}"),
    };
    memory.begin(bobs.clone());
    // ...Alice signs back in before it is answered: her claim stands...
    cloud.signs_in_as("user_me");
    assert_eq!(check(&cloud, dir, &mut memory, &one, NOW).await, claimed());
    // ...and Bob's late refusal changes nothing.
    let late = answered(Err(owned_elsewhere()));
    assert_eq!(memory.settle(dir, bobs, late, false, NOW), None);
    assert!(!memory.blocked);
    assert_eq!(check(&cloud, dir, &mut memory, &one, NOW).await, claimed());
}

#[tokio::test]
async fn a_sign_in_asks_again_at_once_after_no_sign_in_was_found() {
    let folder = tempfile::tempdir().unwrap();
    let dir = folder.path();
    let cloud = FakeCloud::answering(Ok(json!({"claimed": true, "owner": "you"})));
    *cloud.me.lock().unwrap() = None;
    let one = token("one1one1");
    let mut memory = Memory::default();
    let (claim, _) = check(&cloud, dir, &mut memory, &one, NOW).await.unwrap();
    assert_eq!(claim.state, SpawnClaimState::SignedOut);
    *cloud.me.lock().unwrap() = Some("user_me".into());
    assert_eq!(check(&cloud, dir, &mut memory, &one, NOW + 1).await, None);
    memory.forget_signed_out();
    assert_eq!(
        check(&cloud, dir, &mut memory, &one, NOW + 1).await,
        claimed()
    );
    // Another failure is not forgotten by a sign-in: it backs off.
    let mut failing = Memory::default();
    *cloud.answer.lock().unwrap() = Err(CloudError::Unreachable);
    check(&cloud, dir, &mut failing, &token("two2two2"), NOW).await;
    failing.forget_signed_out();
    assert_eq!(
        check(&cloud, dir, &mut failing, &token("two2two2"), NOW + 1).await,
        None
    );
}

#[tokio::test]
async fn a_held_credential_cloud_refuses_is_renewed_once_for_the_whole_claim() {
    let folder = tempfile::tempdir().unwrap();
    let cloud = FakeCloud::answering(Ok(json!({"claimed": true, "owner": "you"})));
    *cloud.stale.lock().unwrap() = true;
    let mut memory = Memory::default();
    let answer = check(&cloud, folder.path(), &mut memory, &token("one1one1"), NOW).await;
    assert_eq!(answer, claimed());
    let seen: Vec<(String, String)> = cloud
        .requests
        .lock()
        .unwrap()
        .iter()
        .map(|r| (r.1.clone(), r.3.clone()))
        .collect();
    let pair = |path: &str, bearer: &str| (path.to_string(), format!("Bearer {bearer}"));
    assert_eq!(
        seen,
        [
            pair("/auth/whoami", "Bearer-held"),
            pair("/auth/whoami", "Bearer-renewed"),
            pair("/fleet/nodes/claim", "Bearer-renewed"),
        ]
    );
}
