//! Owner-named trusted delegates: a message from an agent an owner named in
//! Agent Relay Cloud to relay their approval for named actions.
//!
//! Relaycast marks such a delivery `has_owner_approval` and nothing more;
//! the core never reads the approval from Relaycast. Before the delivery is
//! handed over (and so before it is acknowledged), the core asks Cloud,
//! with the desktop's own signed-in session and the recipient agent's
//! token, to attest it (`POST /workspaces/{ws}/messaging/delegation`). Cloud
//! answers with a compact JWS (EdDSA, Ed25519) naming the message, the
//! recipient and exactly the actions approved. The core checks the
//! signature against the keys Cloud publishes for this build's site
//! ([`keys_urls`], kept for [`KEYS_FOR`] and read again for an unknown key
//! id), that the message, recipient, workspace and sender are this
//! delivery's, and that it has not expired; it then writes
//! `policy::delegate_line` as the message's second line. Anything else
//! (the setting off, a gate-only install, no sign-in, Cloud's `none`, an
//! unreachable Cloud, a bad signature) leaves the message an ordinary
//! peer's, never dropped, and logs why.
//!
//! The person chooses whose delegates count with
//! [`SETTING`] (`delegated_approvals_from`): `off`, `own_owner` or
//! `code_owners` (the default: also delegates of any code owner of each
//! action's target). Cloud applies it; with `off` the core makes no call.
//!
//! An attested `prompt_approval` reply (`approve <ref>` / `deny <ref>`)
//! answers a spawned session's open request as `Approver::Delegate`
//! (`spawn::drive`, [`SPAWN_SETTING`]).
//!
//! A session redeems a single-use approval right before it acts through
//! the session socket's `POST /delegation/redeem`, as its own agent
//! ([`Core::redeem_delegation`]).

use crate::relay::cloud_session::{segment, CloudError};
use crate::relay::daemon::Core;
use crate::relay::delivery::policy::Delivery;
use crate::relay::store::{Registration, Store};
use crate::relay::workspace::Secret;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

/// The setting naming whose delegates' approvals this computer accepts.
pub const SETTING: &str = "delegated_approvals_from";

/// The setting letting the machine owner's delegates approve or deny
/// spawned sessions' requests (`prompt_approval`): on unless the person turns
/// it off.
pub const SPAWN_SETTING: &str = "spawn_delegate_approvals";

/// Why approvals from owners' delegates ([`SETTING`]) are not available on
/// a gate-only install, as `GET /settings` lists it and a change other than
/// `off` is refused.
pub const GATE_ONLY: &str = "Approvals from owners' delegates are not available on this computer: it reaches its workspace only through relaygate, without the Agent Relay Cloud session that attests them.";

/// The action classes an approval may name (wire contract v1, §16.1).
pub const CLASSES: [&str; 10] = [
    "merge",
    "pr_ops",
    "deploy",
    "release",
    "secret_change",
    "destructive",
    "spend",
    "external_comms",
    PROMPT_APPROVAL,
    CONFIG_CHANGE,
];

/// The class of operations on a pull request, targeting
/// `owner/repo#N:<op>`.
pub const PR_OPS: &str = "pr_ops";

/// The class whose one action changes one setting of the recipient session
/// (`<agent id>:<setting>=<value>`, exact): single use, redeemed right
/// before the agent makes the change itself. The node never applies it.
pub const CONFIG_CHANGE: &str = "config_change";

/// Settings a `config_change` may never name: the recipient's delegation
/// settings themselves, or a delegate could widen its own reach (§5.3).
pub const NEVER_CHANGED_BY_DELEGATES: [&str; 2] = [SETTING, SPAWN_SETTING];

/// The class whose one action answers one pending core permission request,
/// targeting `<session agent id>:<request ref>`.
pub const PROMPT_APPROVAL: &str = "prompt_approval";

/// The condition types an action may carry (§5.5).
pub const CONDITIONS: [&str; 5] = [
    "ci_green",
    "head_sha",
    "reviews_approved",
    "mergeable",
    "not_before",
];

/// The most conditions one action may carry.
pub const MAX_CONDITIONS: usize = 5;

/// The longest target an action may name, in characters.
pub const MAX_TARGET: usize = 256;

/// The most actions one approval may name.
pub const MAX_ACTIONS: usize = 20;

/// How long Cloud's keys are used before they are read again.
pub const KEYS_FOR: Duration = Duration::from_secs(60 * 60);

/// The least time between two reads of the keys an unknown key id causes,
/// so a stream of made-up key ids cannot make the core read them each time.
pub const UNKNOWN_KID_EVERY: Duration = Duration::from_secs(30);

/// The longest an attestation may live (Cloud issues 300 seconds), with a
/// minute for clocks that disagree.
pub const MAX_LIFETIME_SECS: i64 = 300 + 60;

/// Clock skew allowed on `iat`.
const SKEW_SECS: i64 = 60;

/// How long a read of the keys may take.
const KEYS_TIMEOUT: Duration = Duration::from_secs(10);

