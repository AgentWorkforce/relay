//! Claiming this computer's spawn node for the signed-in person, so Agent
//! Relay records whose computer it is (`POST /fleet/nodes/claim`, the route
//! `agent-relay node claim` also calls). The claim proves both halves: the
//! node's own token, and the person's Cloud session. Nobody needs the
//! `agent-relay` command line for it.
//!
//! Checked before the node registers (so at start and after every
//! enrollment or token rotation, as the token changed), at once after a
//! sign-in, and every minute after; Cloud is asked again only for a new token
//! or another account, `RETRY_MS` after it named another owner, or after a
//! backoff following a failure (an hour after Cloud's rate limit), or at
//! once on the person's Retry (`spawn.claim.retry`). The core never holds a
//! spawn up on the claim, but Cloud refuses every spawn onto an unclaimed
//! desktop, so the status says why it is not claimed. The credential the request goes out with must be
//! the signed-in person's own (`GET /auth/whoami` says whose it is), so a
//! node is never claimed for someone else. Claiming is idempotent: a node
//! this person already owns stays theirs. A node another account owns takes
//! no spawns (no `spawn:<harness>` capability, and a spawn that still arrives
//! is refused) until a later claim succeeds. Without a sign-in nothing is
//! asked, and the status says so.
//!
//! Turning spawning off keeps the claim: ownership is about the computer,
//! which keeps its node id (`spawn-node.json`) across off and on, and a node
//! that is off is no spawn target anyway.

use super::node::NodeInfo;
use crate::relay::cloud_session::{self, CloudAccess, CloudAccount, CloudError};
use crate::relay::daemon::Core;
use crate::relay::state::{now_ms, SpawnClaim, SpawnClaimState, SpawnState, SpawnStatus};
use crate::relay::workspace::Secret;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const CLAIM_FILE: &str = "spawn-node-claim.json";
/// How long, in ms, an answer that did not claim the node stands before it
/// is asked again for the same account. Cloud allows 20 claims an hour.
pub const RETRY_MS: i64 = 15 * 60 * 1000;
/// The first wait after a failure, doubled with each failure in a row.
const BACKOFF_MS: i64 = 60 * 1000;
/// The longest wait after a failure, and the wait after Cloud's rate limit
/// (20 claims an hour).
const BACKOFF_MAX_MS: i64 = 60 * 60 * 1000;
/// The spawn status error while another account owns the node.
pub const OWNED_BY_OTHER: &str = "This computer's spawn node belongs to another account. It takes no spawns until that account, or an owner of your workspace, releases it in Agent Relay.";
const SIGNED_OUT: &str = "Sign in to Agent Relay to record this computer's spawn node as yours.";
const NOT_YOURS: &str = "Agent Relay did not record this computer's spawn node as yours: the Agent Relay sign-in this computer uses belongs to someone else. Sign in again in the app.";
/// Cloud's refusal when someone else owns the node (`claimNode`).
const OTHER_OWNER: &str = "Another person owns this node";

/// Whose the node is, as Cloud last answered.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Owner {
    Me,
    Other,
}

/// One claim, as asked: the node and token, and the account asking.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Ask {
    #[serde(rename = "nodeID")]
    node_id: String,
    /// The token's digest: a new token (an enrollment or a rotation) asks
    /// again.
    token: String,
    #[serde(rename = "siteURL")]
    site_url: String,
    #[serde(rename = "workspaceID")]
    workspace_id: String,
    #[serde(rename = "userID")]
    user_id: String,
}

/// The last answer that named an owner, kept in the app data folder
/// (`CLAIM_FILE`) and in memory, which stands when the file cannot be
/// written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Record {
    #[serde(flatten)]
    ask: Ask,
    owner: Owner,
    #[serde(rename = "atMs", default)]
    at_ms: i64,
}

/// What the core holds in memory about the claim.
#[derive(Default)]
pub(crate) struct Memory {
    pub(super) status: Option<SpawnClaim>,
    /// Another account owns the node: no spawns.
    pub(super) blocked: bool,
    last: Option<Record>,
    /// The last ask that did not claim the node, when, how long it stands,
    /// and whether it found no usable sign-in.
    tried: Option<(Ask, i64, i64, bool)>,
    /// Failures in a row, for the backoff.
    failures: u32,
    /// The ask waiting for Cloud; an answer to any other is dropped.
    asking: Option<Ask>,
}

