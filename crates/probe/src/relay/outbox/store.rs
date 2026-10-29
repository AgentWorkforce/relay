//! `CodexOutbox`: durable, ordered storage for messages bound for Codex
//! threads (and, in its own file, Claude sessions).
//!
//! ```text
//! held ─▶ pending  (the local user approved it)
//! held ─▶ rejected (the local user declined it)
//! pending ─▶ sending ─▶ delivered ─▶ completed   (Codex answered)
//!    ▲          │            └─────▶ aborted     (the turn was interrupted)
//!    └──────────┘ retry
//! pending ─▶ failed (Codex refused it)   pending ─▶ expired (never deliverable)
//! ```
//!
//! Every change is committed before the call returns, so a queued message
//! survives the app quitting or crashing. The same file holds the inbound
//! cursor, the tombstones of pruned messages, and (when journaled) the ack
//! journal, written by triggers in the same transaction as each state
//! change so a crash between a transition and its callback never loses an
//! ack.

use super::messages::{AckStatus, CodexInboundAck};
use super::{create_private_dir, from_seconds, make_private_file, seconds, OutboxError, Result};
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row, TransactionBehavior};
use std::path::Path;
use std::sync::Mutex;
use std::time::SystemTime;

/// Where a message is in its life.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum OutboxState {
    Held,
    Pending,
    Sending,
    Delivered,
    Completed,
    Aborted,
    Failed,
    Expired,
    Rejected,
}

impl OutboxState {
    pub fn as_str(self) -> &'static str {
        match self {
            OutboxState::Held => "held",
            OutboxState::Pending => "pending",
            OutboxState::Sending => "sending",
            OutboxState::Delivered => "delivered",
            OutboxState::Completed => "completed",
            OutboxState::Aborted => "aborted",
            OutboxState::Failed => "failed",
            OutboxState::Expired => "expired",
            OutboxState::Rejected => "rejected",
        }
    }

    pub fn parse(value: &str) -> Option<OutboxState> {
        Some(match value {
            "held" => OutboxState::Held,
            "pending" => OutboxState::Pending,
            "sending" => OutboxState::Sending,
            "delivered" => OutboxState::Delivered,
            "completed" => OutboxState::Completed,
            "aborted" => OutboxState::Aborted,
            "failed" => OutboxState::Failed,
            "expired" => OutboxState::Expired,
            "rejected" => OutboxState::Rejected,
            _ => return None,
        })
    }

    /// Nothing more will happen to the message.
    pub fn is_final(self) -> bool {
        matches!(
            self,
            OutboxState::Completed
                | OutboxState::Aborted
                | OutboxState::Failed
                | OutboxState::Expired
                | OutboxState::Rejected
        )
    }

    /// The Codex ack status for a stored state: waiting states are
    /// `queued`, held is `held_for_approval`, final states are themselves.
    pub fn codex_ack_status(self) -> AckStatus {
        match self {
            OutboxState::Held => AckStatus::HeldForApproval,
            OutboxState::Pending | OutboxState::Sending => AckStatus::Queued,
            OutboxState::Delivered => AckStatus::Delivered,
            OutboxState::Completed => AckStatus::Completed,
            OutboxState::Aborted => AckStatus::Aborted,
            OutboxState::Failed => AckStatus::Failed,
            OutboxState::Expired => AckStatus::Expired,
            OutboxState::Rejected => AckStatus::Rejected,
        }
    }
}

/// A message waiting to go, or already gone, into a thread.
#[derive(Clone, Debug, PartialEq)]
pub struct CodexOutboxMessage {
    /// Chosen by the sender. Doubles as the idempotency key here and as the
    /// `clientUserMessageId` Codex records, which is what makes retries safe.
    pub id: String,
    pub thread_id: String,
    pub text: String,
    /// Who sent the message; `None` for messages the local user composed.
    pub sender_id: Option<String>,
    pub sender_name: Option<String>,
    pub state: OutboxState,
    pub enqueued_at: SystemTime,
    pub expires_at: SystemTime,
    pub attempts: u32,
    pub next_attempt_at: SystemTime,
    pub last_attempt_at: Option<SystemTime>,
    pub last_error: Option<String>,
    pub turn_id: Option<String>,
    pub reply: Option<String>,
    pub updated_at: SystemTime,
    /// When the local user approved this message. An approved message stays
    /// cleared to go even if its thread is later switched to asking first.
    pub approved_at: Option<SystemTime>,
    /// How the latest send went out. A send in doubt is settled by the rules
    /// of the route it actually took.
    pub route: Option<String>,
}

/// The fields a new message is stored with.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NewMessage {
    pub id: String,
    pub thread_id: String,
    pub text: String,
    pub sender_id: Option<String>,
    pub sender_name: Option<String>,
}

impl NewMessage {
    pub fn new(
        id: impl Into<String>,
        thread_id: impl Into<String>,
        text: impl Into<String>,
    ) -> Self {
        NewMessage {
            id: id.into(),
            thread_id: thread_id.into(),
            text: text.into(),
            sender_id: None,
            sender_name: None,
        }
    }

    pub fn sender(mut self, id: impl Into<String>, name: impl Into<String>) -> Self {
        self.sender_id = Some(id.into());
        self.sender_name = Some(name.into());
        self
    }
}

/// One journaled ack not yet confirmed by the cloud.
#[derive(Clone, Debug, PartialEq)]
pub struct PendingAck {
    pub sequence: i64,
    pub ack: CodexInboundAck,
}

const COLUMNS: &str = "id, thread_id, text, sender_id, sender_name, state, enqueued_at, expires_at, \
    attempts, next_attempt_at, last_attempt_at, last_error, turn_id, reply, updated_at, approved_at, route";

const FINAL_STATES: &str = "('completed', 'aborted', 'failed', 'expired', 'rejected')";

/// One `inbound_acks` row: sequence, id, state, reply, error, time.
type AckRow = (i64, String, String, Option<String>, Option<String>, f64);

/// The SQLite store. Safe to use from any thread.
pub struct CodexOutbox {
    connection: Mutex<Connection>,
}

impl CodexOutbox {
    /// Opens (creating if needed) the store at `path`, private to this user.
    pub fn open(path: impl AsRef<Path>) -> Result<CodexOutbox> {
        Self::open_with(path.as_ref(), false)
    }

    /// Opens the store and journals every insert and state change as an ack
    /// for the cloud. The journal triggers live in the file, so later opens
    /// of the same file keep journaling.
    pub fn open_journaled(path: impl AsRef<Path>) -> Result<CodexOutbox> {
        Self::open_with(path.as_ref(), true)
    }