/// Whose delegates' approvals this computer accepts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Accept {
    Off,
    OwnOwner,
    CodeOwners,
}

impl Accept {
    /// From narrowest to widest.
    pub const ALL: [Accept; 3] = [Accept::Off, Accept::OwnOwner, Accept::CodeOwners];

    /// As `settings.get` and Cloud's `accept` name it.
    pub fn name(self) -> &'static str {
        match self {
            Accept::Off => "off",
            Accept::OwnOwner => "own_owner",
            Accept::CodeOwners => "code_owners",
        }
    }

    pub fn parse(value: &str) -> Option<Accept> {
        Accept::ALL
            .into_iter()
            .find(|accept| accept.name() == value)
    }

    /// A `settings.set` value, or why it is refused.
    pub fn read(value: &Value) -> Result<Accept, String> {
        value
            .as_str()
            .and_then(Accept::parse)
            .ok_or_else(|| format!("{SETTING} must be \"off\", \"own_owner\" or \"code_owners\"."))
    }

    /// Whether this choice accepts an approval with `standing` (`own_owner`
    /// or `code_owner`): `off` none, `own_owner` the own owner's only.
    pub fn permits(self, standing: &str) -> bool {
        match self {
            Accept::Off => false,
            Accept::OwnOwner => standing == "own_owner",
            Accept::CodeOwners => matches!(standing, "own_owner" | "code_owner"),
        }
    }

    /// Whether `asked` is a wider choice than `current` (the default when
    /// unset or unreadable): only the person makes one.
    pub fn widens(asked: &str, current: Option<&Value>) -> bool {
        let Some(asked) = Accept::parse(asked) else {
            return false;
        };
        let current = current
            .and_then(Value::as_str)
            .and_then(Accept::parse)
            .unwrap_or(Accept::CodeOwners);
        asked > current
    }
}

/// The choice in force: `code_owners` unless the person chose another.
pub fn accept(store: &Store) -> Accept {
    store
        .extras
        .delegated_approvals_from
        .as_deref()
        .and_then(Accept::parse)
        .unwrap_or(Accept::CodeOwners)
}

/// Whether the machine owner's delegates may answer spawned sessions'
/// requests here, as set: on unless the person turned it off.
pub fn spawn_delegate_approvals(store: &Store) -> bool {
    store.extras.spawn_delegate_approvals != Some(false)
}

/// One structured condition (§5.5): checked by Cloud at redeem.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Condition {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

impl Condition {
    /// Whether it is a v1 condition with the fields its type needs.
    pub fn is_valid(&self) -> bool {
        match self.kind.as_str() {
            "ci_green" | "mergeable" => true,
            "head_sha" => self.sha.as_deref().is_some_and(|sha| {
                sha.len() == 40 && sha.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            }),
            "reviews_approved" => self.min.is_some_and(|min| (1..=10).contains(&min)),
            "not_before" => self
                .at
                .as_deref()
                .is_some_and(|at| chrono::DateTime::parse_from_rfc3339(at).is_ok()),
            _ => false,
        }
    }

    /// The condition in words, as the delegate line lists it.
    pub fn words(&self) -> String {
        match self.kind.as_str() {
            "ci_green" => "CI is green".into(),
            "head_sha" => format!(
                "head is {}",
                self.sha
                    .as_deref()
                    .unwrap_or_default()
                    .chars()
                    .take(8)
                    .collect::<String>()
            ),
            "reviews_approved" => match self.min.unwrap_or(1) {
                1 => "it has 1 approving review".into(),
                min => format!("it has {min} approving reviews"),
            },
            "mergeable" => "it is mergeable".into(),
            "not_before" => format!("not before {}", self.at.as_deref().unwrap_or_default()),
            other => other.to_string(),
        }
    }
}