/// What to do about the claim now.
#[derive(Debug, PartialEq)]
pub(super) enum Next {
    /// Nothing changed since the last check.
    Unchanged,
    /// Known without asking Cloud.
    Settled(SpawnClaim, bool),
    /// Ask Cloud; spawns stay `blocked` as last answered until it answers.
    Ask(Ask, bool),
}

fn digest(token: &Secret) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(token.expose().as_bytes());
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

fn path(dir: &Path) -> PathBuf {
    dir.join(CLAIM_FILE)
}

fn load(dir: &Path) -> Option<Record> {
    serde_json::from_slice(&std::fs::read(path(dir)).ok()?).ok()
}

fn save(dir: &Path, record: &Record) -> std::io::Result<()> {
    let temporary = path(dir).with_extension("json.tmp");
    std::fs::write(
        &temporary,
        serde_json::to_vec_pretty(record).map_err(std::io::Error::other)?,
    )?;
    std::fs::rename(temporary, path(dir))
}

pub(super) fn status(state: SpawnClaimState, note: Option<&str>) -> SpawnClaim {
    SpawnClaim {
        state,
        note: note.map(str::to_string),
    }
}

/// What to do for `node`, registered with `token`, as `account`, at `now`
/// (ms).
pub(super) fn next(
    dir: &Path,
    node: &NodeInfo,
    token: &Secret,
    account: Option<CloudAccount>,
    memory: &Memory,
    now: i64,
) -> Next {
    let record = memory
        .last
        .clone()
        .or_else(|| load(dir))
        .filter(|r| r.ask.node_id == node.node_id);
    let blocked = record.as_ref().is_some_and(|r| r.owner == Owner::Other);
    let Some(account) = account else {
        // Ownership is the computer's: a claim made before signing out holds.
        return Next::Settled(
            match record.map(|r| r.owner) {
                Some(Owner::Me) => status(SpawnClaimState::Claimed, None),
                _ => status(SpawnClaimState::SignedOut, Some(SIGNED_OUT)),
            },
            blocked,
        );
    };
    let Some(user_id) = account.user_id else {
        // Whose sign-in it is is not known yet: checked again in a minute.
        return Next::Settled(status(SpawnClaimState::Pending, None), blocked);
    };
    let ask = Ask {
        node_id: node.node_id.clone(),
        token: digest(token),
        site_url: account.site_url,
        workspace_id: account.workspace_id,
        user_id,
    };
    let recent = |asked: &Ask, at: i64| *asked == ask && now - at < RETRY_MS;
    match record {
        Some(r) if r.ask == ask && r.owner == Owner::Me => {
            return Next::Settled(status(SpawnClaimState::Claimed, None), false)
        }
        // Answered before a restart: stands for `RETRY_MS` as any refusal.
        Some(r) if r.owner == Owner::Other && recent(&r.ask, r.at_ms) => {
            return Next::Settled(answered_other(), true)
        }
        _ => {}
    }
    let tried = memory
        .tried
        .as_ref()
        .is_some_and(|(t, at, wait, _)| *t == ask && now - at < *wait);
    if memory.asking.as_ref() == Some(&ask) || tried {
        return Next::Unchanged;
    }
    Next::Ask(ask, blocked)
}

fn answered_other() -> SpawnClaim {
    status(SpawnClaimState::OwnedByOther, Some(OWNED_BY_OTHER))
}

/// Cloud's answer to a claim: as the status shows it, whose the node is
/// when Cloud said so, and whether Cloud's rate limit refused it.
#[derive(Debug, PartialEq)]
pub(super) struct Answer {
    claim: SpawnClaim,
    owner: Option<Owner>,
    limited: bool,
}

fn answered(result: Result<Value, CloudError>) -> Answer {
    let (claim, owner) = match &result {
        Ok(_) => (status(SpawnClaimState::Claimed, None), Some(Owner::Me)),
        Err(CloudError::SignedOut | CloudError::Rejected) => {
            (status(SpawnClaimState::SignedOut, Some(SIGNED_OUT)), None)
        }
        Err(CloudError::Status {
            status: 409,
            message: Some(message),
        }) if message.starts_with(OTHER_OWNER) => (answered_other(), Some(Owner::Other)),
        Err(error) => (failed(&error.to_string()), None),
    };
    let limited = matches!(result, Err(CloudError::Status { status: 429, .. }));
    Answer {
        claim,
        owner,
        limited,
    }
}