    fn open_with(path: &Path, journal_acks: bool) -> Result<CodexOutbox> {
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            create_private_dir(parent)?;
        }
        let connection = Connection::open(path)?;
        make_private_file(path)?;
        connection.pragma_update(None, "journal_mode", "wal")?;
        connection.pragma_update(None, "synchronous", "full")?;
        connection.execute_batch(
            "create table if not exists messages (
                seq integer primary key autoincrement,
                id text not null unique,
                thread_id text not null,
                text text not null,
                sender_id text,
                sender_name text,
                state text not null,
                enqueued_at real not null,
                expires_at real not null,
                attempts integer not null default 0,
                next_attempt_at real not null,
                last_attempt_at real,
                last_error text,
                turn_id text,
                reply text,
                updated_at real not null,
                approved_at real,
                route text
            );
            create index if not exists messages_thread_state on messages (thread_id, state, seq);",
        )?;
        migrate_columns(&connection)?;
        connection.execute_batch(
            "create table if not exists inbound_retired (id text primary key, state text not null, at real not null);
            create table if not exists inbound_cursor (key text primary key, value text not null);
            create table if not exists inbound_acks (
                seq integer primary key autoincrement, id text not null,
                state text not null, reply text, error text, at real not null,
                acknowledged integer not null default 0
            );
            create table if not exists inbound_batch (slot integer primary key, through integer not null);",
        )?;
        if journal_acks {
            for (name, event) in [
                ("insert", "insert"),
                ("update", "update of state, reply, last_error"),
            ] {
                connection.execute_batch(&format!(
                    "create trigger if not exists inbound_ack_{name} after {event} on messages
                    begin
                        insert into inbound_acks (id, state, reply, error, at)
                        values (new.id, new.state, new.reply, new.last_error, new.updated_at);
                    end"
                ))?;
            }
        }
        Ok(CodexOutbox {
            connection: Mutex::new(connection),
        })
    }

    fn with<T>(&self, body: impl FnOnce(&mut Connection) -> rusqlite::Result<T>) -> Result<T> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| OutboxError::Sqlite("store lock poisoned".into()))?;
        Ok(body(&mut connection)?)
    }

    fn run(&self, sql: &str, values: impl rusqlite::Params) -> Result<usize> {
        self.with(|connection| connection.execute(sql, values))
    }

    fn query(&self, sql: &str, values: impl rusqlite::Params) -> Result<Vec<CodexOutboxMessage>> {
        self.with(|connection| {
            let mut statement = connection.prepare(sql)?;
            let rows = statement.query_map(values, read_message)?;
            rows.collect()
        })
    }

    // MARK: Writing

    /// Stores a message. Returns `false`, changing nothing, when a message
    /// with this id is already stored: enqueueing twice is harmless. A
    /// `held` message starts out of the delivery order until `approve`.
    pub fn enqueue(
        &self,
        message: &NewMessage,
        held: bool,
        expires_at: SystemTime,
        now: SystemTime,
    ) -> Result<bool> {
        let state = if held {
            OutboxState::Held
        } else {
            OutboxState::Pending
        };
        Ok(self.run(
            "insert or ignore into messages (id, thread_id, text, sender_id, sender_name, state, enqueued_at, expires_at, next_attempt_at, updated_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                message.id,
                message.thread_id,
                message.text,
                message.sender_id,
                message.sender_name,
                state.as_str(),
                seconds(now),
                seconds(expires_at),
                seconds(now),
                seconds(now)
            ],
        )? > 0)
    }

    /// Marks a message as being sent right now, through `route`. If the app
    /// dies before the outcome is stored, it stays `sending` and is settled
    /// later against the thread's session file.
    pub fn mark_sending(&self, id: &str, route: Option<&str>, now: SystemTime) -> Result<()> {
        self.run(
            "update messages set state = 'sending', attempts = attempts + 1, route = ?, last_attempt_at = ?, updated_at = ? where id = ?",
            params![route, seconds(now), seconds(now), id],
        )?;
        Ok(())
    }

    pub fn mark_delivered(&self, id: &str, turn_id: Option<&str>, now: SystemTime) -> Result<()> {
        self.run(
            "update messages set state = 'delivered', turn_id = ?, last_error = null, updated_at = ? where id = ?",
            params![turn_id, seconds(now), id],
        )?;
        Ok(())
    }

    /// Puts a message back in line to be tried again at `next_attempt_at`.
    pub fn mark_pending(
        &self,
        id: &str,
        error: Option<&str>,
        next_attempt_at: SystemTime,
        now: SystemTime,
    ) -> Result<()> {
        self.run(
            "update messages set state = 'pending', last_error = ?, next_attempt_at = ?, updated_at = ? where id = ?",
            params![error, seconds(next_attempt_at), seconds(now), id],
        )?;
        Ok(())
    }

    /// Puts a message back in line after a send that never went out (the
    /// route was not there), returning the attempt it was charged.
    pub fn mark_unsent(
        &self,
        id: &str,
        error: Option<&str>,
        next_attempt_at: SystemTime,
        now: SystemTime,
    ) -> Result<()> {
        self.run(
            "update messages set state = 'pending', attempts = max(attempts - 1, 0), last_error = ?, next_attempt_at = ?, updated_at = ? where id = ?",
            params![error, seconds(next_attempt_at), seconds(now), id],
        )?;
        Ok(())
    }

    /// Settles a message in a final state; an error keeps the earlier one
    /// when `None`.
    pub fn mark_finished(
        &self,
        id: &str,
        state: OutboxState,
        reply: Option<&str>,
        error: Option<&str>,
        now: SystemTime,
    ) -> Result<()> {
        if !state.is_final() {
            return Err(OutboxError::Sqlite(format!(
                "{} is not a final state",
                state.as_str()
            )));
        }
        self.run(
            "update messages set state = ?, reply = ?, last_error = coalesce(?, last_error), updated_at = ? where id = ?",
            params![state.as_str(), reply, error, seconds(now), id],
        )?;
        Ok(())
    }

    /// Approves a held message, putting it back in line. Returns `false`,
    /// changing nothing, if the message is not currently `held`.
    pub fn approve(&self, id: &str, now: SystemTime) -> Result<bool> {
        Ok(self.run(
            "update messages set state = 'pending', approved_at = ?, next_attempt_at = ?, updated_at = ? where id = ? and state = 'held'",
            params![seconds(now), seconds(now), seconds(now), id],
        )? > 0)
    }

    /// Takes a `pending` message back out of line to wait for approval, for
    /// a thread whose sharing was tightened after it was queued. Returns
    /// `false`, changing nothing, if the message is not currently `pending`.
    pub fn hold(&self, id: &str, now: SystemTime) -> Result<bool> {
        Ok(self.run(
            "update messages set state = 'held', updated_at = ? where id = ? and state = 'pending'",
            params![seconds(now), id],
        )? > 0)
    }

    /// Records a message refused on arrival, so a repeat of the same id is
    /// answered with the same refusal instead of being considered afresh.
    /// Returns `false`, changing nothing, when the id is already stored.
    pub fn record_rejected(
        &self,
        message: &NewMessage,
        reason: &str,
        now: SystemTime,
    ) -> Result<bool> {
        Ok(self.run(
            "insert or ignore into messages (id, thread_id, text, sender_id, sender_name, state, enqueued_at, expires_at, next_attempt_at, last_error, updated_at)
            values (?, ?, ?, ?, ?, 'rejected', ?, ?, ?, ?, ?)",
            params![
                message.id,
                message.thread_id,
                message.text,
                message.sender_id,
                message.sender_name,
                seconds(now),
                seconds(now),
                seconds(now),
                reason,
                seconds(now)
            ],
        )? > 0)
    }

    /// Declines a held message; it will never be delivered. Returns `false`,
    /// changing nothing, if the message is not currently `held`.
    pub fn reject(&self, id: &str, reason: Option<&str>, now: SystemTime) -> Result<bool> {
        Ok(self.run(
            "update messages set state = 'rejected', last_error = ?, updated_at = ? where id = ? and state = 'held'",
            params![reason, seconds(now), id],
        )? > 0)
    }

    /// Expires pending or held messages whose time is up and returns the
    /// ones that actually transitioned. Guarded by state, so a row rejected
    /// or delivered in the meantime is left alone.
    pub fn expire(&self, now: SystemTime) -> Result<Vec<CodexOutboxMessage>> {
        let candidates = self.query(
            &format!("select {COLUMNS} from messages where state in ('pending', 'held') and expires_at <= ? order by seq"),
            params![seconds(now)],
        )?;
        let mut expired = Vec::new();
        for candidate in candidates {
            let changed = self.run(
                "update messages set state = 'expired', last_error = ?, updated_at = ? where id = ? and state in ('pending', 'held')",
                params!["expired before the thread could take it", seconds(now), candidate.id],
            )?;
            if changed > 0 {
                if let Some(message) = self.message(&candidate.id)? {
                    expired.push(message);
                }
            }
        }
        Ok(expired)
    }

    /// Drops finished messages last touched before `cutoff`, keeping a
    /// compact tombstone of each so a cloud replay never revives a finished
    /// prompt. Unconfirmed acks and their audit rows survive until the cloud
    /// accepts them.
    pub fn prune(&self, finished_before: SystemTime) -> Result<()> {
        let cutoff = seconds(finished_before);
        self.run(
            &format!(
                "insert or ignore into inbound_retired (id, state, at)
                select id, state, updated_at from messages
                where state in {FINAL_STATES}
                and updated_at < ? and not exists (
                    select 1 from inbound_acks where inbound_acks.id = messages.id and acknowledged = 0)"
            ),
            params![cutoff],
        )?;
        self.run(
            "delete from inbound_acks where acknowledged = 1 and at < ?",
            params![cutoff],
        )?;
        self.run(
            &format!(
                "delete from messages where state in {FINAL_STATES} and updated_at < ? and not exists (
                    select 1 from inbound_acks where inbound_acks.id = messages.id and acknowledged = 0)"
            ),
            params![cutoff],
        )?;
        Ok(())
    }

    // MARK: Cursor and acks

    /// Advances the inbound cursor to `id`. Call only after receive has
    /// committed the message (refusals included); if this fails, replay is
    /// safe because the inbox dedupes.
    pub fn checkpoint(&self, id: &str) -> Result<()> {
        if self.message(id)?.is_none() && self.retired_ack(id)?.is_none() {
            return Err(OutboxError::Sqlite("message not durable".into()));
        }
        self.run(
            "insert or replace into inbound_cursor values ('since', ?)",
            params![id],
        )?;
        Ok(())
    }

    /// Forgets the cursor only while it is still `expected`, atomically. A
    /// cursor the server has retired does not invalidate local delivery
    /// evidence: dedupe rows and acks stay.
    pub fn reset_cursor_if_matching(&self, expected: &str) -> Result<()> {
        self.run(
            "delete from inbound_cursor where key = 'since' and value = ?",
            params![expected],
        )?;
        Ok(())
    }

    /// The id of the last message durably received, if any.
    pub fn cursor(&self) -> Result<Option<String>> {
        self.with(|connection| {
            connection
                .query_row(
                    "select value from inbound_cursor where key = 'since'",
                    [],
                    |row| row.get(0),
                )
                .optional()
        })
    }

    /// The final ack of a message whose content was pruned, if `id` is one.
    pub fn retired_ack(&self, id: &str) -> Result<Option<CodexInboundAck>> {
        let row: Option<(String, f64)> = self.with(|connection| {
            connection
                .query_row(
                    "select state, at from inbound_retired where id = ?",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
        })?;
        row.map(|(state, at)| {
            let status = AckStatus::parse(&state)
                .ok_or_else(|| OutboxError::Sqlite("cannot read retired message".into()))?;
            Ok(CodexInboundAck::new(id, status, stored_time(at)?))
        })
        .transpose()
    }

    /// Journals the current ack of `id` again, for a redelivered message:
    /// from its tombstone if it was pruned, otherwise from its row.
    pub fn reack(&self, id: &str) -> Result<()> {
        self.run(
            "insert into inbound_acks (id, state, at)
            select id, state, at from inbound_retired where id = ?
            and not exists (select 1 from messages where messages.id = inbound_retired.id)",
            params![id],
        )?;
        self.run(
            "insert into inbound_acks (id, state, reply, error, at)
            select id, state, reply, last_error, updated_at from messages where id = ?",
            params![id],
        )?;
        Ok(())
    }

    /// The next batch of unconfirmed acks (at most 100), as the cloud's JSON.
    pub fn pending_acks(&self) -> Result<Vec<(i64, serde_json::Value)>> {
        self.pending_ack_batch(100)?
            .into_iter()
            .map(|pending| Ok((pending.sequence, serde_json::to_value(&pending.ack)?)))
            .collect()
    }

    /// The next batch of unconfirmed acks, at most `limit` (1–100). The
    /// batch is frozen until acknowledged: a transition made while it is in
    /// flight never grows a retry whose success response may have been lost.
    pub fn pending_ack_batch(&self, limit: usize) -> Result<Vec<PendingAck>> {
        let limit = limit.clamp(1, 100);
        let rows: Vec<AckRow> =
            self.with(|connection| {
                let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                transaction.execute(
                    "delete from inbound_batch where not exists (
                        select 1 from inbound_acks where acknowledged = 0 and seq <= inbound_batch.through)",
                    [],
                )?;
                transaction.execute(
                    &format!(
                        "insert or ignore into inbound_batch (slot, through)
                        select 1, max(seq) from (
                            select seq from inbound_acks where acknowledged = 0 order by seq limit {limit}
                        ) having count(*) > 0"
                    ),
                    [],
                )?;
                let rows = {
                    let mut statement = transaction.prepare(
                        "select seq, id, state, reply, error, at from inbound_acks
                        where acknowledged = 0 and seq <= (select through from inbound_batch where slot = 1)
                        order by seq",
                    )?;
                    let rows = statement.query_map([], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?))
                    })?;
                    rows.collect::<rusqlite::Result<Vec<_>>>()?
                };
                transaction.commit()?;
                Ok(rows)
            })?;
        rows.into_iter()
            .map(|(sequence, id, state, reply, error, at)| {
                let status = match state.as_str() {
                    "held" => AckStatus::HeldForApproval,
                    "pending" | "sending" => AckStatus::Queued,
                    other => AckStatus::parse(other).unwrap_or(AckStatus::Failed),
                };
                Ok(PendingAck {
                    sequence,
                    ack: CodexInboundAck {
                        id,
                        status,
                        reply,
                        error,
                        at: stored_time(at)?,
                    },
                })
            })
            .collect()
    }

    /// Confirms acks through `sequence`: only the snapshot sent, never a
    /// newer transition made in flight.
    pub fn acknowledge_through(&self, sequence: i64) -> Result<()> {
        self.run(
            "update inbound_acks set acknowledged = 1 where seq <= ?",
            params![sequence],
        )?;
        self.run(
            "delete from inbound_batch where through <= ?",
            params![sequence],
        )?;
        Ok(())
    }

    // MARK: Reading

    pub fn message(&self, id: &str) -> Result<Option<CodexOutboxMessage>> {
        Ok(self
            .query(
                &format!("select {COLUMNS} from messages where id = ?"),
                params![id],
            )?
            .into_iter()
            .next())
    }

    pub fn messages_in(&self, state: OutboxState) -> Result<Vec<CodexOutboxMessage>> {
        self.query(
            &format!("select {COLUMNS} from messages where state = ? order by seq"),
            params![state.as_str()],
        )
    }

    /// For each thread, the oldest unfinished message — but only when it is
    /// `pending` and due. A thread whose oldest message is `held`, `sending`
    /// or `delivered` yields nothing, which keeps a thread's messages in
    /// order and one turn at a time.
    pub fn deliverable_heads(&self, now: SystemTime) -> Result<Vec<CodexOutboxMessage>> {
        self.query(
            &format!(
                "select {COLUMNS} from messages where seq in (
                    select min(seq) from messages
                    where state in ('held', 'pending', 'sending', 'delivered') group by thread_id
                ) and state = 'pending' and next_attempt_at <= ? order by seq"
            ),
            params![seconds(now)],
        )
    }

    /// Whether anything is still waiting on the delivery worker. Held
    /// messages wait on the local user instead; see `has_held_messages`.
    pub fn has_unfinished_messages(&self) -> Result<bool> {
        self.exists(
            "select 1 from messages where state in ('pending', 'sending', 'delivered') limit 1",
        )
    }

    /// Whether any message is waiting on the local user's approval.
    pub fn has_held_messages(&self) -> Result<bool> {
        self.exists("select 1 from messages where state = 'held' limit 1")
    }

    fn exists(&self, sql: &str) -> Result<bool> {
        self.with(|connection| {
            connection
                .query_row(sql, [], |_| Ok(()))
                .optional()
                .map(|row| row.is_some())
        })
    }

    /// How many messages (in any state) were enqueued at or after `since`,
    /// optionally narrowed to a sender and/or a thread. Rate limiting counts
    /// refusals too.
    pub fn enqueued_count(
        &self,
        sender_id: Option<&str>,
        thread_id: Option<&str>,
        since: SystemTime,
    ) -> Result<usize> {
        let mut sql = String::from("select count(*) from messages where enqueued_at >= ?");
        let mut values = vec![SqlValue::Real(seconds(since))];
        if let Some(sender_id) = sender_id {
            sql.push_str(" and sender_id = ?");
            values.push(SqlValue::Text(sender_id.into()));
        }
        if let Some(thread_id) = thread_id {
            sql.push_str(" and thread_id = ?");
            values.push(SqlValue::Text(thread_id.into()));
        }
        let count: i64 = self.with(|connection| {
            connection.query_row(&sql, params_from_iter(values), |row| row.get(0))
        })?;
        Ok(count as usize)
    }
}