/// One approved action.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Action {
    pub class: String,
    pub target: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conditions: Vec<Condition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl Action {
    /// A `config_change` action's target as (agent id, setting, value):
    /// `<agent id>:<setting>=<value>`, each part non-empty, no wildcard.
    /// `None` for another class or a malformed target.
    pub fn config_change(&self) -> Option<(&str, &str, &str)> {
        if self.class != CONFIG_CHANGE || self.target.contains('*') {
            return None;
        }
        let (agent, change) = self.target.split_once(':')?;
        let (setting, value) = change.split_once('=')?;
        // Canonical parts only: no whitespace, control or format character
        // that the line would show differently from what is checked.
        let canonical = |part: &str| {
            !part.is_empty()
                && !part.chars().any(|c| {
                    c.is_whitespace() || crate::relay::delivery::policy::is_control_or_newline(c)
                })
        };
        (canonical(agent) && canonical(setting) && canonical(value))
            .then_some((agent, setting, value))
    }

    /// A `pr_ops` action's target as (pull request, operation in words):
    /// `owner/repo#N:<op>`, `<op>` one of `open`, `close`, `reopen`,
    /// `label=<name>`, `unlabel=<name>`, `request_review=<login>`,
    /// `rerun_ci` or `comment`. `None` for another class or a malformed
    /// target.
    pub fn pr_op(&self) -> Option<(&str, String)> {
        if self.class != PR_OPS {
            return None;
        }
        // The pull request ends at its number; the operation is everything
        // after the colon that follows it (a label may hold colons).
        let hash = self.target.find('#')?;
        let digits = self.target[hash + 1..]
            .bytes()
            .take_while(u8::is_ascii_digit)
            .count();
        let end = hash + 1 + digits;
        let (pull, rest) = self.target.split_at(end);
        let op = rest.strip_prefix(':')?;
        // Exactly `owner/repo`: two non-empty parts.
        let repo = &pull[..hash];
        let mut parts = repo.split('/');
        let shaped = matches!(
            (parts.next(), parts.next(), parts.next()),
            (Some(owner), Some(name), None) if !owner.is_empty() && !name.is_empty()
        );
        if digits == 0
            || !shaped
            || repo.contains(['#', ':'])
            || repo.chars().any(char::is_whitespace)
        {
            return None;
        }
        let label = |value: &str| {
            !value.is_empty() && value.trim() == value && !value.chars().any(char::is_control)
        };
        let named = |value: &str| {
            !value.is_empty() && !value.chars().any(|c| c.is_whitespace() || c.is_control())
        };
        let words = match op.split_once('=') {
            None => match op {
                "open" | "close" | "reopen" | "comment" => op.to_string(),
                "rerun_ci" => "re-run CI".to_string(),
                _ => return None,
            },
            // A label may hold single spaces (`help wanted`); the target's
            // exactness check refuses leading, trailing or repeated ones.
            Some(("label", name)) if label(name) => format!("label {name}"),
            Some(("unlabel", name)) if label(name) => format!("unlabel {name}"),
            Some(("request_review", login)) if named(login) => {
                format!("request review from {login}")
            }
            Some(_) => return None,
        };
        Some((pull, words))
    }

    /// The action in words, as the delegate line lists it: `merge X if CI
    /// is green and head is 3f2a1c9e`, or for a `config_change`, `change
    /// <setting> to <value> on @<agent id>`.
    pub fn words(&self) -> String {
        use crate::relay::delivery::policy::one_line;
        // The exact class and target to redeem, when the words do not
        // already read as them.
        let exact = format!(
            "(redeem as {} {})",
            one_line(&self.class),
            one_line(&self.target)
        );
        let action = match self.config_change() {
            Some((agent, setting, value)) => format!(
                "change {} to {} on @{} {exact}",
                one_line(setting),
                one_line(value),
                one_line(agent)
            ),
            None => match self.pr_op() {
                Some((pull, op)) => format!("{} on {} {exact}", one_line(&op), one_line(pull)),
                None => format!("{} {}", one_line(&self.class), one_line(&self.target)),
            },
        };
        let conditions: Vec<String> = self
            .conditions
            .iter()
            .map(|condition| one_line(&condition.words()))
            .collect();
        match conditions.as_slice() {
            [] => action,
            [only] => format!("{action} if {only}"),
            [rest @ .., last] => format!("{action} if {} and {last}", rest.join(", ")),
        }
    }
}

/// The claims of Cloud's attestation (wire contract v1, §16.4).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Claims {
    pub v: u64,
    pub ws: String,
    pub owner_id: String,
    #[serde(default)]
    pub owner_display: Option<String>,
    pub delegate_agent_id: String,
    pub grant_id: String,
    pub message_id: String,
    pub recipient_agent_id: String,
    pub approval_id: String,
    pub tier: String,
    pub actions: Vec<Action>,
    /// `own_owner` or `code_owner`: why the owner may approve for this
    /// recipient (§5.4). Absent reads as `own_owner`.
    #[serde(default = "own_owner")]
    pub standing: String,
    pub single_use: bool,
    /// The owner's words as the delegate quoted them, or `None` once
    /// redacted. Signed, but never printed in the delegate line: the
    /// message's own text carries it.
    #[serde(default)]
    pub quote: Option<String>,
    pub iat: i64,
    pub exp: i64,
    pub jti: String,
}

fn own_owner() -> String {
    "own_owner".into()
}

impl Claims {
    /// Whether any action is a `config_change` (always single use).
    pub fn changes_config(&self) -> bool {
        self.actions
            .iter()
            .any(|action| action.class == CONFIG_CHANGE)
    }

    /// Whether the owner's standing is as a code owner of the target.
    pub fn code_owner(&self) -> bool {
        self.standing == "code_owner"
    }
}

/// An attestation this core verified, with the JWS it came as.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attestation {
    pub claims: Claims,
    pub jws: String,
}

/// What this delivery must match for an attestation to count.
#[derive(Clone, Copy, Debug)]
pub struct Expected<'a> {
    pub workspace_id: &'a str,
    pub message_id: &'a str,
    pub recipient_agent_id: &'a str,
    /// The sender's immutable id, as Relaycast delivered it, when known.
    pub sender_id: Option<&'a str>,
    /// Seconds since the epoch.
    pub now: i64,
}

