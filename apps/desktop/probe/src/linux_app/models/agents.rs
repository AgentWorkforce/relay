//! Agents in words: this computer's sessions and whether they are on the
//! relay, the workspace roster grouped by owner and machine, the fleet's
//! workers, and the Agents and Team pages' search and machine filters.

use super::search_matches;
use super::time::{clock_since, relative_ms};
use crate::relay::contract::agents::{ArchivedAgent, LocalSession};
use crate::relay::fleet::{BrokerListing, WorkerRow, WorkerState};
use crate::relay::people::{RosterAgent, RosterWhere, WorkspacePerson};
use crate::relay::store::SessionKind;
use chrono::TimeZone;
use std::collections::{BTreeMap, HashSet};
use std::fmt::Display;

pub use super::agent_kind::kind_label;

pub fn hosted_kind_label(kind: SessionKind, host: Option<&str>) -> String {
    let provider = kind_label(kind);
    match host {
        Some("paseo") => format!("{provider} in Paseo"),
        Some("conductor") => format!("{provider} in Conductor"),
        _ => provider.to_string(),
    }
}

/// A history source or harness (`codex`, `claude-code`, `xai`, …) as the
/// app names it; one it does not know is capitalized.
pub fn source_name(source: &str) -> String {
    match source.to_lowercase().as_str() {
        "codex" => "Codex",
        "claude" => "Claude",
        "claude-code" | "claude_code" | "claudecode" => "Claude Code",
        "grok" | "xai" => "Grok",
        "cursor" => "Cursor",
        "cursor-cloud" | "cursor_cloud" => "Cursor Cloud",
        "opencode" | "open-code" | "open_code" => "OpenCode",
        "openai" | "open-ai" | "open_ai" => "OpenAI",
        "muse" | "muse-open" => "Muse",
        "devin" => "Devin",
        "openclaw" => "OpenClaw",
        "hermes" => "Hermes",
        _ => return super::capitalized(source),
    }
    .to_string()
}

/// A fleet worker's state.
pub fn worker_state_label(state: WorkerState) -> &'static str {
    match state {
        WorkerState::Starting => "Starting",
        WorkerState::Working => "Working",
        WorkerState::Idle => "Idle",
        WorkerState::Waiting => "Waiting for input",
        WorkerState::Unknown => "Status unknown",
    }
}

/// Where a roster agent runs: here, Agent Relay's cloud, or the computer
/// it names.
pub fn where_label(agent: &RosterAgent) -> String {
    match agent.where_runs {
        RosterWhere::ThisComputer => "this computer".to_string(),
        RosterWhere::Cloud => "cloud".to_string(),
        RosterWhere::OtherDesktop => match &agent.host {
            Some(host) => format!("on {host}"),
            None => "another computer".to_string(),
        },
    }
}

/// A person's initials (at most two), else `?`.
pub fn initials(name: &str) -> String {
    let letters: String = name
        .split_whitespace()
        .take(2)
        .filter_map(|part| part.chars().next())
        .collect();
    if letters.is_empty() {
        "?".to_string()
    } else {
        letters.to_uppercase()
    }
}

/// Whether a session can receive relay messages right now, as its row
/// shows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Presence {
    /// Not on the relay: no name, nothing delivered.
    Off,
    /// On the relay and Relaycast pushes messages to it as they are sent.
    Online,
    /// On the relay while the push channel (re)connects; messages still
    /// arrive through the queue check.
    Connecting,
    /// On the relay but the session is not running; messages wait.
    Offline,
    /// Asked to go on the relay; registering.
    Joining,
    /// Asked to leave the relay; releasing its name.
    Leaving,
}

impl Presence {
    /// `wanted` is the state last asked for while it differs from the
    /// relay's. `push_live` is `None` before the push channel reports a
    /// state.
    pub fn of(
        on_relay: bool,
        wanted: Option<bool>,
        live: bool,
        push_live: Option<bool>,
    ) -> Presence {
        if let Some(wanted) = wanted.filter(|wanted| *wanted != on_relay) {
            return if wanted {
                Presence::Joining
            } else {
                Presence::Leaving
            };
        }
        if !on_relay {
            Presence::Off
        } else if !live {
            Presence::Offline
        } else if push_live == Some(true) {
            Presence::Online
        } else {
            Presence::Connecting
        }
    }