/// Older databases predate senders, approvals and routes. Adds the missing
/// columns in place; safe on every open.
fn migrate_columns(connection: &Connection) -> rusqlite::Result<()> {
    let existing: Vec<String> = {
        let mut statement = connection.prepare("pragma table_info(messages)")?;
        let names = statement.query_map([], |row| row.get(1))?;
        names.collect::<rusqlite::Result<_>>()?
    };
    for (column, kind) in [
        ("sender_id", "text"),
        ("sender_name", "text"),
        ("approved_at", "real"),
        ("route", "text"),
    ] {
        if !existing.iter().any(|name| name == column) {
            connection
                .execute_batch(&format!("alter table messages add column {column} {kind}"))?;
        }
    }
    Ok(())
}

/// A stored time, or `Corrupt` for a value no time can have.
fn stored_time(value: f64) -> Result<SystemTime> {
    from_seconds(value)
        .ok_or_else(|| OutboxError::Corrupt(format!("stored time {value} is out of range")))
}

fn read_message(row: &Row<'_>) -> rusqlite::Result<CodexOutboxMessage> {
    let convert = |index: usize, value: f64| {
        from_seconds(value).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                index,
                rusqlite::types::Type::Real,
                format!("stored time {value} is out of range").into(),
            )
        })
    };
    let time = |index: usize| -> rusqlite::Result<SystemTime> { convert(index, row.get(index)?) };
    let optional_time = |index: usize| -> rusqlite::Result<Option<SystemTime>> {
        row.get::<_, Option<f64>>(index)?
            .map(|value| convert(index, value))
            .transpose()
    };
    let state: String = row.get(5)?;
    Ok(CodexOutboxMessage {
        id: row.get(0)?,
        thread_id: row.get(1)?,
        text: row.get(2)?,
        sender_id: row.get(3)?,
        sender_name: row.get(4)?,
        state: OutboxState::parse(&state).unwrap_or(OutboxState::Failed),
        enqueued_at: time(6)?,
        expires_at: time(7)?,
        attempts: row.get::<_, i64>(8)?.max(0) as u32,
        next_attempt_at: time(9)?,
        last_attempt_at: optional_time(10)?,
        last_error: row.get(11)?,
        turn_id: row.get(12)?,
        reply: row.get(13)?,
        updated_at: time(14)?,
        approved_at: optional_time(15)?,
        route: row.get(16)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{Duration, UNIX_EPOCH};

    struct Fixture {
        _directory: tempfile::TempDir,
        path: PathBuf,
    }

    fn fixture() -> Fixture {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("outbox.sqlite");
        Fixture {
            _directory: directory,
            path,
        }
    }

    fn now() -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1_000_000)
    }

    fn later() -> SystemTime {
        now() + Duration::from_secs(3600)
    }

    fn at(offset: f64) -> SystemTime {
        now() + Duration::from_secs_f64(offset)
    }

    fn message(id: &str, thread: &str, text: &str) -> NewMessage {
        NewMessage::new(id, thread, text)
    }

    fn ids(messages: Vec<CodexOutboxMessage>) -> Vec<String> {
        messages.into_iter().map(|message| message.id).collect()
    }

    fn state(outbox: &CodexOutbox, id: &str) -> Option<OutboxState> {
        outbox.message(id).unwrap().map(|message| message.state)
    }

    // CodexOutboxTests.testEnqueueIsIdempotentOnTheMessageID.
    #[test]
    fn enqueue_is_idempotent_on_the_message_id() {
        let f = fixture();
        let outbox = CodexOutbox::open(&f.path).unwrap();
        assert!(outbox
            .enqueue(&message("m1", "t1", "first"), false, later(), now())
            .unwrap());
        assert!(!outbox
            .enqueue(&message("m1", "t1", "changed"), false, later(), now())
            .unwrap());
        assert_eq!(outbox.message("m1").unwrap().unwrap().text, "first");
        assert_eq!(outbox.messages_in(OutboxState::Pending).unwrap().len(), 1);
    }

    // CodexOutboxTests.testMessagesSurviveReopeningTheStore.
    #[test]
    fn messages_survive_reopening_the_store() {
        let f = fixture();
        {
            let outbox = CodexOutbox::open(&f.path).unwrap();
            outbox
                .enqueue(&message("m1", "t1", "hello"), false, later(), now())
                .unwrap();
            outbox.mark_sending("m1", None, now()).unwrap();
        }
        let reopened = CodexOutbox::open(&f.path).unwrap();
        let stored = reopened.message("m1").unwrap().unwrap();
        assert_eq!(stored.state, OutboxState::Sending);
        assert_eq!(stored.attempts, 1);
        assert_eq!(stored.last_attempt_at, Some(now()));
        assert_eq!(stored.text, "hello");
    }

    // The store and its directory are private to this user.
    #[cfg(unix)]
    #[test]
    fn the_store_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("incoming/scope/codex-outbox.sqlite");
        CodexOutbox::open(&path).unwrap();
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(path.parent().unwrap()), 0o700);
    }

    // CodexOutboxTests.testOnlyTheOldestUnfinishedMessageOfAThreadIsDeliverable.
    #[test]
    fn only_the_oldest_unfinished_message_of_a_thread_is_deliverable() {
        let f = fixture();
        let outbox = CodexOutbox::open(&f.path).unwrap();
        outbox
            .enqueue(&message("a1", "A", "1"), false, later(), now())
            .unwrap();
        outbox
            .enqueue(&message("a2", "A", "2"), false, later(), now())
            .unwrap();
        outbox
            .enqueue(&message("b1", "B", "1"), false, later(), now())
            .unwrap();
        assert_eq!(ids(outbox.deliverable_heads(now()).unwrap()), ["a1", "b1"]);

        // While a1 is in flight or its turn is running, thread A is blocked.
        outbox.mark_sending("a1", None, now()).unwrap();
        assert_eq!(ids(outbox.deliverable_heads(now()).unwrap()), ["b1"]);
        outbox.mark_delivered("a1", Some("turn-1"), now()).unwrap();
        assert_eq!(ids(outbox.deliverable_heads(now()).unwrap()), ["b1"]);

        outbox
            .mark_finished("a1", OutboxState::Completed, Some("done"), None, now())
            .unwrap();
        assert_eq!(ids(outbox.deliverable_heads(now()).unwrap()), ["a2", "b1"]);
        assert_eq!(
            outbox.message("a1").unwrap().unwrap().reply.as_deref(),
            Some("done")
        );
    }

    // CodexOutboxTests.testARetryWaitsForItsNextAttemptTime.
    #[test]
    fn a_retry_waits_for_its_next_attempt_time() {
        let f = fixture();
        let outbox = CodexOutbox::open(&f.path).unwrap();
        outbox
            .enqueue(&message("m1", "t1", "hello"), false, later(), now())
            .unwrap();
        outbox.mark_sending("m1", None, now()).unwrap();
        outbox
            .mark_pending("m1", Some("refused"), at(10.0), now())
            .unwrap();
        assert!(outbox.deliverable_heads(at(9.0)).unwrap().is_empty());
        assert_eq!(ids(outbox.deliverable_heads(at(10.0)).unwrap()), ["m1"]);
        assert_eq!(
            outbox.message("m1").unwrap().unwrap().last_error.as_deref(),
            Some("refused")
        );
    }

    // CodexOutboxTests.testExpiresOnlyPendingMessagesAndUnblocksNothingElse.
    #[test]
    fn expires_only_pending_messages_and_unblocks_nothing_else() {
        let f = fixture();
        let outbox = CodexOutbox::open(&f.path).unwrap();
        outbox
            .enqueue(&message("old", "t1", "old"), false, at(5.0), now())
            .unwrap();
        outbox
            .enqueue(&message("sent", "t2", "sent"), false, at(5.0), now())
            .unwrap();
        outbox.mark_sending("sent", None, now()).unwrap();

        let expired = outbox.expire(at(6.0)).unwrap();
        assert_eq!(ids(expired), ["old"]);
        assert_eq!(state(&outbox, "old"), Some(OutboxState::Expired));
        assert_eq!(state(&outbox, "sent"), Some(OutboxState::Sending));
        assert!(outbox.has_unfinished_messages().unwrap());
    }

    // CodexOutboxTests.testPruneDropsOnlyOldFinishedMessages.
    #[test]
    fn prune_drops_only_old_finished_messages() {
        let f = fixture();
        let outbox = CodexOutbox::open(&f.path).unwrap();
        outbox
            .enqueue(&message("done", "t1", "x"), false, later(), now())
            .unwrap();
        outbox
            .mark_finished("done", OutboxState::Failed, None, Some("refused"), now())
            .unwrap();
        outbox
            .enqueue(&message("waiting", "t2", "y"), false, later(), now())
            .unwrap();

        outbox.prune(at(1.0)).unwrap();
        assert!(outbox.message("done").unwrap().is_none());
        assert!(outbox.message("waiting").unwrap().is_some());
    }

    // CodexOutboxTests.testSenderFieldsRoundTripThroughAReopenedStore.
    #[test]
    fn sender_fields_round_trip_through_a_reopened_store() {
        let f = fixture();
        {
            let outbox = CodexOutbox::open(&f.path).unwrap();
            outbox
                .enqueue(
                    &message("m1", "t1", "hi").sender("u1", "Ada"),
                    false,
                    later(),
                    now(),
                )
                .unwrap();
        }
        let stored = CodexOutbox::open(&f.path)
            .unwrap()
            .message("m1")
            .unwrap()
            .unwrap();
        assert_eq!(stored.sender_id.as_deref(), Some("u1"));
        assert_eq!(stored.sender_name.as_deref(), Some("Ada"));
    }

    // CodexOutboxTests.testAMessageEnqueuedWithoutASenderHasNilSenderFields.
    #[test]
    fn a_message_enqueued_without_a_sender_has_no_sender_fields() {
        let f = fixture();
        let outbox = CodexOutbox::open(&f.path).unwrap();
        outbox
            .enqueue(&message("m1", "t1", "hi"), false, later(), now())
            .unwrap();
        let stored = outbox.message("m1").unwrap().unwrap();
        assert_eq!(stored.sender_id, None);
        assert_eq!(stored.sender_name, None);
    }

    // CodexOutboxTests.testAHeldMessageIsNotDeliverableAndBlocksOnlyItsOwnThread.
    #[test]
    fn a_held_message_is_not_deliverable_and_blocks_only_its_own_thread() {
        let f = fixture();
        let outbox = CodexOutbox::open(&f.path).unwrap();
        outbox
            .enqueue(&message("a1", "A", "1"), true, later(), now())
            .unwrap();
        outbox
            .enqueue(&message("a2", "A", "2"), false, later(), now())
            .unwrap();
        outbox
            .enqueue(&message("b1", "B", "1"), false, later(), now())
            .unwrap();
        assert_eq!(state(&outbox, "a1"), Some(OutboxState::Held));
        assert_eq!(ids(outbox.deliverable_heads(now()).unwrap()), ["b1"]);
    }

    // CodexOutboxTests.testApproveMakesAHeldMessageDeliverableAndIsNotIdempotent.
    #[test]
    fn approve_makes_a_held_message_deliverable_and_is_not_idempotent() {
        let f = fixture();
        let outbox = CodexOutbox::open(&f.path).unwrap();
        outbox
            .enqueue(&message("m1", "t1", "hi"), true, later(), now())
            .unwrap();
        assert!(outbox.approve("m1", now()).unwrap());
        assert_eq!(state(&outbox, "m1"), Some(OutboxState::Pending));
        assert_eq!(ids(outbox.deliverable_heads(now()).unwrap()), ["m1"]);
        assert!(!outbox.approve("m1", now()).unwrap());
    }

    // CodexOutboxTests.testApprovalIsRememberedAndSurvivesReopening.
    #[test]
    fn approval_is_remembered_and_survives_reopening() {
        let f = fixture();
        {
            let outbox = CodexOutbox::open(&f.path).unwrap();
            outbox
                .enqueue(&message("asked", "t1", "hi"), true, later(), now())
                .unwrap();
            outbox
                .enqueue(&message("straight", "t2", "hi"), false, later(), now())
                .unwrap();
            assert_eq!(outbox.message("asked").unwrap().unwrap().approved_at, None);
            assert!(outbox.approve("asked", now()).unwrap());
        }
        let reopened = CodexOutbox::open(&f.path).unwrap();
        assert_eq!(
            reopened.message("asked").unwrap().unwrap().approved_at,
            Some(now())
        );
        assert_eq!(
            reopened.message("straight").unwrap().unwrap().approved_at,
            None
        );
    }

    // CodexOutboxTests.testTheRouteOfASendIsRecordedAndSurvivesReopening.
    #[test]
    fn the_route_of_a_send_is_recorded_and_survives_reopening() {
        let f = fixture();
        {
            let outbox = CodexOutbox::open(&f.path).unwrap();
            outbox
                .enqueue(&message("m1", "t1", "hi"), false, later(), now())
                .unwrap();
            assert_eq!(outbox.message("m1").unwrap().unwrap().route, None);
            outbox.mark_sending("m1", Some("queue"), now()).unwrap();
        }
        let reopened = CodexOutbox::open(&f.path).unwrap();
        assert_eq!(
            reopened.message("m1").unwrap().unwrap().route.as_deref(),
            Some("queue")
        );
        assert_eq!(state(&reopened, "m1"), Some(OutboxState::Sending));

        // A retry through another route replaces it.
        reopened
            .mark_pending("m1", Some("x"), now(), now())
            .unwrap();
        reopened
            .mark_sending("m1", Some("windowSocket"), now())
            .unwrap();
        assert_eq!(
            reopened.message("m1").unwrap().unwrap().route.as_deref(),
            Some("windowSocket")
        );
    }

    // CodexOutboxTests.testHoldTakesOnlyAPendingMessageBackOutOfLine.
    #[test]
    fn hold_takes_only_a_pending_message_back_out_of_line() {
        let f = fixture();
        let outbox = CodexOutbox::open(&f.path).unwrap();
        outbox
            .enqueue(&message("m1", "t1", "hi"), false, later(), now())
            .unwrap();
        outbox
            .enqueue(&message("m2", "t1", "hi"), false, later(), now())
            .unwrap();

        assert!(outbox.hold("m1", now()).unwrap());
        assert_eq!(state(&outbox, "m1"), Some(OutboxState::Held));
        assert!(
            outbox.deliverable_heads(now()).unwrap().is_empty(),
            "a held head keeps its thread in order"
        );
        assert!(!outbox.hold("m1", now()).unwrap());

        outbox.mark_sending("m2", None, now()).unwrap();
        assert!(!outbox.hold("m2", now()).unwrap());
        assert_eq!(state(&outbox, "m2"), Some(OutboxState::Sending));
    }

    // CodexOutboxTests.testARecordedRejectionIsFinalAndAnswersRepeats.
    #[test]
    fn a_recorded_rejection_is_final_and_answers_repeats() {
        let f = fixture();
        let outbox = CodexOutbox::open(&f.path).unwrap();
        assert!(outbox
            .record_rejected(
                &message("m1", "t1", "hi").sender("u1", "Alice"),
                "paused",
                now()
            )
            .unwrap());

        let stored = outbox.message("m1").unwrap().unwrap();
        assert_eq!(stored.state, OutboxState::Rejected);
        assert_eq!(stored.last_error.as_deref(), Some("paused"));
        assert_eq!(stored.sender_id.as_deref(), Some("u1"));
        assert!(outbox.deliverable_heads(now()).unwrap().is_empty());

        // Neither a repeat refusal nor a later enqueue replaces it.
        assert!(!outbox
            .record_rejected(&message("m1", "t1", "hi"), "other", now())
            .unwrap());
        assert!(!outbox
            .enqueue(&message("m1", "t1", "hi"), false, later(), now())
            .unwrap());
        assert_eq!(
            outbox.message("m1").unwrap().unwrap().last_error.as_deref(),
            Some("paused")
        );
        assert!(!outbox.approve("m1", now()).unwrap());
    }

    // CodexOutboxTests.testRejectFinalizesAHeldMessageWithAReasonAndUnblocksItsThread.
    #[test]
    fn reject_finalizes_a_held_message_with_a_reason_and_unblocks_its_thread() {
        let f = fixture();
        let outbox = CodexOutbox::open(&f.path).unwrap();
        outbox
            .enqueue(&message("a1", "A", "1"), true, later(), now())
            .unwrap();
        outbox
            .enqueue(&message("a2", "A", "2"), false, later(), now())
            .unwrap();

        assert!(outbox.reject("a1", Some("spam"), now()).unwrap());
        let rejected = outbox.message("a1").unwrap().unwrap();
        assert_eq!(rejected.state, OutboxState::Rejected);
        assert!(rejected.state.is_final());
        assert_eq!(rejected.last_error.as_deref(), Some("spam"));

        assert_eq!(ids(outbox.deliverable_heads(now()).unwrap()), ["a2"]);
        assert!(!outbox.reject("a1", None, now()).unwrap());
    }

    // CodexOutboxTests.testHeldMessagesExpire.
    #[test]
    fn held_messages_expire() {
        let f = fixture();
        let outbox = CodexOutbox::open(&f.path).unwrap();
        outbox
            .enqueue(&message("m1", "t1", "hi"), true, at(5.0), now())
            .unwrap();
        assert_eq!(ids(outbox.expire(at(6.0)).unwrap()), ["m1"]);
        assert_eq!(state(&outbox, "m1"), Some(OutboxState::Expired));
    }

    // CodexOutboxTests.testExpireLeavesAlreadyFinalizedMessagesAlone.
    #[test]
    fn expire_leaves_already_finalized_messages_alone() {
        let f = fixture();
        let outbox = CodexOutbox::open(&f.path).unwrap();
        outbox
            .enqueue(&message("m1", "t1", "hi"), true, at(5.0), now())
            .unwrap();
        // The user rejects it before the expiry sweep runs.
        assert!(outbox.reject("m1", Some("declined"), now()).unwrap());

        assert!(outbox.expire(at(6.0)).unwrap().is_empty());
        assert_eq!(state(&outbox, "m1"), Some(OutboxState::Rejected));
        assert_eq!(
            outbox.message("m1").unwrap().unwrap().last_error.as_deref(),
            Some("declined")
        );
    }

    // CodexOutboxTests.testHasUnfinishedMessagesIgnoresHeldMessagesButHasHeldMessagesSeesThem.
    #[test]
    fn has_unfinished_messages_ignores_held_messages_but_has_held_messages_sees_them() {
        let f = fixture();
        let outbox = CodexOutbox::open(&f.path).unwrap();
        outbox
            .enqueue(&message("m1", "t1", "hi"), true, later(), now())
            .unwrap();
        assert!(!outbox.has_unfinished_messages().unwrap());
        assert!(outbox.has_held_messages().unwrap());
    }

    // CodexOutboxTests.testEnqueuedCountFiltersBySenderThreadAndSince.
    #[test]
    fn enqueued_count_filters_by_sender_thread_and_since() {
        let f = fixture();
        let outbox = CodexOutbox::open(&f.path).unwrap();
        let with_sender = |id: &str, thread: &str, sender: &str| NewMessage {
            sender_id: Some(sender.into()),
            ..message(id, thread, "x")
        };
        outbox
            .enqueue(&with_sender("m1", "A", "u1"), false, later(), now())
            .unwrap();
        outbox
            .enqueue(&with_sender("m2", "A", "u2"), false, later(), at(1.0))
            .unwrap();
        outbox
            .enqueue(&with_sender("m3", "B", "u1"), false, later(), at(2.0))
            .unwrap();

        assert_eq!(outbox.enqueued_count(Some("u1"), None, now()).unwrap(), 2);
        assert_eq!(outbox.enqueued_count(None, Some("A"), now()).unwrap(), 2);
        assert_eq!(
            outbox.enqueued_count(Some("u1"), Some("A"), now()).unwrap(),
            1
        );
        assert_eq!(
            outbox.enqueued_count(Some("u1"), Some("B"), now()).unwrap(),
            1
        );
        assert_eq!(outbox.enqueued_count(None, None, at(1.5)).unwrap(), 1);
        assert_eq!(outbox.enqueued_count(None, None, now()).unwrap(), 3);
    }

    // CodexOutboxTests.testOpeningAnOldSchemaDatabaseMigratesInPlaceAndAcceptsANewSender.
    #[test]
    fn opening_an_old_schema_database_migrates_in_place_and_accepts_a_new_sender() {
        let f = fixture();
        {
            let old = Connection::open(&f.path).unwrap();
            old.execute_batch(
                "create table messages (
                    seq integer primary key autoincrement,
                    id text not null unique,
                    thread_id text not null,
                    text text not null,
                    state text not null,
                    enqueued_at real not null,
                    expires_at real not null,
                    attempts integer not null default 0,
                    next_attempt_at real not null,
                    last_attempt_at real,
                    last_error text,
                    turn_id text,
                    reply text,
                    updated_at real not null
                )",
            )
            .unwrap();
            old.execute(
                "insert into messages (id, thread_id, text, state, enqueued_at, expires_at, next_attempt_at, updated_at)
                values ('legacy', 't1', 'hello', 'pending', ?1, ?2, ?1, ?1)",
                params![seconds(now()), seconds(later())],
            )
            .unwrap();
        }

        let outbox = CodexOutbox::open(&f.path).unwrap();
        let legacy = outbox.message("legacy").unwrap().unwrap();
        assert_eq!(legacy.sender_id, None);
        assert_eq!(legacy.sender_name, None);
        assert_eq!(legacy.text, "hello");
        assert_eq!(legacy.state, OutboxState::Pending);

        assert!(outbox
            .enqueue(
                &message("new", "t2", "hi").sender("u1", "Ada"),
                false,
                later(),
                now()
            )
            .unwrap());
        let added = outbox.message("new").unwrap().unwrap();
        assert_eq!(added.sender_id.as_deref(), Some("u1"));
        assert_eq!(added.sender_name.as_deref(), Some("Ada"));
    }

    // Adapted from DesktopCloudReceiverTests.testLostAckRetriesExactBatchAndDoesNotConsumeInFlightTransition
    // (the store half; the HTTP half belongs to the transport).
    #[test]
    fn a_pending_ack_batch_is_frozen_until_acknowledged() {
        let f = fixture();
        let outbox = CodexOutbox::open_journaled(&f.path).unwrap();
        outbox
            .enqueue(&message("one", "t1", "x"), true, later(), now())
            .unwrap();
        let first = outbox.pending_ack_batch(100).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].ack.status, AckStatus::HeldForApproval);
        // A transition after the batch was handed out does not grow a retry.
        outbox.approve("one", now()).unwrap();
        assert_eq!(outbox.pending_ack_batch(100).unwrap(), first);
        outbox.acknowledge_through(first[0].sequence).unwrap();
        let next = outbox.pending_ack_batch(100).unwrap();
        assert_eq!(next.len(), 1);
        assert_eq!(next[0].ack.status, AckStatus::Queued);
        outbox.acknowledge_through(next[0].sequence).unwrap();
        assert!(outbox.pending_acks().unwrap().is_empty());
        assert_eq!(outbox.message("one").unwrap().unwrap().attempts, 0);
    }

    // Adapted from DesktopCloudReceiverTests.testBatchesAreBoundedAndSurviveRelaunch.
    #[test]
    fn ack_batches_are_bounded_and_survive_relaunch() {
        let f = fixture();
        {
            let outbox = CodexOutbox::open_journaled(&f.path).unwrap();
            for index in 0..205 {
                outbox
                    .record_rejected(&message(&format!("m{index}"), "t1", "x"), "paused", now())
                    .unwrap();
            }
        }
        let reopened = CodexOutbox::open(&f.path).unwrap();
        let mut sizes = Vec::new();
        loop {
            let batch = reopened.pending_acks().unwrap();
            let Some((last, _)) = batch.last() else { break };
            sizes.push(batch.len());
            reopened.acknowledge_through(*last).unwrap();
        }
        assert_eq!(sizes, [100, 100, 5]);
    }

    // The JSON the transport posts matches the Swift encoder's.
    #[test]
    fn pending_acks_are_the_cloud_json() {
        let f = fixture();
        let outbox = CodexOutbox::open_journaled(&f.path).unwrap();
        outbox
            .record_rejected(&message("m", "t1", "x"), "paused", now())
            .unwrap();
        let acks = outbox.pending_acks().unwrap();
        assert_eq!(
            acks[0].1,
            serde_json::json!({"id": "m", "status": "rejected", "error": "paused", "at": "1970-01-12T13:46:40Z"})
        );
    }

    // Adapted from DesktopCloudReceiverTests.testRetiredCursorReplaysWithoutErasingDeliveryEvidence.
    #[test]
    fn a_stale_cursor_reset_never_erases_a_later_checkpoint() {
        let f = fixture();
        let outbox = CodexOutbox::open_journaled(&f.path).unwrap();
        assert!(outbox.checkpoint("missing").is_err());
        outbox
            .enqueue(&message("old", "t1", "x"), true, later(), now())
            .unwrap();
        outbox
            .enqueue(&message("new", "t1", "x"), true, later(), now())
            .unwrap();
        outbox.checkpoint("old").unwrap();
        let pending = outbox.pending_acks().unwrap();
        outbox.reset_cursor_if_matching("old").unwrap();
        assert_eq!(outbox.cursor().unwrap(), None);
        assert!(outbox.message("old").unwrap().is_some());
        assert_eq!(outbox.pending_acks().unwrap(), pending);
        outbox.checkpoint("new").unwrap();
        let reopened = CodexOutbox::open(&f.path).unwrap();
        assert_eq!(reopened.cursor().unwrap().as_deref(), Some("new"));
        reopened.reset_cursor_if_matching("old").unwrap();
        assert_eq!(reopened.cursor().unwrap().as_deref(), Some("new"));
    }

    // Review (PR #149): a stored time no time can have reads as corrupt
    // instead of crashing.
    #[test]
    fn out_of_range_stored_times_read_as_corrupt() {
        let f = fixture();
        let outbox = CodexOutbox::open_journaled(&f.path).unwrap();
        outbox
            .enqueue(&message("m1", "t1", "x"), false, later(), now())
            .unwrap();
        {
            let raw = Connection::open(&f.path).unwrap();
            raw.execute("update messages set expires_at = 1e300", [])
                .unwrap();
            raw.execute("update inbound_acks set at = -1e300", [])
                .unwrap();
            raw.execute(
                "insert into inbound_retired (id, state, at) values ('gone', 'completed', 1e300)",
                [],
            )
            .unwrap();
        }
        assert!(matches!(outbox.message("m1"), Err(OutboxError::Sqlite(_))));
        assert!(matches!(
            outbox.pending_acks(),
            Err(OutboxError::Corrupt(_))
        ));
        assert!(matches!(
            outbox.retired_ack("gone"),
            Err(OutboxError::Corrupt(_))
        ));
    }

    // Review (PR #149): an existing directory is used only when it is a real
    // directory only this user can write to; it is never re-permissioned.
    #[cfg(unix)]
    #[test]
    fn an_unsafe_existing_directory_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let open = directory.path().join("open");
        std::fs::create_dir(&open).unwrap();
        std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(CodexOutbox::open(open.join("outbox.sqlite")).is_err());
        assert_eq!(
            std::fs::metadata(&open).unwrap().permissions().mode() & 0o777,
            0o777
        );
        let private = directory.path().join("private");
        std::fs::create_dir(&private).unwrap();
        let link = directory.path().join("link");
        std::os::unix::fs::symlink(&private, &link).unwrap();
        assert!(CodexOutbox::open(link.join("outbox.sqlite")).is_err());
        assert!(CodexOutbox::open(private.join("outbox.sqlite")).is_ok());
    }
}
