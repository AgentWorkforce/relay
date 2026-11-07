//! Validated owner snapshots. Request handles cannot cross connection epochs.
use super::Error;
use serde_json::Value;
use sha2::{Digest, Sha256};

mod patches;
pub(super) const MAX_STATE: usize = 4 * 1024 * 1024;
const MAX_REQUESTS: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalKind {
    Command,
    File,
}
impl ApprovalKind {
    pub(super) fn method(self) -> &'static str {
        match self {
            Self::Command => "thread-follower-command-approval-decision",
            Self::File => "thread-follower-file-approval-decision",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ApprovalRequest {
    key: String,
    fingerprint: String,
    id: Value,
    kind: ApprovalKind,
    turn: String,
    item: String,
    params: Value,
    item_details: Option<Value>,
}
impl ApprovalRequest {
    pub fn key(&self) -> &str {
        &self.key
    }
    pub(crate) fn item_details(&self) -> Option<&Value> {
        self.item_details.as_ref()
    }
    pub fn id(&self) -> &Value {
        &self.id
    }
    pub fn kind(&self) -> ApprovalKind {
        self.kind
    }
    pub fn turn(&self) -> &str {
        &self.turn
    }
    pub fn item(&self) -> &str {
        &self.item
    }
    /// May contain credentials or private paths. Do not log or send wholesale.
    pub fn params(&self) -> &Value {
        &self.params
    }
    /// Respect the provider's offered decisions. Null/absent is the legacy
    /// ordinary one-action prompt; unknown or broader choices never widen it.
    pub fn allows(&self, decision: super::Decision) -> bool {
        let word = match decision {
            super::Decision::Accept => "accept",
            super::Decision::Decline => "decline",
        };
        match self.params.get("availableDecisions") {
            None | Some(Value::Null) => true,
            Some(Value::Array(choices)) => choices.iter().any(|choice| choice == word),
            Some(_) => false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    Snapshot {
        revision: u64,
    },
    Updated {
        revision: u64,
    },
    /// Removal alone never says which client decided or what it decided.
    RequestGone {
        key: String,
    },
}

pub struct Registry {
    thread: String,
    owner: String,
    generation: String,
    revision: Option<u64>,
    snapshots: u64,
    state: Option<Value>,
    pending: Vec<ApprovalRequest>,
}

impl Registry {
    pub fn new(thread: &str, owner: &str) -> Result<Self, Error> {
        if !crate::relay::store::is_uuid(thread) || owner.is_empty() || owner.len() > 256 {
            return Err(Error::InvalidState);
        }
        Ok(Self {
            thread: thread.into(),
            owner: owner.into(),
            generation: crate::relay::store::random_uuid(),
            revision: None,
            snapshots: 0,
            state: None,
            pending: Vec::new(),
        })
    }
    pub fn thread(&self) -> &str {
        &self.thread
    }
    pub fn owner(&self) -> &str {
        &self.owner
    }
    pub fn generation(&self) -> &str {
        &self.generation
    }
    pub fn revision(&self) -> Option<u64> {
        self.revision
    }
    pub fn pending(&self) -> &[ApprovalRequest] {
        &self.pending
    }
    /// Validated local-owner state; callers must apply their own data-minimizing
    /// projection and consent before forwarding anything off this computer.
    pub fn state(&self) -> Option<&Value> {
        self.state.as_ref()
    }
    pub fn contains(&self, request: &ApprovalRequest) -> bool {
        self.pending.contains(request)
    }
    pub(super) fn snapshots(&self) -> u64 {
        self.snapshots
    }
    pub(super) fn invalidate(&mut self) {
        self.generation = crate::relay::store::random_uuid();
        self.state = None;
        self.revision = None;
        self.pending.clear();
    }

    pub fn apply(&mut self, message: &Value) -> Result<Vec<Event>, Error> {
        let result = self.apply_inner(message);
        if result.is_err() {
            self.invalidate();
        }
        result
    }

    fn apply_inner(&mut self, message: &Value) -> Result<Vec<Event>, Error> {
        if message["type"] != "broadcast" {
            return Ok(Vec::new());
        }
        if message["method"] == "ipc-connection-reset" {
            return Err(Error::Disconnected);
        }
        if message["sourceClientId"].as_str() != Some(&self.owner) {
            return Ok(Vec::new());
        }
        let params = &message["params"];
        if message["method"] == "client-status-changed"
            && params["clientId"].as_str() == Some(&self.owner)
            && params["status"] == "disconnected"
        {
            return Err(Error::Disconnected);
        }
        if message["method"] != "thread-stream-state-changed"
            || params["conversationId"].as_str() != Some(&self.thread)
            || params["hostId"] != "local"
        {
            return Ok(Vec::new());
        }
        if message["version"].as_u64() != Some(11) {
            return Err(Error::UnsupportedVersion);
        }
        let change = &params["change"];
        let revision = change["revision"].as_u64().ok_or(Error::InvalidState)?;
        match change["type"].as_str() {
            Some("snapshot") => self.snapshot(change["conversationState"].clone(), revision),
            Some("patches") => self.patch(change, revision),
            _ => Err(Error::InvalidState),
        }
    }

    fn snapshot(&mut self, state: Value, revision: u64) -> Result<Vec<Event>, Error> {
        if self.revision.is_some_and(|current| revision < current) {
            return Err(Error::InvalidState);
        }
        if self.revision == Some(revision) && self.state.as_ref() != Some(&state) {
            return Err(Error::InvalidState);
        }
        let events = self.replace(state, revision, Event::Snapshot { revision })?;
        self.snapshots = self.snapshots.checked_add(1).ok_or(Error::InvalidState)?;
        Ok(events)
    }

    fn patch(&mut self, change: &Value, revision: u64) -> Result<Vec<Event>, Error> {
        let base = change["baseRevision"].as_u64().ok_or(Error::InvalidState)?;
        if self.revision != Some(base) || base.checked_add(1) != Some(revision) {
            return Err(Error::InvalidState);
        }
        let state = patches::apply(
            self.state.as_ref().ok_or(Error::InvalidState)?,
            &change["patches"],
        )?;
        self.replace(state, revision, Event::Updated { revision })
    }

    fn replace(&mut self, state: Value, revision: u64, event: Event) -> Result<Vec<Event>, Error> {
        if state["id"].as_str() != Some(&self.thread)
            || state.get("hostId").is_some_and(|host| host != "local")
            || serde_json::to_vec(&state)
                .map_err(|_| Error::InvalidState)?
                .len()
                > MAX_STATE
        {
            return Err(Error::InvalidState);
        }
        let requests = state["requests"]
            .as_array()
            .filter(|r| r.len() <= MAX_REQUESTS)
            .ok_or(Error::InvalidState)?;
        let mut pending = Vec::new();
        let mut ids = Vec::new();
        for request in requests {
            let id = &request["id"];
            if !valid_id(id) || ids.contains(id) {
                return Err(Error::InvalidState);
            }
            ids.push(id.clone());
            if let Some(request) = self.request(request, &state)? {
                pending.push(request);
            }
        }
        let mut events = vec![event];
        for previous in &self.pending {
            if !pending.contains(previous) {
                events.push(Event::RequestGone {
                    key: previous.key.clone(),
                });
            }
        }
        self.pending = pending;
        self.state = Some(state);
        self.revision = Some(revision);
        Ok(events)
    }

    fn request(&self, value: &Value, state: &Value) -> Result<Option<ApprovalRequest>, Error> {
        let kind = match value["method"].as_str() {
            Some("item/commandExecution/requestApproval") => ApprovalKind::Command,
            Some("item/fileChange/requestApproval") => ApprovalKind::File,
            _ => return Ok(None),
        };
        let params = &value["params"];
        // These prompts may widen permission scope beyond the individual
        // action. Keep them in the owning desktop UI for this first slice.
        if ["grantRoot", "additionalPermissions"]
            .iter()
            .any(|field| params.get(*field).is_some_and(|value| !value.is_null()))
        {
            return Ok(None);
        }
        if params["threadId"].as_str() != Some(&self.thread) {
            return Err(Error::InvalidState);
        }
        let turn = text_id(&params["turnId"])?;
        let item = text_id(&params["itemId"])?;
        let item_details = if kind == ApprovalKind::File {
            file_item(state, &turn, &item)
        } else {
            None
        };
        let encoded =
            serde_json::to_vec(&(value, &item_details)).map_err(|_| Error::InvalidState)?;
        if encoded.len() > 64 * 1024 {
            return Err(Error::InvalidState);
        }
        let fingerprint = format!("{:x}", Sha256::digest(&encoded));
        if let Some(previous) = self
            .pending
            .iter()
            .find(|request| request.fingerprint == fingerprint)
        {
            return Ok(Some(previous.clone()));
        }
        let occurrence = crate::relay::store::random_uuid();
        let mut hash = Sha256::new();
        for part in [
            occurrence.as_bytes(),
            self.generation.as_bytes(),
            self.owner.as_bytes(),
            self.thread.as_bytes(),
            &encoded,
        ] {
            hash.update(part);
            hash.update([0]);
        }
        Ok(Some(ApprovalRequest {
            key: format!("{:x}", hash.finalize()),
            fingerprint,
            id: value["id"].clone(),
            kind,
            turn,
            item,
            params: params.clone(),
            item_details,
        }))
    }
}

fn text_id(value: &Value) -> Result<String, Error> {
    value
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 256)
        .map(str::to_string)
        .ok_or(Error::InvalidState)
}
fn valid_id(value: &Value) -> bool {
    text_id(value).is_ok() || value.as_i64().is_some() || value.as_u64().is_some()
}

// Unknown or ambiguous window item layouts cannot support a remote file
// summary. The core leaves those requests in the owning desktop UI.
fn file_item(state: &Value, turn: &str, item: &str) -> Option<Value> {
    let turns: Vec<_> = state["turns"]
        .as_array()?
        .iter()
        .filter(|value| value["id"] == turn)
        .collect();
    if turns.len() != 1 {
        return None;
    }
    let items: Vec<_> = turns[0]["items"]
        .as_array()?
        .iter()
        .filter(|value| value["id"] == item && value["type"] == "fileChange")
        .collect();
    if items.len() != 1 {
        return None;
    }
    let mut item = items[0].clone();
    item.as_object_mut()?
        .insert("_relayBaseDirectory".into(), state["cwd"].clone());
    Some(item)
}