    pub fn message_status(self) -> &'static str {
        match self {
            Self::Online => "Receiving",
            Self::Joining | Self::Connecting => "Connecting…",
            Self::Off => "Off",
            Self::Offline => "Offline",
            Self::Leaving => "Turning off…",
        }
    }

    pub fn message_symbol(self) -> &'static str {
        match self {
            Self::Online => "checkmark.circle.fill",
            Self::Joining | Self::Connecting | Self::Leaving => "arrow.triangle.2.circlepath",
            Self::Offline => "pause.circle",
            Self::Off => "stop.circle",
        }
    }

    pub fn message_class(self) -> &'static str {
        match self {
            Self::Online => "online",
            Self::Joining | Self::Connecting => "connecting",
            Self::Off | Self::Offline | Self::Leaving => "offline",
        }
    }

    pub fn message_help(self) -> &'static str {
        match self {
            Self::Online => "Receiving messages. Click to go offline.",
            Self::Joining | Self::Connecting => "Connecting to receive messages. Click to go offline.",
            Self::Offline => "Offline — this session is not running. Messages wait until it starts. Click to turn off.",
            Self::Off => "Off. Click to receive messages.",
            Self::Leaving => "Turning off message delivery. Click to reconnect.",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Presence::Off => "Not on the relay",
            Presence::Online => "Online",
            Presence::Connecting => "Connecting",
            Presence::Offline => "Offline",
            Presence::Joining => "Joining the relay…",
            Presence::Leaving => "Leaving the relay…",
        }
    }

    /// On, as the switch shows it: the state asked for wins.
    pub fn is_on(self) -> bool {
        !matches!(self, Presence::Off | Presence::Leaving)
    }

    pub fn is_changing(self) -> bool {
        matches!(self, Presence::Joining | Presence::Leaving)
    }

    pub fn detail(self) -> &'static str {
        match self {
            Presence::Off => "Turn on to make this session reachable on the relay.",
            Presence::Online => "Receiving messages as they are sent.",
            Presence::Connecting => {
                "Connecting to the relay. Messages still arrive within 30 seconds."
            }
            Presence::Offline => "The session isn't running. Messages wait until it is.",
            Presence::Joining => "Registering a name on the relay.",
            Presence::Leaving => "Releasing its name on the relay.",
        }
    }
}

/// How a row's second line reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Muted,
    Accent,
    Warn,
}

/// The session's project, else its kind; a Claude app session says so.
pub fn session_place(session: &LocalSession) -> String {
    let project = session
        .project
        .as_deref()
        .filter(|project| !project.is_empty());
    if session.target.kind == SessionKind::ClaudeCloud {
        return match project {
            Some(project) => format!("{project} · Claude app"),
            None => "Claude app".to_string(),
        };
    }
    project
        .map(str::to_string)
        .unwrap_or_else(|| kind_label(session.target.kind).to_string())
}

/// An OpenCode window that was open before Agent Relay's OpenCode plugin
/// was on: running, but unreachable until OpenCode restarts. A missing
/// `running` (an older core) reads as running.
pub fn needs_opencode_restart(session: &LocalSession) -> bool {
    !session.live
        && session.running != Some(false)
        && session.target.kind == SessionKind::OpenCodeOpen
}

/// A My agents row's second line and its tone. `error` is the last failed
/// action on the row.
pub fn session_subtitle(
    session: &LocalSession,
    presence: Presence,
    error: Option<&str>,
    now_ms: i64,
) -> (String, Tone) {
    if let Some(error) = error {
        return (error.to_string(), Tone::Warn);
    }
    let name = session
        .registration
        .as_ref()
        .map(|registration| registration.name.as_str());
    match presence {
        // The name it will most likely get, so the address is known early.
        Presence::Joining => {
            let name = name.unwrap_or(&session.suggested_name);
            return (format!("Joining as @{name}…"), Tone::Accent);
        }
        Presence::Leaving => return ("Leaving the relay…".to_string(), Tone::Muted),
        _ => {}
    }
    let place = session_place(session);
    if let Some(name) = name {
        return match presence {
            Presence::Connecting => (format!("Connecting · @{name}"), Tone::Warn),
            Presence::Offline if needs_opencode_restart(session) => {
                (format!("Restart OpenCode to connect · @{name}"), Tone::Warn)
            }
            Presence::Offline => (
                format!("Waiting — session not running · @{name}"),
                Tone::Warn,
            ),
            _ => (format!("@{name} · {place}"), Tone::Muted),
        };
    }
    if needs_opencode_restart(session) {
        return (
            format!("{place} · Restart OpenCode to connect"),
            Tone::Muted,
        );
    }
    if !session.live {
        return (format!("{place} · Not running"), Tone::Muted);
    }
    // Only Codex has a real last-active time; terminal Claude sessions are
    // listed because they are running now.
    match session.updated_at_ms.filter(|updated| *updated > 0) {
        Some(updated) if session.target.kind == SessionKind::Codex => (
            format!("{place} · {}", relative_ms(Some(updated), now_ms)),
            Tone::Muted,
        ),
        _ => (place, Tone::Muted),
    }
}

