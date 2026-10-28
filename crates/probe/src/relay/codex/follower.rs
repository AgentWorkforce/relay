//! Passive following and one-action decisions through the existing owning
//! Codex window. The core binds this facade to verified mobile-origin tickets.
//! It never resumes a thread, becomes its owner, or changes provider policy.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{Duration, Instant};

mod state;
mod wire;
pub use state::{ApprovalKind, ApprovalRequest, Event, Registry};
pub use wire::Socket;

const RPC_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_ATTEMPTS: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    Unavailable,
    Disconnected,
    TimedOut,
    InvalidFrame,
    InvalidState,
    UnsupportedVersion,
    OwnerChanged,
    Refused,
}

/// Bounded JSON frames; implementations must honor the absolute deadline.
pub trait Transport {
    fn send(&mut self, message: &Value) -> Result<(), Error>;
    fn receive(&mut self, deadline: Instant) -> Result<Option<Value>, Error>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Accept,
    Decline,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DecisionOutcome {
    /// The window acknowledged routing; it may already have resolved the
    /// request on desktop. This never claims the action was approved/applied.
    AcknowledgedUnconfirmed,
    /// No new write occurred because the request/authority was no longer valid.
    Refused,
    /// A write may have happened. Never send this request again.
    InDoubt,
}

pub struct Follower<T: Transport> {
    transport: T,
    client: String,
    registry: Registry,
    connected: bool,
    attempts: HashMap<String, DecisionOutcome>,
}

impl Follower<Socket> {
    pub fn connect(config: &super::CodexConfig, thread: &str, owner: &str) -> Result<Self, Error> {
        Self::attach(Socket::connect(&config.ipc_socket)?, thread, owner)
    }
}

impl<T: Transport> Follower<T> {
    /// The caller must obtain `owner` from the exact configured local window
    /// router. Attachment rediscovers it and refuses replacement ownership.
    pub fn attach(transport: T, thread: &str, owner: &str) -> Result<Self, Error> {
        let mut follower = Self {
            transport,
            client: "initializing-client".into(),
            registry: Registry::new(thread, owner)?,
            connected: true,
            attempts: HashMap::new(),
        };
        let reply = follower.exchange(
            "initialize",
            0,
            json!({"clientType":"agent-relay-desktop"}),
            None,
        )?;
        follower.client = reply["result"]["clientId"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 256)
            .ok_or(Error::InvalidState)?
            .into();
        follower.verify_owner()?;
        follower.follow(true)?;
        Ok(follower)
    }

    pub fn registry(&self) -> &Registry {
        &self.registry
    }

    pub fn poll(&mut self, timeout: Duration) -> Result<Vec<Event>, Error> {
        if !self.connected {
            return Err(Error::Disconnected);
        }
        match self
            .transport
            .receive(Instant::now() + timeout.min(RPC_TIMEOUT))
        {
            Ok(Some(value)) => self.consume(&value),
            Ok(None) => Ok(Vec::new()),
            Err(error) => {
                self.invalidate();
                Err(error)
            }
        }
    }

    /// Stop following without denying or otherwise changing desktop prompts.
    pub fn close(&mut self) -> Result<(), Error> {
        let result = if self.connected {
            self.follow(false)
        } else {
            Ok(())
        };
        self.invalidate();
        result
    }

    /// `admit` must durably consume the owner ticket before returning true.
    /// Durable consumption identifies the stable provider request independently
    /// of connection/window changes; live authority pins this generation and
    /// exact request handle. Reconnection cannot revive consumption. The facade's
    /// in-memory ledger only guards duplicate calls during this connection.
    pub fn decide(
        &mut self,
        request: &ApprovalRequest,
        decision: Decision,
        admit: &(dyn Fn() -> bool + Send + Sync),
    ) -> DecisionOutcome {
        if let Some(previous) = self.attempts.get(request.key()) {
            return previous.clone();
        }
        if !self.connected
            || self.attempts.len() >= MAX_ATTEMPTS
            || !self.registry.contains(request)
            || !request.allows(decision)
        {
            return DecisionOutcome::Refused;
        }
        if self.verify_owner().is_err() || !self.registry.contains(request) {
            return DecisionOutcome::Refused;
        }
        // Drain a new same-owner snapshot after all discovery/preflight work;
        // a queued desktop decision or changed request must invalidate this handle.
        if self.refresh().is_err() || !self.registry.contains(request) {
            return DecisionOutcome::Refused;
        }
        // A failed admission has not attempted a provider write. Its owner
        // may retry after proof recovers; the durable admission ledger still
        // rejects a request consumed before a later proof check failed.
        if !admit() {
            return DecisionOutcome::Refused;
        }
        self.attempts
            .insert(request.key().into(), DecisionOutcome::InDoubt);
        let params = json!({"conversationId":self.registry.thread(), "requestId":request.id(),
            "decision":match decision { Decision::Accept => "accept", Decision::Decline => "decline" }});
        let owner = self.registry.owner().to_string();
        let outcome = match self.exchange(request.kind().method(), 1, params, Some(&owner)) {
            Ok(_) => DecisionOutcome::AcknowledgedUnconfirmed,
            Err(_) => DecisionOutcome::InDoubt,
        };
        self.attempts.insert(request.key().into(), outcome.clone());
        outcome
    }