/// Why an attestation was not accepted. Logged; never shown to the sender.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// Not a compact JWS, or its parts are not readable.
    Malformed,
    /// A header other than `EdDSA` / `relay-delegation+jws`.
    Header,
    /// No published key has the JWS's key id.
    UnknownKey,
    BadSignature,
    /// The claims are not a v1 attestation (version, tier, actions).
    Claims,
    WrongWorkspace,
    WrongMessage,
    WrongRecipient,
    WrongSender,
    Expired,
    /// Issued in the future, or to live longer than Cloud issues.
    Lifetime,
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Refusal::Malformed => "malformed",
            Refusal::Header => "header",
            Refusal::UnknownKey => "unknown_kid",
            Refusal::BadSignature => "bad_signature",
            Refusal::Claims => "claims",
            Refusal::WrongWorkspace => "wrong_workspace",
            Refusal::WrongMessage => "wrong_message",
            Refusal::WrongRecipient => "wrong_recipient",
            Refusal::WrongSender => "wrong_sender",
            Refusal::Expired => "expired",
            Refusal::Lifetime => "lifetime",
        })
    }
}

/// Cloud's published Ed25519 keys, by key id.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeySet {
    keys: Vec<(String, Vec<u8>)>,
}

impl KeySet {
    /// The OKP Ed25519 keys with a key id in a JWKS; others are left out.
    pub fn parse(jwks: &Value) -> KeySet {
        let keys = jwks["keys"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|key| key["kty"] == "OKP" && key["crv"] == "Ed25519")
            .filter(|key| key.get("use").is_none_or(|usage| usage == "sig"))
            .filter_map(|key| {
                let kid = key["kid"].as_str().filter(|kid| !kid.is_empty())?;
                let x = URL_SAFE_NO_PAD.decode(key["x"].as_str()?).ok()?;
                (x.len() == 32).then(|| (kid.to_string(), x))
            })
            .collect();
        KeySet { keys }
    }

    pub fn get(&self, kid: &str) -> Option<&[u8]> {
        self.keys
            .iter()
            .find(|(id, _)| id == kid)
            .map(|(_, key)| key.as_slice())
    }
}

/// The JWS's key id, when its header is readable.
pub fn key_id(jws: &str) -> Option<String> {
    let header = jws.split('.').next()?;
    let header: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(header).ok()?).ok()?;
    header["kid"].as_str().map(str::to_string)
}

/// The claims of `jws` when it is Cloud's attestation for this delivery:
/// signed with a key in `keys`, and naming this workspace, message,
/// recipient and sender, still valid at `expected.now`.
pub fn verify(jws: &str, keys: &KeySet, expected: Expected<'_>) -> Result<Claims, Refusal> {
    let parts: Vec<&str> = jws.split('.').collect();
    let [header, payload, signature] = parts.as_slice() else {
        return Err(Refusal::Malformed);
    };
    let decode = |part: &str| URL_SAFE_NO_PAD.decode(part).map_err(|_| Refusal::Malformed);
    let head: Value = serde_json::from_slice(&decode(header)?).map_err(|_| Refusal::Malformed)?;
    if head["alg"] != "EdDSA" || head["typ"] != "relay-delegation+jws" || head.get("crit").is_some()
    {
        return Err(Refusal::Header);
    }
    let kid = head["kid"].as_str().ok_or(Refusal::Header)?;
    let key = keys.get(kid).ok_or(Refusal::UnknownKey)?;
    let signed = format!("{header}.{payload}");
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key)
        .verify(signed.as_bytes(), &decode(signature)?)
        .map_err(|_| Refusal::BadSignature)?;
    let claims: Claims = serde_json::from_slice(&decode(payload)?).map_err(|_| Refusal::Claims)?;
    let actions_ok = !claims.actions.is_empty()
        && claims.actions.len() <= MAX_ACTIONS
        && claims.actions.iter().all(|action| {
            CLASSES.contains(&action.class.as_str())
                && !action.target.trim().is_empty()
                && action.target.chars().count() <= MAX_TARGET
                // Shown exactly: a target the line would change (brackets,
                // control or line-separator characters, runs of spaces) is
                // refused, so the agent redeems exactly what was signed.
                && crate::relay::delivery::policy::one_line(&action.target) == action.target
                && action.conditions.len() <= MAX_CONDITIONS
                && action.conditions.iter().all(Condition::is_valid)
                && (action.class != CONFIG_CHANGE || action.config_change().is_some())
                && (action.class != PR_OPS || action.pr_op().is_some())
                && (action.class != PROMPT_APPROVAL || action.conditions.is_empty())
                && (action.class != CONFIG_CHANGE
                    || action.conditions.iter().all(|c| c.kind == "not_before"))
        });
    // A config change is always single use.
    if claims.changes_config() && !claims.single_use {
        return Err(Refusal::Claims);
    }
    if claims.v != 1
        || !matches!(claims.tier.as_str(), "D" | "O")
        || !matches!(claims.standing.as_str(), "own_owner" | "code_owner")
        || !actions_ok
        || claims.approval_id.is_empty()
        || claims.delegate_agent_id.is_empty()
    {
        return Err(Refusal::Claims);
    }
    if claims.ws != expected.workspace_id {
        return Err(Refusal::WrongWorkspace);
    }
    if claims.message_id != expected.message_id {
        return Err(Refusal::WrongMessage);
    }
    if claims.recipient_agent_id != expected.recipient_agent_id {
        return Err(Refusal::WrongRecipient);
    }
    if expected
        .sender_id
        .is_some_and(|sender| sender != claims.delegate_agent_id)
    {
        return Err(Refusal::WrongSender);
    }
    if claims.exp <= expected.now {
        return Err(Refusal::Expired);
    }
    if claims.iat > expected.now + SKEW_SECS
        // Checked arithmetic: a signed claim with an out-of-range time
        // is refused, never wrapped.
        || claims.exp.checked_sub(expected.now).is_none_or(|left| left > MAX_LIFETIME_SECS)
        || claims.exp.checked_sub(claims.iat).is_none_or(|life| life > MAX_LIFETIME_SECS)
        || claims.exp < claims.iat
    {
        return Err(Refusal::Lifetime);
    }
    Ok(claims)
}