/// What My agents lists: the live sessions, most recent first. An ended
/// session keeps its registration, so a reopened Codex thread is back on
/// the relay with its name and queued messages, but it is not listed until
/// then. A Grok TUI row exists only while the TUI runs; without a leader it
/// is not live yet, and is listed so it can be added once leader mode is
/// on. An OpenCode window opened before the plugin was on is listed the
/// same way, so it can say it needs a restart.
pub fn listed_sessions(sessions: &[LocalSession]) -> Vec<&LocalSession> {
    let mut listed: Vec<&LocalSession> = sessions
        .iter()
        .filter(|session| {
            session.live
                || session.target.kind == SessionKind::GrokOpen
                || needs_opencode_restart(session)
        })
        .collect();
    listed.sort_by_cached_key(|session| {
        (
            std::cmp::Reverse(session.updated_at_ms.unwrap_or(0)),
            session.target.key(),
        )
    });
    listed
}

/// The Agents search field over a session: the row's title, the session's
/// own title, project, kind, id and relay name, ignoring case; empty
/// matches all.
pub fn matches_session(session: &LocalSession, title: &str, query: &str) -> bool {
    let name = session
        .registration
        .as_ref()
        .map(|registration| format!("@{}", registration.name));
    let fields = [
        Some(title),
        Some(session.title.as_str()),
        session.project.as_deref(),
        Some(kind_label(session.target.kind)),
        Some(session.target.id.as_str()),
        name.as_deref(),
    ];
    search_matches(query, fields.into_iter().flatten())
}

/// The heading over agents that left the relay because their session was
/// archived.
pub const ARCHIVED_SECTION_TITLE: &str = "Archived";

/// `Session archived 5 minutes ago · name released`; without the time when
/// it does not read. As the Mac's `ArchivedAgentText.detail`.
pub fn archived_detail(archived_at: &str, now_ms: i64) -> String {
    match chrono::DateTime::parse_from_rfc3339(archived_at) {
        Ok(at) => format!(
            "Session archived {} · name released",
            relative_ms(Some(at.timestamp_millis()), now_ms)
        ),
        Err(_) => "Session archived · name released".into(),
    }
}

/// The Agents search field over an archived agent: its name, title or
/// address.
pub fn matches_archived(agent: &ArchivedAgent, query: &str) -> bool {
    let query = query.trim().to_lowercase();
    query.is_empty()
        || [&agent.name, &agent.title, &agent.address]
            .iter()
            .any(|field| field.to_lowercase().contains(&query))
}

/// The Agents search field over a fleet worker.
pub fn matches_worker(worker: &WorkerRow, broker: &BrokerListing, query: &str) -> bool {
    let channels = worker.channels.join(" ");
    let fields = [
        worker.name.as_str(),
        worker.provider_label.as_str(),
        worker.model.as_deref().unwrap_or(""),
        broker.name.as_str(),
        channels.as_str(),
        worker_state_label(worker.state),
    ];
    search_matches(query, fields)
}

/// The Agents and Team search field over a roster agent.
pub fn matches_roster(agent: &RosterAgent, query: &str) -> bool {
    let place = where_label(agent);
    let fields = [
        agent.name.as_str(),
        agent.address.as_deref().unwrap_or(""),
        agent.description.as_str(),
        place.as_str(),
    ];
    search_matches(query, fields)
}

/// The workspace roster grouped under people: the signed-in person's
/// agents elsewhere, each teammate's (by identity hash), and those whose
/// owner is unknown. Agents on this computer are listed with its sessions
/// instead; an agent that is not running is not offered.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RosterGroups {
    pub mine: Vec<RosterAgent>,
    pub teammates: BTreeMap<String, Vec<RosterAgent>>,
    pub other: Vec<RosterAgent>,
}

impl RosterGroups {
    pub fn new(
        roster: &[RosterAgent],
        people: &[WorkspacePerson],
        local_names: &HashSet<String>,
    ) -> RosterGroups {
        let teammates: HashSet<&str> = people
            .iter()
            .filter(|person| !person.is_self)
            .map(|person| person.identity_hash.as_str())
            .collect();
        let mut groups = RosterGroups::default();
        for agent in roster {
            if !agent.liveness.is_running()
                || agent.where_runs == RosterWhere::ThisComputer
                || local_names.contains(&agent.name)
            {
                continue;
            }
            match agent.owner_hash.as_deref() {
                _ if agent.is_self => groups.mine.push(agent.clone()),
                Some(hash) if teammates.contains(hash) => groups
                    .teammates
                    .entry(hash.to_string())
                    .or_default()
                    .push(agent.clone()),
                _ => groups.other.push(agent.clone()),
            }
        }
        groups
    }
}

/// One machine's agents on the people roster.
#[derive(Clone, Debug, PartialEq)]
pub struct MachineGroup {
    /// `host:<lowercased host>`, or `unknown`.
    pub id: String,
    pub name: String,
    pub agents: Vec<RosterAgent>,
}