    /// Revalidate the existing owner and obtain a new validated snapshot.
    pub fn synchronize(&mut self) -> Result<(), Error> {
        self.verify_owner()?;
        self.refresh()
    }

    fn refresh(&mut self) -> Result<(), Error> {
        let before = self.registry.snapshots();
        self.follow(true)?;
        let deadline = Instant::now() + RPC_TIMEOUT;
        while self.registry.snapshots() == before {
            if Instant::now() >= deadline {
                self.invalidate();
                return Err(Error::TimedOut);
            }
            self.poll(deadline.saturating_duration_since(Instant::now()))?;
        }
        Ok(())
    }

    fn verify_owner(&mut self) -> Result<(), Error> {
        let response = self.exchange(
            "thread-owner-discovery",
            1,
            json!({"hostId":"local","conversationId":self.registry.thread()}),
            None,
        )?;
        if response["handledByClientId"].as_str() != Some(self.registry.owner()) {
            self.invalidate();
            return Err(Error::OwnerChanged);
        }
        Ok(())
    }

    fn follow(&mut self, following: bool) -> Result<(), Error> {
        let result = self.transport.send(&json!({"type":"broadcast","method":"thread-stream-following-changed",
            "version":1,"sourceClientId":self.client,"targetClientIds":[self.registry.owner()],
            "params":{"hostId":"local","conversationId":self.registry.thread(),"following":following}}));
        if result.is_err() {
            self.invalidate();
        }
        result
    }

    fn exchange(
        &mut self,
        method: &str,
        version: u32,
        params: Value,
        target: Option<&str>,
    ) -> Result<Value, Error> {
        let result = self.exchange_inner(method, version, params, target);
        if result.is_err() {
            self.invalidate();
        }
        result
    }

    fn exchange_inner(
        &mut self,
        method: &str,
        version: u32,
        params: Value,
        target: Option<&str>,
    ) -> Result<Value, Error> {
        let id = crate::relay::store::random_uuid();
        let mut request = json!({"type":"request","method":method,"version":version,
            "requestId":id,"sourceClientId":self.client,"params":params,"timeoutMs":12000});
        if let Some(target) = target {
            request["targetClientId"] = target.into();
        }
        self.transport.send(&request)?;
        let deadline = Instant::now() + RPC_TIMEOUT;
        loop {
            if Instant::now() >= deadline {
                return Err(Error::TimedOut);
            }
            let value = self.transport.receive(deadline)?.ok_or(Error::TimedOut)?;
            if value["type"] == "response" && value["requestId"] == id {
                return if value["resultType"] == "success" {
                    if target
                        .is_some_and(|owner| value["handledByClientId"].as_str() != Some(owner))
                    {
                        return Err(Error::OwnerChanged);
                    }
                    Ok(value)
                } else {
                    Err(Error::Refused)
                };
            }
            self.consume(&value)?;
        }
    }

    fn consume(&mut self, value: &Value) -> Result<Vec<Event>, Error> {
        if value["type"] == "client-discovery-request" {
            if let Some(id) = value["requestId"].as_str() {
                if let Err(error) = self.transport.send(&super::ipc::discovery_decline(id)) {
                    self.invalidate();
                    return Err(error);
                }
            }
            return Ok(Vec::new());
        }
        let result = self.registry.apply(value);
        if result.is_err() {
            self.invalidate();
        }
        result
    }

    fn invalidate(&mut self) {
        self.connected = false;
        self.registry.invalidate();
    }
}

#[cfg(test)]
mod tests;