fn failed(reason: &str) -> SpawnClaim {
    let note = format!("Agent Relay did not record this computer's spawn node as yours: {reason}");
    status(SpawnClaimState::Failed, Some(&note))
}

/// Asks Cloud to record the node as the person `ask` names, with the
/// credential Cloud requests go out with, once Cloud confirmed that
/// credential is theirs. Both requests are made with that one credential,
/// held for them (`CloudAccess::credential`), so the claim never goes out as
/// anyone but the person just confirmed.
pub(super) async fn ask(cloud: &dyn CloudAccess, ask: &Ask, token: &Secret) -> Answer {
    // A held credential Cloud refuses is renewed once, as other requests'
    // are, and the whole claim made again with the renewed one.
    let mut refused = None;
    for _ in 0..2 {
        let Some((site, bearer)) = cloud.credential(refused.take()).await else {
            break;
        };
        match ask_with(&site, &bearer, ask, token).await {
            Ok(answer) => return answer,
            Err(_) => refused = Some(bearer),
        }
    }
    answered(Err(CloudError::Rejected))
}

/// One claim with one credential: whose it is, then the claim. `Err` when
/// Cloud refused the credential itself.
async fn ask_with(site: &str, bearer: &Secret, ask: &Ask, token: &Secret) -> Result<Answer, ()> {
    let send =
        |method, path: &'static str, body| cloud_session::api(site, bearer, method, path, body);
    let signed_in = match send("GET", "/auth/whoami", None).await {
        Ok(body) => {
            let body = body.get("data").filter(|d| d.is_object()).unwrap_or(&body);
            body["user"]["id"].as_str().map(str::to_string)
        }
        Err(CloudError::Rejected) => return Err(()),
        Err(error) => return Ok(answered(Err(error))),
    };
    if signed_in.as_deref() != Some(ask.user_id.as_str()) {
        return Ok(Answer {
            claim: status(SpawnClaimState::Failed, Some(NOT_YOURS)),
            owner: None,
            limited: false,
        });
    }
    let body = json!({"workspaceId": ask.workspace_id, "nodeToken": token.expose()});
    match send("POST", "/fleet/nodes/claim", Some(body)).await {
        Err(CloudError::Rejected) => Err(()),
        result => Ok(answered(result)),
    }
}

impl Memory {
    /// The person asked to try again: no backoff stands.
    pub(super) fn forget_tries(&mut self) {
        self.tried = None;
        self.failures = 0;
    }

    /// A sign-in: an ask that found none is asked again at once.
    pub(super) fn forget_signed_out(&mut self) {
        if self.tried.as_ref().is_some_and(|tried| tried.3) {
            self.tried = None;
        }
    }

    /// An answer known without asking stands: one still in flight is
    /// dropped when it lands.
    pub(super) fn settled(&mut self) {
        self.asking = None;
    }

    /// `ask` is under way.
    pub(super) fn begin(&mut self, ask: Ask) {
        self.asking = Some(ask);
    }

    /// Cloud answered `asked` at `now`: the status and whether spawns are
    /// refused, or `None` when a newer check replaced it. An owner Cloud
    /// named is kept on disk and asked again after `RETRY_MS`; a failure
    /// after a backoff; a claim not again.
    pub(super) fn settle(
        &mut self,
        dir: &Path,
        asked: Ask,
        answer: Answer,
        blocked: bool,
        now: i64,
    ) -> Option<(SpawnClaim, bool)> {
        if self.asking.as_ref() != Some(&asked) {
            return None;
        }
        self.asking = None;
        let Answer {
            claim,
            owner,
            limited,
        } = answer;
        self.failures = match owner {
            Some(_) => 0,
            None => self.failures.saturating_add(1),
        };
        let wait = match owner {
            Some(Owner::Me) => None,
            Some(Owner::Other) => Some(RETRY_MS),
            None if limited => Some(BACKOFF_MAX_MS),
            // Signed out: asked at the next check after a sign-in.
            None if claim.state == SpawnClaimState::SignedOut => Some(BACKOFF_MS),
            None => Some(backoff(self.failures)),
        };
        let signed_out = claim.state == SpawnClaimState::SignedOut;
        self.tried = wait.map(|wait| (asked.clone(), now, wait, signed_out));
        let Some(owner) = owner else {
            return Some((claim, blocked));
        };
        let record = Record {
            ask: asked,
            owner,
            at_ms: now,
        };
        // Memory stands for the file if it cannot be written.
        let _ = save(dir, &record);
        self.last = Some(record);
        Some((claim, owner == Owner::Other))
    }
}