/// The roster bucketed by published host, ignoring case, in name order;
/// rows without a host come last under "Unknown machine". A desktop
/// address ends in an agent id, not necessarily a host, so only the host
/// is used.
pub fn group_roster_by_machine(agents: &[RosterAgent]) -> Vec<MachineGroup> {
    let mut buckets: BTreeMap<String, (String, Vec<RosterAgent>)> = BTreeMap::new();
    let mut unknown = Vec::new();
    for agent in agents {
        let host = agent.host.as_deref().map(str::trim).unwrap_or("");
        if host.is_empty() {
            unknown.push(agent.clone());
            continue;
        }
        let (name, rows) = buckets
            .entry(host.to_lowercase())
            .or_insert_with(|| (host.to_string(), Vec::new()));
        if host < name.as_str() {
            *name = host.to_string();
        }
        rows.push(agent.clone());
    }
    fn ordered(rows: &mut [RosterAgent]) {
        rows.sort_by_cached_key(|agent| {
            let address = agent.address.clone().unwrap_or_default();
            (
                agent.name.to_lowercase(),
                address.to_lowercase(),
                agent.name.clone(),
                address,
            )
        });
    }
    let mut groups: Vec<MachineGroup> = buckets
        .into_iter()
        .map(|(key, (name, mut agents))| {
            ordered(&mut agents);
            MachineGroup {
                id: format!("host:{key}"),
                name,
                agents,
            }
        })
        .collect();
    groups.sort_by_cached_key(|group| (group.name.to_lowercase(), group.name.clone()));
    if !unknown.is_empty() {
        ordered(&mut unknown);
        groups.push(MachineGroup {
            id: "unknown".to_string(),
            name: "Unknown machine".to_string(),
            agents: unknown,
        });
    }
    groups
}

/// A machine name reduced to its letters and digits, lower case, so
/// `Ada's MacBook` and `adas-macbook` are one machine.
pub fn machine_key(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .filter(|character| character.is_alphanumeric())
        .collect()
}

/// The machine a roster agent runs on: its published host, else its
/// address's suffix.
pub fn roster_host(agent: &RosterAgent) -> Option<&str> {
    if let Some(host) = agent.host.as_deref().filter(|host| !host.is_empty()) {
        return Some(host);
    }
    let address = agent.address.as_deref()?;
    address.rfind('@').map(|at| &address[at + 1..])
}

/// Whether `name` is the machine picked; nothing picked matches all.
pub fn machine_matches(name: Option<&str>, selected: &str) -> bool {
    selected.is_empty() || name.is_some_and(|name| machine_key(name) == machine_key(selected))
}

/// Whether the picker names another machine. Its agents on the relay are
/// then that machine's "On the relay" list, since none of this computer's
/// sessions are on it.
pub fn shows_elsewhere_as_relay(this_machine: &str, selected: &str) -> bool {
    !selected.is_empty() && !machine_matches(Some(this_machine), selected)
}

/// The machine picker's choices: one per machine, in name order.
pub fn machine_options<'a>(names: impl IntoIterator<Item = Option<&'a str>>) -> Vec<String> {
    let mut unique: BTreeMap<String, &str> = BTreeMap::new();
    for name in names.into_iter().flatten().filter(|name| !name.is_empty()) {
        unique.insert(machine_key(name), name);
    }
    let mut options: Vec<String> = unique.into_values().map(str::to_string).collect();
    options.sort_by_cached_key(|name| (name.to_lowercase(), name.clone()));
    options
}

/// The useful part of a roster description or message: a declared
/// `Summary:` sentence, else the first sentence, never a spawn
/// instruction (`You are …`) or the path to a private brief.
pub fn agent_task(raw: &str) -> Option<String> {
    let mut value = raw.trim();
    if let Some(at) = value.to_ascii_lowercase().find("summary:") {
        value = value[at + "summary:".len()..].trim();
    } else if starts_with_you_are(value) {
        return None;
    }
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let bytes = value.as_bytes();
    let end = (1..bytes.len().saturating_sub(1))
        .find(|&at| {
            bytes[at] == b' '
                && matches!(bytes[at - 1], b'.' | b'!' | b'?')
                && bytes[at + 1].is_ascii_uppercase()
        })
        .unwrap_or(value.len());
    let value = &value[..end];
    (!value.is_empty()).then(|| value.to_string())
}

/// `You are` as a whole phrase at the start, ignoring case.
fn starts_with_you_are(value: &str) -> bool {
    let prefix = "you are";
    value.len() >= prefix.len()
        && value.is_char_boundary(prefix.len())
        && value[..prefix.len()].eq_ignore_ascii_case(prefix)
        && !value[prefix.len()..]
            .chars()
            .next()
            .is_some_and(|next| next.is_alphanumeric() || next == '_')
}