/// Where this build's site publishes Cloud's delegation keys: Cloud's own
/// `/.well-known` under its `/cloud` base, then the site's root. The site is
/// the one the build was made for (`links::built_in_site_url`), never a
/// value read at run time.
pub fn keys_urls(site: &str) -> [String; 2] {
    [
        format!("{site}/cloud/.well-known/relay-delegation-keys.json"),
        format!("{site}/.well-known/relay-delegation-keys.json"),
    ]
}

/// Reads Cloud's JWKS; `None` when it could not be read.
pub type Fetch = Arc<dyn Fn() -> BoxFuture<'static, Option<Value>> + Send + Sync>;

/// How long the core remembers which of a session's identities received an
/// approval (for its redeem): longer than any approval lives (24 hours).
pub const RECIPIENTS_FOR: Duration = Duration::from_secs(25 * 60 * 60);

/// Which agent ids received each verified approval, by approval id: a renamed
/// session has several (the registered one and its aliases), a channel
/// approval reaches several sessions under one id, and a redeem must go to
/// Cloud as the identity the attestation named for that session.
#[derive(Default)]
pub struct Recipients {
    by_approval: Mutex<std::collections::HashMap<String, Vec<(String, Instant)>>>,
}

impl Recipients {
    /// Remembers that `agent_id` received `approval_id`.
    pub fn remember(&self, approval_id: &str, agent_id: &str) {
        let mut map = self
            .by_approval
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        for seen in map.values_mut() {
            seen.retain(|(_, at)| at.elapsed() < RECIPIENTS_FOR);
        }
        map.retain(|_, seen| !seen.is_empty());
        let seen = map.entry(approval_id.to_string()).or_default();
        seen.retain(|(id, _)| id != agent_id);
        seen.push((agent_id.to_string(), Instant::now()));
    }

    /// Every agent id that received `approval_id`, when the core saw it.
    pub fn of(&self, approval_id: &str) -> Vec<String> {
        self.by_approval
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(approval_id)
            .into_iter()
            .flatten()
            .filter(|(_, at)| at.elapsed() < RECIPIENTS_FOR)
            .map(|(id, _)| id.clone())
            .collect()
    }
}

/// Cloud's delegation keys as last read, kept for [`KEYS_FOR`].
#[derive(Default)]
pub struct Keys {
    cached: Mutex<Option<(Instant, KeySet)>>,
    /// The last read an unknown key id caused.
    unknown_read: Mutex<Option<Instant>>,
    /// Replaces the read of this build's site, in tests.
    fetch: Mutex<Option<Fetch>>,
    /// Held while the keys are read, so reads never overlap.
    reading: tokio::sync::Mutex<()>,
    /// When a read last failed: lookups within [`FAILED_READ_FOR`] after it
    /// share that failure rather than each reading again.
    failed_at: Mutex<Option<Instant>>,
}

/// How long a failed read of the keys is shared with later lookups, so an
/// outage costs one timeout, not one per waiting delivery.
pub const FAILED_READ_FOR: Duration = Duration::from_secs(30);

impl Keys {
    /// Reads the keys with `fetch` from now on, in place of this build's
    /// site.
    pub fn set_fetch(&self, fetch: Fetch) {
        *self.fetch.lock().unwrap_or_else(PoisonError::into_inner) = Some(fetch);
        *self.cached.lock().unwrap_or_else(PoisonError::into_inner) = None;
        *self
            .failed_at
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = None;
    }

    async fn read(&self) -> Option<KeySet> {
        let fetch = self
            .fetch
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let jwks = match fetch {
            Some(fetch) => fetch().await,
            None => fetch_site_keys().await,
        };
        *self
            .failed_at
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = jwks.is_none().then(Instant::now);
        let jwks = jwks?;
        let keys = KeySet::parse(&jwks);
        *self.cached.lock().unwrap_or_else(PoisonError::into_inner) =
            Some((Instant::now(), keys.clone()));
        Some(keys)
    }