/// The wait after `failures` failures in a row: a minute, doubled each
/// time, at most an hour.
fn backoff(failures: u32) -> i64 {
    let doublings = failures.saturating_sub(1).min(6);
    (BACKOFF_MS << doublings).min(BACKOFF_MAX_MS)
}

impl Core {
    /// Checks the claim now rather than at the next minute (after a sign-in
    /// or a workspace change, which ask Cloud at once as a new account).
    pub(crate) fn request_spawn_claim(&self) {
        let ledger = self.ledger();
        ledger.memory().forget_signed_out();
        ledger.claim_now.notify_one();
    }

    /// `spawn.claim.retry`: the person's Retry. Asks Cloud at once, whatever
    /// the backoff.
    pub(crate) fn retry_spawn_claim(&self) {
        let ledger = self.ledger();
        ledger.memory().forget_tries();
        ledger.claim_now.notify_one();
    }

    /// Whether another account owns the node, so it takes no spawns.
    pub(super) fn spawns_blocked(&self) -> bool {
        self.ledger().memory().blocked
    }

    /// Claims the node registered with `token` when it is not yet claimed
    /// for the signed-in person (see the module).
    pub(super) fn check_spawn_claim(&self, node: &NodeInfo, token: &Secret) {
        let dir = self.config.app_data_dir.clone();
        let account = self.plugins.cloud.account();
        let ledger = self.ledger();
        let (asked, blocked, shown) = {
            let mut memory = ledger.memory();
            match next(&dir, node, token, account, &memory, now_ms()) {
                Next::Unchanged => return,
                Next::Settled(claim, blocked) => {
                    memory.settled();
                    drop(memory);
                    return self.show_spawn_claim(claim, blocked);
                }
                Next::Ask(asked, blocked) => {
                    memory.begin(asked.clone());
                    let shown = memory.status.clone();
                    (asked, blocked, shown)
                }
            }
        };
        let pending = status(SpawnClaimState::Pending, None);
        self.show_spawn_claim(shown.unwrap_or(pending), blocked);
        let Some(core) = self.arc() else { return };
        let token = token.clone();
        tokio::spawn(async move {
            let cloud = core.plugins.cloud.clone();
            let answer = ask(cloud.as_ref(), &asked, &token).await;
            let settled = core
                .ledger()
                .memory()
                .settle(&dir, asked, answer, blocked, now_ms());
            if let Some((claim, blocked)) = settled {
                core.show_spawn_claim(claim, blocked);
            }
        });
    }

    /// Shows the claim in the status; a change to whether spawns are taken
    /// reaches Relaycast at once.
    fn show_spawn_claim(&self, claim: SpawnClaim, blocked: bool) {
        let ledger = self.ledger();
        let state = claim.state;
        let (was, was_state) = {
            let mut memory = ledger.memory();
            let was_state = memory.status.as_ref().map(|status| status.state);
            memory.status = Some(claim);
            (std::mem::replace(&mut memory.blocked, blocked), was_state)
        };
        self.hub.update(|snapshot| {
            if let Some(spawn) = snapshot.spawn.as_mut() {
                self.dress_spawn_status(spawn);
            }
        });
        if was != blocked {
            ledger.changed.notify_one();
        }
        if was_state != Some(state) {
            // The mobile continuation settings read as on only once the
            // computer is claimed, so Settings is told; and once it is, the
            // Claude plugin is installed now rather than on the next
            // discovery pass, off this thread as it touches disk.
            self.hub
                .invalidated(crate::relay::state::Listing::Settings);
            if state == SpawnClaimState::Claimed {
                if let Some(core) = self.arc() {
                    std::thread::spawn(move || core.refresh_mobile_claude_plugin());
                }
            }
        }
    }

    /// The claim's part of the spawn status: its state and, while another
    /// account owns the live node, the error.
    pub(super) fn dress_spawn_status(&self, spawn: &mut SpawnStatus) {
        if spawn.state == SpawnState::Off {
            return;
        }
        let ledger = self.ledger();
        let memory = ledger.memory();
        spawn.claim = memory.status.clone();
        if spawn.state == SpawnState::Live {
            spawn.error = memory.blocked.then(|| OWNED_BY_OTHER.to_string());
        }
    }
}

#[cfg(test)]
#[path = "claim_tests.rs"]
pub(super) mod tests;