/// A roster row's second line: an idle agent's last time seen, else the
/// first useful of `summary` (the Cloud overview's title or the session's
/// original request), `latest_outgoing` and `description`.
pub fn agent_line<Tz: TimeZone>(
    summary: Option<&str>,
    latest_outgoing: Option<&str>,
    description: &str,
    status: &str,
    last_seen_ms: Option<i64>,
    now_ms: i64,
    zone: &Tz,
) -> String
where
    Tz::Offset: Display,
{
    if status == "idle" {
        return match clock_since(last_seen_ms, now_ms, zone) {
            Some(when) => format!("Idle since {when}"),
            None => "Idle".to_string(),
        };
    }
    [summary, latest_outgoing, Some(description)]
        .into_iter()
        .flatten()
        .find_map(agent_task)
        .unwrap_or_else(|| "Active · task details unavailable".to_string())
}

/// Task references already published in a roster description (links and
/// `repo#123`), at most five; never a search of the agent's conversations.
pub fn agent_mentions(raw: &str) -> Vec<String> {
    const TRIM: &[char] = &['.', ',', ';', '!', '?', ')'];
    let mut mentions: Vec<String> = Vec::new();
    let mut at = 0;
    while at < raw.len() {
        let rest = &raw[at..];
        match mention_at(rest) {
            Some(length) => {
                let mention = rest[..length].trim_matches(TRIM).to_string();
                if !mentions.contains(&mention) {
                    mentions.push(mention);
                }
                at += length;
            }
            None => at += rest.chars().next().map_or(1, char::len_utf8),
        }
    }
    mentions.truncate(5);
    mentions
}

/// The length of a mention starting `text`: an `http(s)://` link up to
/// whitespace or `<>()`, else `[owner/]repo#digits`.
fn mention_at(text: &str) -> Option<usize> {
    for scheme in ["https://", "http://"] {
        if let Some(rest) = text.strip_prefix(scheme) {
            let body = rest
                .find(|character: char| character.is_whitespace() || "<>()".contains(character))
                .unwrap_or(rest.len());
            if body > 0 {
                return Some(scheme.len() + body);
            }
        }
    }
    let word = |text: &str| {
        text.find(|character: char| {
            !(character.is_ascii_alphanumeric() || "_.-".contains(character))
        })
        .unwrap_or(text.len())
    };
    let mut end = word(text);
    if end == 0 {
        return None;
    }
    if text[end..].starts_with('/') {
        let owner = end + 1;
        let repo = word(&text[owner..]);
        if repo == 0 {
            return None;
        }
        end = owner + repo;
    }
    let rest = text[end..].strip_prefix('#')?;
    let digits = rest
        .find(|character: char| !character.is_ascii_digit())
        .unwrap_or(rest.len());
    (digits > 0).then_some(end + 1 + digits)
}

/// The CLI line that attaches to a fleet worker. The CLI needs the
/// broker's canonical node id; a local broker's scope is its state
/// directory, which `--node` does not take.
pub fn fleet_attach_command(worker_name: &str, node_id: &str) -> String {
    let quote = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
    let attach = format!("agent-relay node agent attach {}", quote(worker_name));
    if node_id.is_empty() || node_id.starts_with('/') {
        attach
    } else {
        format!("{attach} --node {}", quote(node_id))
    }
}

#[cfg(test)]
mod tests {
    use super::super::time::tests::{local_ms, zone};
    use super::*;
    use serde_json::{json, Value};

    fn session(value: Value) -> LocalSession {
        let mut base = json!({"title": "", "project": null, "directory": null, "live": false,
                              "updated_at_ms": null, "registration": null, "suggested_name": "agent"});
        super::super::uploads::tests::merge(&mut base, value);
        if let Some(registration) = base["registration"].as_object_mut() {
            registration.entry("address").or_insert(json!("x@desk"));
            registration
                .entry("added_by_session")
                .or_insert(json!(false));
        }
        serde_json::from_value(base).unwrap()
    }

    fn agent(value: Value) -> RosterAgent {
        let mut base = json!({"name": "web", "kind": "agent", "where": "other_desktop", "status": "active",
                              "liveness": "live", "description": "", "is_self": false});
        super::super::uploads::tests::merge(&mut base, value);
        serde_json::from_value(base).unwrap()
    }