    /// The keys last read, while within [`KEYS_FOR`].
    fn fresh(&self) -> Option<KeySet> {
        self.cached
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .filter(|(at, _)| at.elapsed() < KEYS_FOR)
            .map(|(_, keys)| keys)
    }

    /// The keys to check a JWS with key id `kid` against: those last read
    /// within [`KEYS_FOR`], read again when older or when they lack `kid`
    /// (at most once per [`UNKNOWN_KID_EVERY`]). Reads are one at a time:
    /// a lookup that arrives while one is in flight waits for it and uses
    /// its result, and an older read can never replace a newer one.
    pub async fn for_kid(&self, kid: &str) -> Option<KeySet> {
        if let Some(keys) = self.fresh().filter(|keys| keys.get(kid).is_some()) {
            return Some(keys);
        }
        let _reading = self.reading.lock().await;
        // A read that failed just now (perhaps while this one waited) is
        // shared, not repeated.
        let failed_recently = self
            .failed_at
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some_and(|at| at.elapsed() < FAILED_READ_FOR);
        // A read that finished while this one waited may have brought it.
        match self.fresh() {
            Some(keys) if keys.get(kid).is_some() => Some(keys),
            // A read that failed just now is shared here too.
            Some(keys) if failed_recently => Some(keys),
            Some(keys) => {
                {
                    let mut last = self
                        .unknown_read
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner);
                    if last.is_some_and(|last| last.elapsed() < UNKNOWN_KID_EVERY) {
                        return Some(keys);
                    }
                    *last = Some(Instant::now());
                }
                Some(self.read().await.unwrap_or(keys))
            }
            None if failed_recently => None,
            None => self.read().await,
        }
    }
}

/// Cloud's JWKS from this build's site ([`keys_urls`]).
async fn fetch_site_keys() -> Option<Value> {
    for url in keys_urls(crate::relay::links::built_in_site_url()) {
        let Ok(answer) = crate::relay::cloud_http::send("GET", url, None, None, KEYS_TIMEOUT).await
        else {
            return None;
        };
        if answer.ok() && answer.body["keys"].is_array() {
            return Some(answer.body);
        }
        if answer.status != 404 {
            return None;
        }
    }
    None
}

/// The longest owner approval the session socket takes, in bytes: above the
/// largest valid v1 object, which is about 161 KB when every character is a
/// four-byte one written as a JSON `\u` escape pair (12 bytes): a 2000-char
/// quote (24 000), 20 actions of a 256-char target, a 280-char note and 5
/// conditions (about 6 800 each), and the other fields.
pub const MAX_OWNER_APPROVAL: usize = 192 * 1024;

/// `raw`, a delegate's `owner_approval` as sent to the session socket, read
/// as a JSON object, unchanged, or why it is refused. Its content is
/// Relaycast's to validate (`400 invalid_owner_approval`); the core never
/// invents, fills in or alters it.
pub fn owner_approval_json(raw: &str) -> Result<serde_json::Map<String, Value>, String> {
    if raw.len() > MAX_OWNER_APPROVAL {
        return Err(format!(
            "owner_approval is at most {MAX_OWNER_APPROVAL} bytes."
        ));
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(object)) => Ok(object),
        _ => Err("owner_approval must be a JSON object.".into()),
    }
}

/// What a redeem came to, as the session socket answers it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Redeemed {
    /// Met: `consumed` when a single-use approval was used up by it;
    /// `checked`, for a pull request, the commit Cloud checked
    /// (`{head_sha}`), to pin the merge to.
    Ok {
        consumed: bool,
        checked: Option<Value>,
    },
    /// Cloud's reason code, or `unavailable`; with `condition_unmet`, the
    /// conditions that do not hold yet (the approval is not consumed).
    Refused { reason: String, unmet: Vec<Value> },
}

impl Redeemed {
    pub fn refused(reason: &str) -> Redeemed {
        Redeemed::Refused {
            reason: reason.into(),
            unmet: Vec::new(),
        }
    }

    pub fn to_value(&self) -> Value {
        match self {
            Redeemed::Ok {
                consumed,
                checked: Some(checked),
            } => json!({"ok": true, "consumed": consumed, "checked": checked}),
            Redeemed::Ok { consumed, .. } => json!({"ok": true, "consumed": consumed}),
            Redeemed::Refused { reason, unmet } if unmet.is_empty() => {
                json!({"ok": false, "reason": reason})
            }
            Redeemed::Refused { reason, unmet } => {
                json!({"ok": false, "reason": reason, "unmet": unmet})
            }
        }
    }
}

/// An approval id as Cloud issues them: `apv_` and 8 to 64 letters and
/// digits.
pub fn is_approval_id(value: &str) -> bool {
    value.strip_prefix("apv_").is_some_and(|rest| {
        (8..=64).contains(&rest.len()) && rest.bytes().all(|b| b.is_ascii_alphanumeric())
    })
}