    #[test]
    fn an_archived_agent_says_when_and_that_its_name_was_released() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-10T12:05:00Z")
            .unwrap()
            .timestamp_millis();
        assert_eq!(
            archived_detail("2026-10-10T12:00:00Z", now),
            "Session archived 5 minutes ago · name released"
        );
        assert_eq!(
            archived_detail("not a time", now),
            "Session archived · name released"
        );
        let agent: ArchivedAgent = serde_json::from_value(json!({
            "name": "codex-api", "address": "codex-api@desk-1", "title": "Fix tests",
            "target": {"kind": "codex", "id": "t"}, "archived_at": "2026-10-10T12:00:00Z"
        }))
        .unwrap();
        for query in ["", "CODEX", "fix", "desk-1"] {
            assert!(matches_archived(&agent, query), "{query}");
        }
        assert!(!matches_archived(&agent, "claude"));
    }

    #[test]
    fn message_orbs_only_go_green_after_push_is_live() {
        for (presence, label) in [
            (Presence::Off, "Off"),
            (Presence::Offline, "Offline"),
            (Presence::Leaving, "Turning off…"),
        ] {
            assert_eq!(presence.message_status(), label);
            assert_eq!(presence.message_class(), "offline");
        }
        for presence in [Presence::Joining, Presence::Connecting] {
            assert_eq!(presence.message_status(), "Connecting…");
            assert_eq!(presence.message_class(), "connecting");
        }
        assert_eq!(Presence::Online.message_status(), "Receiving");
        assert_eq!(Presence::Online.message_class(), "online");
    }

    #[test]
    fn presence_follows_the_requested_state_then_the_push_channel() {
        assert_eq!(
            Presence::of(false, Some(true), true, None),
            Presence::Joining
        );
        assert_eq!(
            Presence::of(true, Some(false), true, Some(true)),
            Presence::Leaving
        );
        assert_eq!(Presence::of(false, None, true, None), Presence::Off);
        assert_eq!(
            Presence::of(true, None, false, Some(true)),
            Presence::Offline
        );
        assert_eq!(Presence::of(true, None, true, Some(true)), Presence::Online);
        assert_eq!(Presence::of(true, None, true, None), Presence::Connecting);
        assert_eq!(
            Presence::of(true, Some(true), true, Some(true)),
            Presence::Online
        );
        assert!(Presence::Joining.is_on() && Presence::Joining.is_changing());
        assert!(!Presence::Leaving.is_on());
    }

    #[test]
    fn session_subtitles() {
        let codex = session(
            json!({"target": {"kind": "codex", "id": "t"}, "project": "api", "live": true,
                                   "updated_at_ms": 0, "registration": {"name": "api-work"},
                                   "suggested_name": "api-work"}),
        );
        assert_eq!(
            session_subtitle(&codex, Presence::Online, None, 0),
            ("@api-work · api".to_string(), Tone::Muted)
        );
        assert_eq!(
            session_subtitle(&codex, Presence::Offline, None, 0).0,
            "Waiting — session not running · @api-work"
        );
        assert_eq!(
            session_subtitle(&codex, Presence::Off, Some("Refused"), 0),
            ("Refused".to_string(), Tone::Warn)
        );
        assert_eq!(
            session_subtitle(&codex, Presence::Joining, None, 0),
            ("Joining as @api-work…".to_string(), Tone::Accent)
        );
        let cloud = session(json!({"target": {"kind": "claude-cloud", "id": "c"}}));
        assert_eq!(
            session_subtitle(&cloud, Presence::Off, None, 0).0,
            "Claude app · Not running"
        );
        let grok = session(json!({"target": {"kind": "grok-open", "id": "g"}, "project": "api"}));
        assert_eq!(
            session_subtitle(&grok, Presence::Off, None, 0).0,
            "api · Not running"
        );
        let bound = session(
            json!({"target": {"kind": "grok-open", "id": "g"}, "project": "api",
                                   "registration": {"name": "grok-api"}}),
        );
        assert_eq!(
            session_subtitle(&bound, Presence::Offline, None, 0).0,
            "Waiting — session not running · @grok-api"
        );
        let opencode =
            session(json!({"target": {"kind": "opencode-open", "id": "ses_a"}, "project": "web"}));
        assert!(needs_opencode_restart(&opencode));
        assert_eq!(
            session_subtitle(&opencode, Presence::Off, None, 0).0,
            "web · Restart OpenCode to connect"
        );
        let added = session(
            json!({"target": {"kind": "opencode-open", "id": "ses_a"}, "project": "web",
                                   "registration": {"name": "opencode-web"}}),
        );
        assert_eq!(
            session_subtitle(&added, Presence::Offline, None, 0),
            (
                "Restart OpenCode to connect · @opencode-web".to_string(),
                Tone::Warn
            )
        );
        let running = session(
            json!({"target": {"kind": "opencode-open", "id": "ses_a"}, "project": "web",
                                   "live": true, "registration": {"name": "opencode-web"}}),
        );
        assert!(!needs_opencode_restart(&running));
        assert_eq!(
            session_subtitle(&running, Presence::Online, None, 0).0,
            "@opencode-web · web"
        );
        let closed =
            session(json!({"target": {"kind": "opencode-open", "id": "ses_a"}, "running": false}));
        assert!(!needs_opencode_restart(&closed));
        let recent = session(
            json!({"target": {"kind": "codex", "id": "r"}, "project": "api", "live": true,
                                    "updated_at_ms": 1_000}),
        );
        assert_eq!(
            session_subtitle(&recent, Presence::Off, None, 121_000).0,
            "api · 2 minutes ago"
        );
    }

    #[test]
    fn listed_sessions_are_the_live_ones_even_when_an_ended_one_is_registered() {
        let sessions = [
            session(
                json!({"target": {"kind": "codex", "id": "old"}, "registration": {"name": "old"},
                           "updated_at_ms": 1}),
            ),
            session(json!({"target": {"kind": "codex", "id": "gone"}, "updated_at_ms": 9})),
            session(
                json!({"target": {"kind": "codex", "id": "new"}, "live": true, "updated_at_ms": 5}),
            ),
            session(
                json!({"target": {"kind": "claude-terminal", "id": "c"}, "live": true,
                           "registration": {"name": "c"}, "updated_at_ms": 7}),
            ),
            session(json!({"target": {"kind": "grok-open", "id": "g"}, "updated_at_ms": 3})),
            session(json!({"target": {"kind": "opencode-open", "id": "o"}, "updated_at_ms": 2})),
            session(json!({"target": {"kind": "opencode", "id": "m"}, "updated_at_ms": 8})),
            // A registered OpenCode session whose window closed has ended: hidden.
            session(
                json!({"target": {"kind": "opencode-open", "id": "closed"}, "running": false,
                           "registration": {"name": "closed"}, "updated_at_ms": 6}),
            ),
        ];
        let ids: Vec<&str> = listed_sessions(&sessions)
            .iter()
            .map(|session| session.target.id.as_str())
            .collect();
        assert_eq!(ids, ["c", "new", "g", "o"]);
        assert!(matches_session(&sessions[0], "Old row", "@OLD"));
        assert!(matches_session(&sessions[3], "", "claude code"));
        assert!(!matches_session(&sessions[1], "", "deploy"));
    }

    #[test]
    fn where_an_agent_runs() {
        assert_eq!(
            where_label(&agent(json!({"where": "this_computer"}))),
            "this computer"
        );
        assert_eq!(where_label(&agent(json!({"where": "cloud"}))), "cloud");
        assert_eq!(
            where_label(&agent(json!({"where": "other_desktop", "host": "laptop"}))),
            "on laptop"
        );
        assert_eq!(
            where_label(&agent(json!({"where": "other_desktop"}))),
            "another computer"
        );
        assert!(matches_roster(&agent(json!({"host": "laptop"})), "LAPTOP"));
    }

    #[test]
    fn agent_summary_omits_spawn_boilerplate() {
        let line = |summary: Option<&str>, description: &str| {
            agent_line(summary, None, description, "active", None, 0, &zone())
        };
        assert_eq!(
            line(
                None,
                "You are a Codex agent. Summary: Fixing cloud#4136. Read brief."
            ),
            "Fixing cloud#4136."
        );
        assert_eq!(
            line(None, "You are a Codex agent. Read brief."),
            "Active · task details unavailable"
        );
        assert_eq!(line(Some("Reviewing PR"), "Old task"), "Reviewing PR");
        assert_eq!(
            agent_line(
                None,
                Some("Review posted"),
                "Old task",
                "active",
                None,
                0,
                &zone()
            ),
            "Review posted"
        );
        assert_eq!(agent_task("You are a Codex agent. Read brief."), None);
        assert_eq!(
            agent_task("  Fixing review findings on cloud#4136. Run tests afterward.  ").as_deref(),
            Some("Fixing review findings on cloud#4136.")
        );
        assert_eq!(agent_task("Your turn. Go").as_deref(), Some("Your turn."));
        assert_eq!(
            agent_line(
                Some("Old task"),
                None,
                "Other task",
                "idle",
                None,
                0,
                &zone()
            ),
            "Idle"
        );
    }

    #[test]
    fn agent_mentions_deduplicate_references() {
        assert_eq!(
            agent_mentions(
                "Review cloud#4136 and https://github.com/acme/cloud/pull/4136. Then cloud#4136"
            ),
            ["cloud#4136", "https://github.com/acme/cloud/pull/4136"]
        );
        assert_eq!(
            agent_mentions("See AgentWorkforce/relay#12, (relay#3) and a/b/c#4."),
            ["AgentWorkforce/relay#12", "relay#3", "b/c#4"]
        );
        assert_eq!(agent_mentions("a#1 b#2 c#3 d#4 e#5 f#6").len(), 5);
    }

    #[test]
    fn machine_groups_are_case_insensitive_and_unknown_is_last() {
        let groups = group_roster_by_machine(&[
            agent(json!({"name": "same", "address": "z@desktop-id", "host": "sf-frame"})),
            agent(json!({"name": "unknown", "address": "unknown@not-a-host"})),
            agent(json!({"name": "alpha", "address": "alpha@desktop-id", "host": "alpha"})),
            agent(json!({"name": "same", "address": "a@desktop-id", "host": "SF-FRAME"})),
            agent(
                json!({"name": "literal", "address": "literal@desktop-id", "host": "Unknown machine"}),
            ),
        ]);
        let names: Vec<&str> = groups.iter().map(|group| group.name.as_str()).collect();
        assert_eq!(
            names,
            ["alpha", "SF-FRAME", "Unknown machine", "Unknown machine"]
        );
        let addresses: Vec<&str> = groups[1]
            .agents
            .iter()
            .filter_map(|agent| agent.address.as_deref())
            .collect();
        assert_eq!(addresses, ["a@desktop-id", "z@desktop-id"]);
        assert_eq!(
            groups[3].agents[0].address.as_deref(),
            Some("unknown@not-a-host")
        );
        assert_ne!(groups[2].id, groups[3].id);
        assert_eq!(groups[1].id, "host:sf-frame");
    }

    #[test]
    fn idle_summary_includes_the_date_only_for_an_earlier_day() {
        let current = local_ms(2026, 10, 4, 12, 0);
        let idle = |seen: i64| agent_line(None, None, "", "idle", Some(seen), current, &zone());
        assert_eq!(idle(local_ms(2026, 10, 4, 9, 5)), "Idle since 09:05");
        assert_eq!(
            idle(local_ms(2026, 10, 3, 18, 45)),
            "Idle since Oct 3, 18:45"
        );
    }

    #[test]
    fn agents_elsewhere_are_grouped_by_owner() {
        let people: Vec<WorkspacePerson> = serde_json::from_value(json!([
            {"name": "Me", "avatar_url": null, "identity_hash": "h-me", "is_self": true},
            {"name": "Bo", "avatar_url": null, "identity_hash": "h-bo", "is_self": false},
        ]))
        .unwrap();
        let roster = [
            agent(json!({"name": "mine", "owner_hash": "h-me", "is_self": true})),
            agent(
                json!({"name": "here", "where": "this_computer", "owner_hash": "h-me", "is_self": true}),
            ),
            agent(json!({"name": "local", "owner_hash": "h-me", "is_self": true})),
            agent(json!({"name": "bos", "where": "cloud", "owner_hash": "h-bo"})),
            agent(
                json!({"name": "idle", "liveness": "idle", "where": "cloud", "owner_hash": "h-bo"}),
            ),
            agent(
                json!({"name": "gone", "liveness": "offline", "where": "cloud", "owner_hash": "h-bo"}),
            ),
            agent(json!({"name": "stray", "where": "cloud"})),
        ];
        let groups = RosterGroups::new(&roster, &people, &HashSet::from(["local".to_string()]));
        let names = |agents: &[RosterAgent]| {
            agents
                .iter()
                .map(|agent| agent.name.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(names(&groups.mine), ["mine"]);
        // Idle agents are offered (dimmed); offline ones are not.
        assert_eq!(names(&groups.teammates["h-bo"]), ["bos", "idle"]);
        assert_eq!(names(&groups.other), ["stray"]);
    }

    #[test]
    fn machine_filter_matches_loosely() {
        assert!(machine_matches(Some("Ada's MacBook"), "adas-macbook"));
        assert!(machine_matches(None, ""));
        assert!(!machine_matches(None, "desk"));
        assert_eq!(
            machine_options([Some("b"), Some("A"), Some("a"), None, Some("")]),
            ["a", "b"]
        );
        assert_eq!(
            roster_host(&agent(json!({"address": "x@desk"}))),
            Some("desk")
        );
        assert_eq!(
            roster_host(&agent(json!({"address": "x@desk", "host": "Desk"}))),
            Some("Desk")
        );
        assert!(shows_elsewhere_as_relay("laptop", "desk"));
        assert!(!shows_elsewhere_as_relay("laptop", "Laptop"));
        assert!(!shows_elsewhere_as_relay("laptop", ""));
    }

    #[test]
    fn fleet_attach_command_uses_the_canonical_node_id() {
        assert_eq!(
            fleet_attach_command("it's", "node-1"),
            "agent-relay node agent attach 'it'\\''s' --node 'node-1'"
        );
        assert_eq!(
            fleet_attach_command("w", "/state/dir"),
            "agent-relay node agent attach 'w'"
        );
        assert_eq!(
            fleet_attach_command("w", ""),
            "agent-relay node agent attach 'w'"
        );
    }

    #[test]
    fn names_labels_and_initials() {
        assert_eq!(kind_label(SessionKind::ClaudeTerminal), "Claude Code");
        assert_eq!(source_name("XAI"), "Grok");
        assert_eq!(source_name("claude-code"), "Claude Code");
        assert_eq!(source_name("cursor-cloud"), "Cursor Cloud");
        assert_eq!(source_name("gemini"), "Gemini");
        assert_eq!(source_name("openclaw"), "OpenClaw");
        assert_eq!(source_name("hermes"), "Hermes");
        assert_eq!(kind_label(SessionKind::Pi), "Pi");
        assert_eq!(source_name("pi"), "Pi");
        assert_eq!(
            worker_state_label(WorkerState::Waiting),
            "Waiting for input"
        );
        assert_eq!(initials("ada  lovelace byron"), "AL");
        assert_eq!(initials(" "), "?");
    }
}