fn log(message: std::fmt::Arguments<'_>) {
    crate::relay::diagnostics::write(format_args!("relay: delegate approval: {message}"));
}

impl Core {
    /// Why approvals from owners' delegates cannot work here: on a gate-only
    /// install, [`GATE_ONLY`].
    pub(crate) fn delegation_unavailable(&self) -> Option<&'static str> {
        self.workspace()
            .is_some_and(|workspace| workspace.is_gate_only())
            .then_some(GATE_ONLY)
    }

    /// Cloud's attestation of `delegation`'s owner approval for
    /// `registration`, verified, when the delivery carries one
    /// (`has_owner_approval`), the setting is not `off`, the install is not
    /// gate-only and the desktop is signed in. Every other outcome is
    /// `None`, logged when a call was made or refused.
    pub(crate) async fn attest_delegation(
        &self,
        registration: &Registration,
        delivery: &Delivery,
        token: &Secret,
    ) -> Option<Attestation> {
        if !delivery.has_owner_approval {
            return None;
        }
        let accept = self.store.read(accept);
        let id = &delivery.message_id;
        if accept == Accept::Off {
            log(format_args!("message {id}: {SETTING} is off"));
            return None;
        }
        if self.delegation_unavailable().is_some() {
            log(format_args!(
                "message {id}: not available on a gate-only install"
            ));
            return None;
        }
        let Some(account) = self.plugins.cloud.account() else {
            log(format_args!("message {id}: not signed in to Agent Relay"));
            return None;
        };
        let path = format!(
            "/workspaces/{}/messaging/delegation",
            segment(&account.workspace_id)
        );
        let body = json!({
            "recipient_agent_id": registration.agent_id,
            "recipient_token": token.expose(),
            "message_id": delivery.message_id,
            "accept": accept.name(),
        });
        let answer = match self.plugins.cloud.request("POST", path, Some(body)).await {
            Ok(answer) => answer,
            Err(error) => {
                let reason = match error {
                    CloudError::Status { status, .. } => format!("HTTP {status}"),
                    other => other.to_string(),
                };
                log(format_args!("message {id}: Cloud did not attest: {reason}"));
                return None;
            }
        };
        let jws = match (answer["verdict"].as_str(), answer["attestation"].as_str()) {
            (Some("delegate"), Some(jws)) => jws.to_string(),
            _ => {
                let reason = answer["reason"].as_str().unwrap_or("none");
                log(format_args!("message {id}: no delegate verdict: {reason}"));
                return None;
            }
        };
        let kid = key_id(&jws).unwrap_or_default();
        let Some(keys) = self.delegation_keys.for_kid(&kid).await else {
            log(format_args!(
                "message {id}: Cloud's delegation keys could not be read"
            ));
            return None;
        };
        let expected = Expected {
            workspace_id: &account.workspace_id,
            message_id: &delivery.message_id,
            recipient_agent_id: &registration.agent_id,
            sender_id: delivery.sender_id.as_deref(),
            now: crate::relay::state::now_ms() / 1000,
        };
        match verify(&jws, &keys, expected) {
            // The person may have turned delegation off or narrowed it, or
            // the install become gate-only, while Cloud and the keys were
            // asked: the choice in force now decides.
            Ok(claims)
                if self.delegation_unavailable().is_some()
                    || !self.store.read(self::accept).permits(&claims.standing) =>
            {
                log(format_args!(
                    "message {id}: {SETTING} no longer accepts this approval"
                ));
                None
            }
            Ok(claims) => {
                log(format_args!(
                    "message {id}: verified approval {} (grant {}, jti {})",
                    claims.approval_id, claims.grant_id, claims.jti
                ));
                Some(Attestation { claims, jws })
            }
            Err(refusal) => {
                log(format_args!("message {id}: attestation refused: {refusal}"));
                None
            }
        }
    }

    /// `text` with the delegate line (`policy::delegate_line`) under its
    /// attribution when Cloud attests the delivery's owner approval
    /// ([`Self::attest_delegation`]); otherwise `text` as it is.
    pub(crate) async fn with_delegation(
        &self,
        registration: &Registration,
        delivery: &Delivery,
        token: &Secret,
        text: String,
    ) -> String {
        use crate::relay::delivery::policy::{delegate_framed, with_delegate_line};
        // An owner or leader frame keeps its line; a verified delegate line
        // goes under it (design §9.1).
        if !delivery.has_owner_approval || delegate_framed(&text) {
            return text;
        }
        match self.attest_delegation(registration, delivery, token).await {
            // A config_change only ever changes this session, and never its
            // delegation settings (Cloud refuses these too): otherwise the
            // message stays a peer's.
            Some(attestation)
                if attestation.claims.actions.iter().any(|action| {
                    action.config_change().is_some_and(|(agent, setting, _)| {
                        agent != registration.agent_id
                            || NEVER_CHANGED_BY_DELEGATES.contains(&setting)
                    })
                }) =>
            {
                log(format_args!(
                    "message {}: a config_change of another agent or of a delegation setting",
                    delivery.message_id
                ));
                text
            }
            Some(attestation) => {
                self.delegation_recipients.remember(
                    &attestation.claims.approval_id,
                    &attestation.claims.recipient_agent_id,
                );
                let delegate = delivery.sender.as_deref().unwrap_or("a teammate");
                with_delegate_line(&text, delegate, &attestation.claims)
            }
            None => text,
        }
    }

    /// Redeems single-use approval `approval_id` for `action`, as
    /// `registration`'s own agent with its `token`, right before the
    /// session acts on it (`POST /messaging/delegation/redeem`).
    pub(crate) async fn redeem_delegation(
        &self,
        registration: &Registration,
        token: &Secret,
        approval_id: &str,
        action: &Action,
    ) -> Redeemed {
        let unavailable = || Redeemed::refused("unavailable");
        if self.delegation_unavailable().is_some() {
            return unavailable();
        }
        let Some(account) = self.plugins.cloud.account() else {
            return unavailable();
        };
        let path = format!(
            "/workspaces/{}/messaging/delegation/redeem",
            segment(&account.workspace_id)
        );
        let body = json!({
            "recipient_agent_id": registration.agent_id,
            "recipient_token": token.expose(),
            "approval_id": approval_id,
            "action": {"class": action.class, "target": action.target},
        });
        match self.plugins.cloud.request("POST", path, Some(body)).await {
            Ok(answer) if answer["ok"].as_bool() == Some(true) => {
                log(format_args!("redeemed approval {approval_id}"));
                // Only a full commit id is passed on as what was checked.
                let checked = answer["checked"]["head_sha"]
                    .as_str()
                    .filter(|sha| {
                        sha.len() == 40
                            && sha.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
                    })
                    .map(|sha| json!({"head_sha": sha}));
                Redeemed::Ok {
                    consumed: answer["consumed"].as_bool() == Some(true),
                    checked,
                }
            }
            Ok(answer) => {
                let reason = answer["reason"]
                    .as_str()
                    .filter(|reason| {
                        !reason.is_empty()
                            && reason.len() <= 64
                            && reason.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
                    })
                    .unwrap_or("refused")
                    .to_string();
                log(format_args!(
                    "approval {approval_id} not redeemed: {reason}"
                ));
                // The unmet conditions, as v1 conditions only.
                let unmet = answer["unmet"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|condition| {
                        serde_json::from_value::<Condition>((*condition).clone())
                            .is_ok_and(|condition| condition.is_valid())
                    })
                    .take(MAX_CONDITIONS)
                    .cloned()
                    .collect();
                Redeemed::Refused { reason, unmet }
            }
            // Cloud's refusal of the request itself (a 4xx) is a refusal;
            // anything else leaves the approval as it was.
            Err(CloudError::Status { status, .. }) if (400..500).contains(&status) => {
                log(format_args!(
                    "approval {approval_id} not redeemed: HTTP {status}"
                ));
                Redeemed::refused("refused")
            }
            Err(_) => unavailable(),
        }
    }

    /// Withdraws approval `approval_id`, which `registration`'s own agent
    /// sent as a delegate (`POST /messaging/delegation/withdraw`): narrowing
    /// only, for a later "no" from the owner. `{"ok":true}` or
    /// `{"ok":false,"reason":…}`, `unavailable` when Cloud cannot be asked.
    pub(crate) async fn withdraw_delegation(
        &self,
        registration: &Registration,
        token: &Secret,
        approval_id: &str,
    ) -> Value {
        let refused = |reason: &str| json!({"ok": false, "reason": reason});
        if self.delegation_unavailable().is_some() {
            return refused("unavailable");
        }
        let Some(account) = self.plugins.cloud.account() else {
            return refused("unavailable");
        };
        let path = format!(
            "/workspaces/{}/messaging/delegation/withdraw",
            segment(&account.workspace_id)
        );
        let body = json!({
            "delegate_agent_id": registration.agent_id,
            "delegate_token": token.expose(),
            "approval_id": approval_id,
        });
        match self.plugins.cloud.request("POST", path, Some(body)).await {
            Ok(answer) if answer["ok"].as_bool() == Some(true) => {
                log(format_args!("withdrew approval {approval_id}"));
                json!({"ok": true})
            }
            Ok(answer) => refused(
                answer["reason"]
                    .as_str()
                    .filter(|reason| {
                        !reason.is_empty()
                            && reason.len() <= 64
                            && reason.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
                    })
                    .unwrap_or("refused"),
            ),
            Err(CloudError::Status { status, .. }) if (400..500).contains(&status) => {
                refused("refused")
            }
            Err(_) => refused("unavailable"),
        }
    }
}

#[cfg(test)]
#[path = "delegation/test_support.rs"]
pub(crate) mod test_support;

#[cfg(test)]
#[path = "delegation/tests.rs"]
mod tests;
