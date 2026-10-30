//! Agent Relay's optional Claude Code SessionStart hook.
//!
//! Michael's sessions stay off the relay until someone puts them on.
//! When the setting is on, each Claude login the desktop knows about
//! (`ClaudeSettings::login_settings`) gets one command hook. At session
//! start that command asks `GET /setup/status` with
//! `X-Agent-Relay-Observe: 1`, which reads status and does not apply the
//! agent-led defaults. When `session.registered` is false and sessions may
//! register themselves, it tells Claude to ask the person whether to put
//! the session on the relay, and under what name, and to `POST /register`
//! only if they say yes. The person sees a shorter notice. A session
//! already on the relay is reminded who it is there, how to reach peers
//! and the working norm ([`hosted_mcp::preamble`]); that says nothing to
//! the person, so it is given to automated runs too.
//! Only a session a person is typing in is told anything: a `claude -p`,
//! Agent SDK or structured pipe run (a flows step, cron, CI) has nobody to
//! answer, so the hook stays quiet there ([`has_person`]). When that setting is off, the nudge says so and does
//! not offer a command that would be refused. It never registers the
//! session, and it prints nothing when the status cannot be read.
//!
//! The setting is off unless turned on. It is installed only into shared
//! logins (`login_settings`). Turning it off, and a refresh while it is on,
//! also clear it from a watched login that has since been unshared
//! (`watched_logins`). A directory the desktop does not watch is left alone.
//!
//! With the hook come Claude Code permission rules ([`PermissionRules`],
//! in `permissions`) that let the session run this probe's `relay read` and
//! `relay socket-request` on this core's session socket without an approval
//! prompt, so it can read and answer a relayed message in Claude's default
//! permission mode. They go into and out of the same `settings.json` with
//! the hook. Taking the hook out leaves the file as the person had it: their
//! own copy (`.relay-desktop-backup`) goes back byte for byte when nothing
//! else changed, and a file Agent Relay created goes once it is empty.

use crate::relay::agents::SettingsExtension;
use crate::relay::claude::ClaudeConfig;
use crate::relay::claude_settings::{
    claude_settings_edit_lock, resolve_symlinks, write_keeping_file, ClaudeSettings,
};
use crate::relay::hosted_mcp::{self, McpAccess};
use crate::relay::process::ProcessTable;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[cfg(test)]
mod permission_tests;
mod permissions;
pub use permissions::PermissionRules;

/// Appended to a settings file's name for the one-time copy of the person's
/// own file.
const BACKUP_SUFFIX: &str = ".relay-desktop-backup";

/// The `settings.set` key this extension owns.
pub const SETTING: &str = "claude_session_hook";

/// The subcommand the hook runs; also how the hook is recognized as ours.
pub const SUBCOMMAND: &str = "relay claude-session-hook";

/// Header on the hook's status read. The core then does not apply the
/// agent-led defaults. The name is lowercase because the socket parser
/// stores header names that way.
pub const OBSERVE_HEADER: &str = "x-agent-relay-observe";

/// The only value of [`OBSERVE_HEADER`] that skips the defaults.
pub const OBSERVE_VALUE: &str = "1";

/// How `GET /setup/status`'s body is read. `Again` is only the race where
/// Claude has not written its session file yet.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StatusRead {
    /// `on_relay` is `session.registered`. `self_registration` is whether
    /// `POST /register` is allowed; a body that omits it means allowed,
    /// which is the setting's default.
    Registered {
        on_relay: bool,
        self_registration: bool,
    },
    /// Not on the relay yet, but automatic activation is on: the core puts
    /// the session on the relay by itself within seconds.
    Joining,
    /// On the relay, with the name, address and access status reported.
    OnRelay {
        name: String,
        address: String,
        mcp: McpAccess,
    },
    Again,
    Unknown,
}

/// `session.registered` from a session-socket response, or why it is not
/// known. A failure is never treated as a reason to register.
pub fn read_status(http_status: u16, body: &[u8]) -> StatusRead {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return StatusRead::Unknown;
    };
    if (200..300).contains(&http_status) {
        let Some(on_relay) = value["data"]["session"]["registered"].as_bool() else {
            return StatusRead::Unknown;
        };
        let session = &value["data"]["session"];
        if let (true, Some(name), Some(address)) = (
            on_relay,
            session["name"].as_str(),
            session["address"].as_str(),
        ) {
            return StatusRead::OnRelay {
                name: name.into(),
                address: address.into(),
                mcp: McpAccess::parse(session["mcp"].as_str()),
            };
        }
        // Only when the core says this session will join: automatic
        // activation can be on while there is no workspace yet or the
        // session's folder is excluded from it.
        if !on_relay && session["auto_activates"].as_bool() == Some(true) {
            return StatusRead::Joining;
        }
        let self_registration = value["data"]["allow_self_registration"]
            .as_bool()
            .unwrap_or(true);
        return StatusRead::Registered {
            on_relay,
            self_registration,
        };
    }
    match value["error"]["code"].as_str() {
        Some("not_a_relay_session" | "session_file_unreadable") => StatusRead::Again,
        _ => StatusRead::Unknown,
    }
}

/// How many ancestors to climb from the hook looking for its Claude Code
/// process. Claude runs a hook command through a shell, so it is normally
/// the parent or grandparent.
const ANCESTOR_LIMIT: usize = 8;

/// The Claude Code process a hook started at `start` runs in: the nearest
/// ancestor (inclusive) that is Claude Code, unless another agent comes
/// first. Cursor CLI runs the hooks in `~/.claude/settings.json` too, and a
/// Cursor started from a Claude Code terminal inherits that session's
/// environment, so neither `CLAUDECODE` nor a Claude ancestor further up
/// says the hook is Claude's: the nearest agent does.
pub fn claude_ancestor(table: &dyn ProcessTable, start: i32) -> Option<i32> {
    let mut pid = start;
    for _ in 0..ANCESTOR_LIMIT {
        if pid <= 1 {
            return None;
        }
        if crate::relay::hook_agents::is_claude_process(table, pid) {
            return Some(pid);
        }
        if crate::relay::hook_agents::is_other_agent(table, pid) {
            return None;
        }
        pid = table.process(pid)?.parent;
    }
    None
}

/// Whether the session running this hook has a person to answer. A
/// `claude -p`, Agent SDK or structured pipe run (a flows step, cron, CI)
/// would spend its one reply on the relay question instead of its task, so
/// it is told nothing. A run whose Claude process cannot be found is treated
/// the same way.
pub fn has_person(table: &dyn ProcessTable, start: i32) -> bool {
    claude_ancestor(table, start)
        .is_some_and(|pid| crate::relay::claude::is_interactive_process(table, pid))
}

/// What the hook prints. A session on the relay gets the preamble alone.
/// An unregistered session is told how it could join only when a person
/// is there to ask (`interactive`), and only when self-registration is on
/// does that include the `POST /register` example. The text does not
/// register anything.
pub fn hook_output(status: Option<StatusRead>, socket: &Path, interactive: bool) -> Value {
    if let Some(StatusRead::OnRelay { name, address, mcp }) = &status {
        let context = hosted_mcp::preamble(name, address, *mcp, socket);
        return json!({
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": context
            }
        });
    }
    if !interactive {
        return json!({});
    }
    let (person, agent) = match status {
        Some(StatusRead::Joining) => (JOINING_FOR_PERSON.to_string(), joining(socket)),
        Some(StatusRead::Registered {
            on_relay: false,
            self_registration: true,
        }) => (NUDGE_FOR_PERSON.to_string(), nudge(socket)),
        Some(StatusRead::Registered {
            on_relay: false,
            self_registration: false,
        }) => {
            let text = registration_off(socket);
            let agent = format!("{text} {DO_NOT_REGISTER_UNASKED}");
            (text, agent)
        }
        _ => return json!({}),
    };
    json!({
        "systemMessage": person,
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": agent
        }
    })
}

/// What the person sees when automatic activation will put the session on
/// the relay.
pub const JOINING_FOR_PERSON: &str =
    "This Claude Code session joins Agent Relay by itself in a few seconds (automatic activation is on).";

/// What Claude reads when automatic activation will put the session on the
/// relay: nothing to ask or register, and how to reach peers once it is on.
pub fn joining(socket: &Path) -> String {
    let shown = socket.display().to_string();
    let quoted = crate::relay::outbound::shell_quote(&shown);
    let body = "'{\"to\":\"<name>\",\"text\":\"…\"}'";
    let (agents, whoami, send) = match crate::relay::outbound::probe_client(false)
        .then(|| {
            Some((
                crate::relay::outbound::probe_socket_command(socket, "GET", "/agents")?,
                crate::relay::outbound::probe_socket_command(socket, "GET", "/whoami")?,
                format!(
                    "printf '%s' {body} | {}",
                    crate::relay::outbound::probe_socket_command(socket, "POST", "/send")?
                ),
            ))
        })
        .flatten()
    {
        Some(commands) => commands,
        None => (
            format!("curl -s --unix-socket {quoted} http://relay/agents"),
            format!("curl -s --unix-socket {quoted} http://relay/whoami"),
            format!("curl -s --unix-socket {quoted} http://relay/send --data-binary {body}"),
        ),
    };
    format!(
        "This Claude Code session joins Agent Relay by itself within a few seconds: automatic \
         activation is on. Do not register it and do not ask the person about it. Relayed \
         messages arrive in this session as messages from another session; each names the \
         command that reads it and the one that replies. Once on the relay, through the Agent \
         Relay session socket at {shown}: {whoami} shows this session's name, {agents} lists \
         the agents it can message, and {send} sends one a message (\"address\" instead of \
         \"to\" names an exact address)."
    )
}

/// What the person sees when the session may register itself. The person
/// decides; Claude only asks.
pub const NUDGE_FOR_PERSON: &str = "This Claude Code session is not on Agent Relay. \
    Claude will ask whether to put it on the relay and under what name. Nothing is \
    registered unless you say yes.";

/// Added for Claude when the session may not register itself.
const DO_NOT_REGISTER_UNASKED: &str =
    "Do not try to put this session on the relay unless the person asks you to.";

/// What to say when the session may not register itself.
pub fn registration_off(socket: &Path) -> String {
    let shown = socket.display().to_string();
    format!(
        "This Claude Code session is not on Agent Relay. It cannot put itself on the relay \
         while \"Let sessions put themselves on the relay\" is off. Turn that on in Agent \
         Relay Settings, then POST /register on the session socket at {shown}. Agent Relay \
         does not register this session for you."
    )
}

/// The nudge Claude reads. Claude must ask first: whether this session goes
/// on the relay, and the `NAME`, are the person's to choose. The example
/// uses curl, or the probe's own socket client where curl cannot reach the
/// socket (`outbound::probe_client`: always on Windows, a named pipe).
pub fn nudge(socket: &Path) -> String {
    let shown = socket.display().to_string();
    let quoted = crate::relay::outbound::shell_quote(&shown);
    let server = hosted_mcp::SERVER_NAME;
    let body = format!("'{{\"name\":\"NAME\",\"mcp\":\"{server}\"}}'");
    let probe = crate::relay::outbound::probe_client(false)
        .then(|| crate::relay::outbound::probe_socket_command(socket, "POST", "/register"))
        .flatten();
    let example = match probe {
        Some(command) => format!("printf '%s' {body} | {command}"),
        None => format!(
            "curl -sS --unix-socket {quoted} -X POST http://relay/register -H \
             'Content-Type: application/json' --data-binary {body}"
        ),
    };
    format!(
        "This Claude Code session is not on Agent Relay. Do not put it on the relay on \
         your own. In your first reply, before any other work, ask the person whether to \
         put this session on Agent Relay and what name to use. Suggest claude-<repo>-<task>, \
         where repo is the repository name and task is a one- or two-word summary of your \
         current work, for example claude-cloud-plan-support. Use lowercase letters, \
         digits and single dashes, at most 48 characters. Only if they say yes, \
         POST /register on the Agent Relay session socket at {shown} with the name they \
         chose; include \"mcp\":\"{server}\" if you have the {server} MCP tools, or \
         \"mcp\":\"none\" if you do not. For example: {example}. If they say no, leave it \
         off the relay. Agent Relay does not register this session for you."
    )
}

/// Stores each planned file. The snapshot is what to put back. A later
/// snapshot or store that fails restores every file already stored. A
/// restore failure is appended to that error.
fn store_planned(
    planned: &[(PathBuf, Value)],
    mut snapshot: impl FnMut(&Path) -> Result<Option<Vec<u8>>, String>,
    mut store: impl FnMut(&Path, &Value) -> Result<(), String>,
    mut restore: impl FnMut(&Path, &Option<Vec<u8>>) -> Result<(), String>,
) -> Result<(), String> {
    let mut written = Vec::new();
    for (path, value) in planned {
        let previous = match snapshot(path) {
            Ok(previous) => previous,
            Err(error) => return Err(restore_written(&written, error, &mut restore)),
        };
        if let Err(error) = store(path, value) {
            return Err(restore_written(&written, error, &mut restore));
        }
        written.push((path.clone(), previous));
    }
    Ok(())
}

fn restore_written(
    written: &[(PathBuf, Option<Vec<u8>>)],
    error: String,
    restore: &mut impl FnMut(&Path, &Option<Vec<u8>>) -> Result<(), String>,
) -> String {
    for (path, previous) in written.iter().rev() {
        if let Err(restore_error) = restore(path, previous) {
            return format!("{error} Restoring the other logins failed: {restore_error}");
        }
    }
    error
}

/// Installs and removes the hook. The files are the source of truth, so the
/// setting is on when any known login has this build's hook.
pub struct ClaudeSessionHookSettings {
    claude: ClaudeSettings,
    command: String,
    /// The permission rules that come with the hook, and the core's data
    /// folder, which records the rules Agent Relay added.
    permissions: Option<(PermissionRules, PathBuf)>,
    lock: Mutex<()>,
}

impl ClaudeSessionHookSettings {
    pub fn new(claude: &ClaudeConfig, command: String) -> ClaudeSessionHookSettings {
        ClaudeSessionHookSettings {
            claude: ClaudeSettings::new(claude),
            command,
            permissions: None,
            lock: Mutex::new(()),
        }
    }

    /// Also writes [`PermissionRules`] while the hook is on, recording the
    /// ones it adds in `state_dir` (the core's data folder).
    pub fn with_permission_rules(mut self, rules: PermissionRules, state_dir: PathBuf) -> Self {
        self.permissions = Some((rules, state_dir));
        self
    }

    /// The permission rules wanted with the hook; none without them.
    fn rules(&self) -> Vec<String> {
        self.permissions
            .as_ref()
            .map(|(rules, _)| rules.rules())
            .unwrap_or_default()
    }

    /// The rules Agent Relay added, by file.
    fn added(&self) -> permissions::Added {
        self.permissions
            .as_ref()
            .map(|(_, dir)| permissions::Added::load(dir))
            .unwrap_or_default()
    }

    fn save_added(&self, added: &permissions::Added) -> Result<(), String> {
        match &self.permissions {
            Some((_, dir)) => added.save(dir),
            None => Ok(()),
        }
    }

    /// The shell command for `executable`, with `--dev` for Agent Relay Dev.
    pub fn command_for(executable: &Path, development: bool) -> String {
        let mut command = format!(
            "{} {SUBCOMMAND}",
            crate::relay::outbound::shell_quote(&executable.to_string_lossy())
        );
        if development {
            command.push_str(" --dev");
        }
        command
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// `settings.json` paths from `logins`, one per real file, skipping a
    /// login whose directory does not exist.
    fn paths_of(&self, logins: impl IntoIterator<Item = ClaudeSettings>) -> Vec<PathBuf> {
        let mut seen = std::collections::HashSet::new();
        let mut paths = Vec::new();
        for login in logins {
            let path = login.user_settings;
            if !path.parent().is_some_and(Path::is_dir) {
                continue;
            }
            let key = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
            if seen.insert(key) {
                paths.push(path);
            }
        }
        paths
    }

    /// Shared logins the hook is installed into. An unshared default is
    /// left out, so turning a folder off stops new nudges there.
    fn install_targets(&self) -> Vec<PathBuf> {
        let Some(home) = self.claude.user_settings.parent() else {
            return Vec::new();
        };
        let include_default = self.claude.dirs.default_shared(home);
        self.paths_of(
            self.claude
                .login_settings()
                .into_iter()
                .filter(|login| include_default || login.user_settings.parent() != Some(home)),
        )
    }

    /// Every watched login, shared or not. Turning the hook off and
    /// reporting whether it is on use this, so a hook installed before a
    /// folder was unshared is not forgotten.
    fn removal_targets(&self) -> Vec<PathBuf> {
        self.paths_of(self.claude.watched_logins())
    }

    fn applies(&self) -> bool {
        !self.removal_targets().is_empty()
    }

    fn login_name(path: &Path) -> String {
        path.parent()
            .and_then(|dir| dir.file_name())
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Claude".into())
    }

    fn fail(path: &Path, why: &str) -> String {
        format!("{}/settings.json {why}.", Self::login_name(path))
    }

    fn read_object(&self, path: &Path) -> Result<Map<String, Value>, String> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
            Err(_) => return Err(Self::fail(path, "cannot be read")),
        };
        if bytes.iter().all(u8::is_ascii_whitespace) {
            return Ok(Map::new());
        }
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Object(object)) => Ok(object),
            Ok(_) => Err(Self::fail(
                path,
                "is not a JSON object, so it was left unchanged",
            )),
            Err(_) => Err(Self::fail(
                path,
                "is not valid JSON, so it was left unchanged",
            )),
        }
    }

    /// Writes `value`, the first time copying the file as it was beside it
    /// (`.relay-desktop-backup`). A file that already holds the hook is
    /// never the person's own copy.
    fn write(&self, path: &Path, value: &Value) -> Result<(), String> {
        let path = resolve_symlinks(path);
        let existing = match std::fs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err(Self::fail(&path, "cannot be read")),
        };
        let existing = existing.filter(|bytes| {
            !serde_json::from_slice::<Value>(bytes).is_ok_and(|value| self.holds_ours(&value))
        });
        let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        write_keeping_file(&path, existing.as_deref(), &bytes, BACKUP_SUFFIX, 0o600)
            .map_err(|_| Self::fail(&path, "cannot be written"))
    }

    /// Whether `value` holds this build's hook. Its permission rules come
    /// and go with it; a rule alone may be the person's own.
    fn holds_ours(&self, value: &Value) -> bool {
        value["hooks"]["SessionStart"]
            .as_array()
            .is_some_and(|groups| !self.our_commands(groups).is_empty())
    }

    /// `value` with this build's hook and its permission rules (the current
    /// ones and `added`) taken out.
    fn without_ours(&self, value: &Value, added: &[String]) -> Value {
        let Some(mut object) = value.as_object().cloned() else {
            return value.clone();
        };
        self.remove_from(&mut object);
        let mut rules = self.rules();
        rules.extend(added.iter().cloned());
        permissions::take_out(&mut object, &rules);
        Value::Object(object)
    }

    /// This build's hook, in any version of the executable. Agent Relay and
    /// Agent Relay Dev (`--dev`) each keep their own.
    fn is_ours(&self, command: &str) -> bool {
        let dev = |command: &str| command.trim_end().ends_with(" --dev");
        let body = command.trim();
        let body = body.strip_suffix(" --dev").unwrap_or(body).trim_end();
        body.ends_with(SUBCOMMAND) && dev(command) == dev(&self.command)
    }

    fn our_commands<'a>(&self, groups: &'a [Value]) -> Vec<&'a str> {
        groups
            .iter()
            .flat_map(|group| group["hooks"].as_array().into_iter().flatten())
            .filter_map(|hook| hook["command"].as_str())
            .filter(|command| self.is_ours(command))
            .collect()
    }

    /// Removes this build's hooks from `groups`, and any group that held
    /// only them. Whether anything changed.
    fn take_out(&self, groups: &mut Vec<Value>) -> bool {
        let before = groups.clone();
        for group in groups.iter_mut() {
            if let Some(hooks) = group["hooks"].as_array_mut() {
                hooks.retain(|hook| !hook["command"].as_str().is_some_and(|c| self.is_ours(c)));
            }
        }
        groups.retain(|group| {
            group["hooks"]
                .as_array()
                .is_none_or(|hooks| !hooks.is_empty())
        });
        *groups != before
    }

    fn entry(&self) -> Value {
        json!({"hooks": [{"type": "command", "command": self.command, "timeout": 10}]})
    }

    fn file_has_hook(&self, path: &Path) -> bool {
        self.read_object(path).is_ok_and(|object| {
            object
                .get("hooks")
                .and_then(|hooks| hooks.get("SessionStart"))
                .and_then(Value::as_array)
                .is_some_and(|groups| !self.our_commands(groups).is_empty())
        })
    }

    fn hook_enabled(&self) -> bool {
        self.removal_targets()
            .iter()
            .any(|path| self.file_has_hook(path))
    }

    fn shared_has_hook(&self) -> bool {
        self.install_targets()
            .iter()
            .any(|path| self.file_has_hook(path))
    }

    fn install_into(&self, path: &Path, object: &mut Map<String, Value>) -> Result<(), String> {
        let hooks = object.entry("hooks").or_insert_with(|| json!({}));
        let Some(hooks) = hooks.as_object_mut() else {
            return Err(Self::fail(
                path,
                "has a hooks value that is not an object, so it was left unchanged",
            ));
        };
        let start = hooks.entry("SessionStart").or_insert_with(|| json!([]));
        let Some(groups) = start.as_array_mut() else {
            return Err(Self::fail(
                path,
                "has a SessionStart value that is not a list, so it was left unchanged",
            ));
        };
        let entry = self.entry();
        let current = groups.contains(&entry) && self.our_commands(groups).len() == 1;
        if !current {
            self.take_out(groups);
            groups.push(entry);
        }
        Ok(())
    }

    fn remove_from(&self, object: &mut Map<String, Value>) {
        let Some(hooks) = object.get_mut("hooks").and_then(Value::as_object_mut) else {
            return;
        };
        let Some(groups) = hooks.get_mut("SessionStart").and_then(Value::as_array_mut) else {
            return;
        };
        if !self.take_out(groups) {
            return;
        }
        if groups.is_empty() {
            hooks.remove("SessionStart");
        }
        if hooks.is_empty() {
            object.remove("hooks");
        }
    }

    /// Validates the shared logins before writing any. The settings lock is
    /// held for the whole edit, so a direct-delivery write cannot land
    /// between the read and the write. If a later login cannot be
    /// snapshotted or stored, the logins already written are restored.
    /// Turning the hook on with nowhere shared to put it does not remove
    /// leftovers. An unshared file that cannot be read is skipped, so it
    /// cannot block the shared logins.
    fn edit(&self, enable: bool) -> Result<(), String> {
        let _edit = claude_settings_edit_lock();
        let install: std::collections::HashSet<PathBuf> =
            self.install_targets().into_iter().collect();
        if enable && install.is_empty() {
            return Err(if self.removal_targets().is_empty() {
                "No Claude Code login was found, so the hook was not changed.".into()
            } else {
                "No shared Claude Code login was found, so the hook was not turned on.".into()
            });
        }
        let mut targets = self.removal_targets();
        if enable {
            for path in &install {
                if !targets.contains(path) {
                    targets.push(path.clone());
                }
            }
        }
        if targets.is_empty() {
            return Err("No Claude Code login was found, so the hook was not changed.".into());
        }
        let rules = self.rules();
        let added_before = self.added();
        let mut added = added_before.clone();
        let mut planned = Vec::new();
        for path in targets {
            let shared = install.contains(&path);
            let mut object = match self.read_object(&path) {
                Ok(object) => object,
                Err(_) if !shared => continue,
                Err(error) => return Err(error),
            };
            let before = Value::Object(object.clone());
            if enable && shared {
                self.install_into(&path, &mut object)?;
                if self.permissions.is_some() {
                    let owned = permissions::add(&mut object, &rules, added_before.of(&path))
                        .map_err(|why| Self::fail(&path, why))?;
                    added.set(&path, owned);
                }
            } else {
                self.remove_from(&mut object);
                permissions::take_out(&mut object, added_before.of(&path));
                added.set(&path, Vec::new());
            }
            let after = Value::Object(object);
            if after != before {
                planned.push((path, after));
            }
        }
        // While the files are written, the record names every rule that may
        // be in them, so none Agent Relay added is ever left unrecorded.
        if added != added_before {
            self.save_added(&added_before.union(&added))?;
        }
        let stored = store_planned(
            &planned,
            |path| self.snapshot(path),
            |path, value| self.store(path, value, added_before.of(path)),
            |path, previous| self.restore(path, previous),
        );
        if added != added_before {
            let _ = self.save_added(if stored.is_ok() {
                &added
            } else {
                &added_before
            });
        }
        stored
    }

    /// Bytes of the resolved file before this edit changes it. `None` when
    /// there was no file, which a failed edit then removes again.
    fn snapshot(&self, path: &Path) -> Result<Option<Vec<u8>>, String> {
        let path = resolve_symlinks(path);
        match std::fs::read(&path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(Self::fail(&path, "cannot be read")),
        }
    }

    fn restore(&self, path: &Path, previous: &Option<Vec<u8>>) -> Result<(), String> {
        let path = resolve_symlinks(path);
        match previous {
            Some(bytes) => {
                let existing = std::fs::read(&path).ok();
                write_keeping_file(&path, existing.as_deref(), bytes, BACKUP_SUFFIX, 0o600)
                    .map_err(|_| Self::fail(&path, "cannot be restored"))
            }
            None => match std::fs::remove_file(&path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(_) => Err(Self::fail(&path, "cannot be restored")),
            },
        }
    }

    /// Writes `value`. Once the hook and its rules are out, the file goes back to how the person had it: their
    /// own copy (`.relay-desktop-backup`) is put back byte for byte when the
    /// file differs from it in nothing they set, and a file Agent Relay
    /// created (no copy) is removed once it is an empty object. A file the
    /// person changed since keeps their change, and the copy is kept. A
    /// file reached through a link is never removed: that would leave the
    /// link dangling.
    fn store(&self, path: &Path, value: &Value, added: &[String]) -> Result<(), String> {
        if self.holds_ours(value) {
            return self.write(path, value);
        }
        let resolved = resolve_symlinks(path);
        let mut backup = resolved.clone().into_os_string();
        backup.push(BACKUP_SUFFIX);
        let backup = PathBuf::from(backup);
        let mut keep_file = false;
        if let Ok(original) = std::fs::read(&backup) {
            let normal = permissions::without_empty(value);
            match serde_json::from_slice::<Value>(&original) {
                Ok(saved)
                    if !self.holds_ours(&saved) && permissions::without_empty(&saved) == normal =>
                {
                    write_keeping_file(&resolved, None, &original, BACKUP_SUFFIX, 0o600)
                        .map_err(|_| Self::fail(&resolved, "cannot be restored"))?;
                    let _ = std::fs::remove_file(&backup);
                    return Ok(());
                }
                // An earlier build copied a file that already held the hook:
                // the copy has nothing the file does not.
                Ok(saved)
                    if self.holds_ours(&saved)
                        && permissions::without_empty(&self.without_ours(&saved, added))
                            == normal =>
                {
                    let _ = std::fs::remove_file(&backup);
                }
                _ => keep_file = true,
            }
        }
        let linked = std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink());
        if !keep_file && !linked && value.as_object().is_some_and(Map::is_empty) {
            return match std::fs::remove_file(&resolved) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(_) => Err(Self::fail(&resolved, "cannot be removed")),
            };
        }
        self.write(path, value)
    }

    /// At core start: a hook the person turned on is brought up to date (a
    /// moved app runs a different executable) and copied to a shared login
    /// added since. A copy left on a login that is no longer shared is
    /// removed. When no shared login has it, off stays off, including a
    /// leftover on an unshared login.
    pub fn refresh(&self) {
        let _guard = self.lock();
        if self.shared_has_hook() {
            let _ = self.edit(true);
        } else if self.hook_enabled() {
            let _ = self.edit(false);
        }
    }
}

impl SettingsExtension for ClaudeSessionHookSettings {
    fn get(&self) -> Map<String, Value> {
        let _guard = self.lock();
        let mut values = Map::new();
        if self.applies() {
            values.insert(SETTING.into(), Value::Bool(self.hook_enabled()));
        }
        values
    }

    fn set(&self, key: &str, value: &Value) -> Option<Result<(), String>> {
        if key != SETTING {
            return None;
        }
        let Some(enabled) = value.as_bool() else {
            return Some(Err(format!("{SETTING} must be true or false.")));
        };
        let _guard = self.lock();
        Some(self.edit(enabled))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::claude_dirs::ClaudeDirs;
    use serde_json::json;
    #[cfg(unix)]
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn settings(root: &Path) -> ClaudeSessionHookSettings {
        let config = ClaudeConfig {
            home: root.join(".claude"),
            executable: None,
            app_sessions: None,
            dirs: ClaudeDirs::default(),
        };
        ClaudeSessionHookSettings::new(
            &config,
            ClaudeSessionHookSettings::command_for(Path::new("/Apps/Agent Relay.app/probe"), false),
        )
    }

    fn open(on_relay: bool) -> StatusRead {
        StatusRead::Registered {
            on_relay,
            self_registration: true,
        }
    }

    fn login(root: &Path, name: &str) {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".claude.json"), "{}\n").unwrap();
    }

    fn read(path: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    fn command(value: &Value) -> Vec<&str> {
        value["hooks"]["SessionStart"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|group| group["hooks"].as_array().into_iter().flatten())
            .filter_map(|hook| hook["command"].as_str())
            .collect()
    }

    fn processes(claude: &[&str], terminal: bool) -> crate::relay::process::FakeProcesses {
        use crate::relay::process::{FakeProcess, FakeProcesses};
        let table = FakeProcesses::default();
        table.insert(
            100,
            FakeProcess {
                parent: 1,
                arguments: claude.iter().map(|arg| arg.to_string()).collect(),
                has_terminal: terminal,
                ..FakeProcess::default()
            },
        );
        // Claude runs the hook command through a shell.
        table.insert(
            200,
            FakeProcess {
                parent: 100,
                arguments: vec![
                    "/bin/sh".into(),
                    "-c".into(),
                    "agent-relay relay claude-session-hook".into(),
                ],
                ..FakeProcess::default()
            },
        );
        table
    }

    #[test]
    fn only_a_session_with_a_person_is_asked() {
        assert!(has_person(&processes(&["claude"], true), 200));
        assert!(has_person(
            &processes(&["node", "/usr/local/bin/claude", "--resume", "abc"], true),
            200
        ));
        // npm installs run Anthropic's package under Node.
        assert!(has_person(
            &processes(
                &[
                    "node",
                    "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"
                ],
                true
            ),
            200
        ));
        // A flows step, cron or CI run has nobody to answer.
        assert!(!has_person(
            &processes(&["claude", "-p", "do the task"], true),
            200
        ));
        assert!(!has_person(
            &processes(&["claude", "--print", "x"], true),
            200
        ));
        assert!(!has_person(
            &processes(&["claude", "--output-format", "stream-json"], true),
            200
        ));
        // Not attached to a terminal: piped, so no person is typing.
        assert!(!has_person(&processes(&["claude"], false), 200));
        // No Claude Code process above the hook: stay quiet.
        assert!(!has_person(&processes(&["bash"], true), 200));
        assert_eq!(
            claude_ancestor(&processes(&["claude"], true), 200),
            Some(100)
        );
    }

    #[test]
    fn automatic_activation_tells_claude_it_joins_without_asking() {
        let body = br#"{"ok":true,"data":{"auto_activate":true,"allow_self_registration":true,"session":{"registered":false,"auto_activates":true}}}"#;
        assert_eq!(read_status(200, body), StatusRead::Joining);
        // Activation on, but this session will not join (no workspace, or an
        // excluded folder): the usual guidance, not a promise to join.
        let skipped = br#"{"ok":true,"data":{"auto_activate":true,"allow_self_registration":true,"session":{"registered":false,"auto_activates":false}}}"#;
        assert!(matches!(
            read_status(200, skipped),
            StatusRead::Registered { .. }
        ));
        // Already on the relay: the identity reminder, whatever the setting.
        let on = br#"{"ok":true,"data":{"auto_activate":true,"session":{"registered":true,"name":"n","address":"n@m"}}}"#;
        assert!(matches!(read_status(200, on), StatusRead::OnRelay { .. }));
        let off = br#"{"ok":true,"data":{"auto_activate":false,"session":{"registered":false}}}"#;
        assert!(matches!(
            read_status(200, off),
            StatusRead::Registered { .. }
        ));

        let socket = Path::new("/run/user/1000/agent-relay/relay.sock");
        let out = hook_output(Some(StatusRead::Joining), socket, true);
        let text = out["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap();
        assert_eq!(out["systemMessage"], JOINING_FOR_PERSON);
        assert!(text.contains("Do not register it"), "{text}");
        assert!(!text.contains("ask the person whether"), "{text}");
        assert!(!text.contains("POST /register"), "{text}");
        assert!(text.contains(socket.to_str().unwrap()), "{text}");
        assert!(text.contains("/agents"), "{text}");
        assert!(text.contains("/send"), "{text}");
        assert_eq!(
            hook_output(Some(StatusRead::Joining), socket, false),
            json!({})
        );
    }

    #[test]
    fn nudge_has_claude_ask_the_person_before_registering() {
        let socket = Path::new("/run/user/1000/agent-relay/relay.sock");
        let out = hook_output(Some(open(false)), socket, true);
        let text = out["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap();
        assert_eq!(out["hookSpecificOutput"]["hookEventName"], "SessionStart");
        assert_eq!(out["systemMessage"], NUDGE_FOR_PERSON);
        assert!(
            text.contains("Do not put it on the relay on your own"),
            "{text}"
        );
        assert!(text.contains("ask the person whether"), "{text}");
        assert!(text.contains("Only if they say yes"), "{text}");
        let asked = text.find("ask the person").unwrap();
        let command = text.find("POST /register").unwrap();
        assert!(
            asked < command,
            "the question comes before the command: {text}"
        );
        assert!(!NUDGE_FOR_PERSON.contains("curl"), "{NUDGE_FOR_PERSON}");
        assert!(
            NUDGE_FOR_PERSON.contains("unless you say yes"),
            "{NUDGE_FOR_PERSON}"
        );
        assert!(text.contains("POST /register"), "{text}");
        assert!(text.contains(socket.to_str().unwrap()), "{text}");
        assert!(text.contains("does not register this session"), "{text}");
        assert!(!text.contains("auto_activate"), "{text}");
        assert!(out.get("decision").is_none());
        assert_eq!(hook_output(Some(open(true)), socket, true), json!({}));
        assert_eq!(hook_output(None, socket, true), json!({}));
        assert_eq!(hook_output(Some(open(false)), socket, false), json!({}));
        assert!(text.contains("\"mcp\":\"agent-relay-sessions\""), "{text}");
        let blocked = hook_output(
            Some(StatusRead::Registered {
                on_relay: false,
                self_registration: false,
            }),
            socket,
            true,
        );
        let blocked_agent = blocked["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .unwrap();
        assert!(
            blocked_agent.contains("unless the person asks you to"),
            "{blocked_agent}"
        );
        assert!(!blocked_agent.contains("curl"), "{blocked_agent}");
        let blocked = blocked["systemMessage"].as_str().unwrap();
        assert!(
            blocked.contains("Let sessions put themselves on the relay"),
            "{blocked}"
        );
        assert!(!blocked.contains("curl"), "{blocked}");
        assert!(
            blocked.contains("does not register this session"),
            "{blocked}"
        );
    }

    #[test]
    fn a_session_on_the_relay_gets_the_preamble_for_its_access() {
        let socket = Path::new("/run/user/1000/agent-relay/relay.sock");
        let body = |mcp: &str| {
            format!(
                r#"{{"ok":true,"data":{{"session":{{"registered":true,"name":"api","address":"api@mac-1","mcp":"{mcp}"}}}}}}"#
            )
        };
        for (wire, access) in [
            ("declared", McpAccess::Declared),
            ("unknown", McpAccess::Unknown),
            ("socket_only", McpAccess::SocketOnly),
        ] {
            let status = read_status(200, body(wire).as_bytes());
            assert_eq!(
                status,
                StatusRead::OnRelay {
                    name: "api".into(),
                    address: "api@mac-1".into(),
                    mcp: access
                }
            );
            // Nothing for the person to answer, so automated runs get it too.
            for interactive in [true, false] {
                let out = hook_output(Some(status.clone()), socket, interactive);
                assert!(out.get("systemMessage").is_none());
                assert_eq!(
                    out["hookSpecificOutput"]["additionalContext"],
                    hosted_mcp::preamble("api", "api@mac-1", access, socket)
                );
            }
        }
    }

    #[test]
    fn status_reader_never_treats_a_failure_as_registered() {
        let ok = br#"{"ok":true,"data":{"session":{"registered":false}}}
"#;
        assert_eq!(read_status(200, ok), open(false));
        assert_eq!(
            read_status(
                200,
                br#"{"ok":true,"data":{"session":{"registered":true}}}"#
            ),
            open(true)
        );
        assert_eq!(
            read_status(
                200,
                br#"{"ok":true,"data":{"allow_self_registration":false,"session":{"registered":false}}}"#
            ),
            StatusRead::Registered {
                on_relay: false,
                self_registration: false
            }
        );
        assert_eq!(
            read_status(
                403,
                br#"{"ok":false,"error":{"code":"not_a_relay_session","message":"no"}}"#
            ),
            StatusRead::Again
        );
        assert_eq!(
            read_status(
                409,
                br#"{"ok":false,"error":{"code":"session_file_unreadable","message":"no"}}"#
            ),
            StatusRead::Again
        );
        assert_eq!(
            read_status(500, br#"{"ok":false,"error":{"code":"save_failed"}}"#),
            StatusRead::Unknown
        );
        assert_eq!(read_status(200, b"not-json"), StatusRead::Unknown);
    }

    #[test]
    fn off_until_turned_on_then_idempotent_and_removed_cleanly() {
        let root = tempfile::tempdir().unwrap();
        login(root.path(), ".claude");
        login(root.path(), ".claude-work");
        login(root.path(), ".seclaude");
        let primary = root.path().join(".claude/settings.json");
        std::fs::write(
            &primary,
            r#"{"crossSessionInbound":"hold","hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo hi"}]}]}}
"#,
        )
        .unwrap();
        std::fs::write(
            root.path().join(".seclaude/settings.json"),
            "{\"untouched\":true}\n",
        )
        .unwrap();
        let settings = settings(root.path());
        assert_eq!(settings.get()[SETTING], false);
        assert!(SettingsExtension::default_on(&settings).is_empty());
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));

        let installed = read(&primary);
        assert_eq!(installed["crossSessionInbound"], "hold");
        assert_eq!(
            installed["hooks"]["Stop"][0]["hooks"][0]["command"],
            "echo hi"
        );
        let ours = command(&installed);
        assert_eq!(
            ours,
            vec!["'/Apps/Agent Relay.app/probe' relay claude-session-hook"],
            "{installed}"
        );
        let work = read(&root.path().join(".claude-work/settings.json"));
        assert_eq!(command(&work), ours);
        assert_eq!(
            read(&root.path().join(".seclaude/settings.json")),
            json!({"untouched": true}),
            "a login outside .claude / .claude-* stays untouched until other_logins lists it"
        );
        let backup =
            std::fs::read(primary.with_file_name("settings.json.relay-desktop-backup")).unwrap();
        assert!(std::str::from_utf8(&backup)
            .unwrap()
            .contains("crossSessionInbound"));

        let bytes = std::fs::read(&primary).unwrap();
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        assert_eq!(
            std::fs::read(&primary).unwrap(),
            bytes,
            "a second install does not rewrite"
        );

        assert_eq!(settings.get()[SETTING], true);
        assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
        let removed = read(&primary);
        assert_eq!(removed["crossSessionInbound"], "hold");
        assert!(removed["hooks"].get("SessionStart").is_none(), "{removed}");
        assert_eq!(
            removed["hooks"]["Stop"][0]["hooks"][0]["command"],
            "echo hi"
        );
        assert!(
            !root.path().join(".claude-work/settings.json").exists(),
            "a settings.json the hook created goes once it is empty"
        );
        // The person's own file came back byte for byte, and its copy went.
        assert_eq!(
            std::fs::read(&primary).unwrap(),
            b"{\"crossSessionInbound\":\"hold\",\"hooks\":{\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"echo hi\"}]}]}}\n"
        );
        assert!(!primary
            .with_file_name("settings.json.relay-desktop-backup")
            .exists());
        assert_eq!(settings.get()[SETTING], false);
        let kept = std::fs::read(&primary).unwrap();
        assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
        assert_eq!(std::fs::read(&primary).unwrap(), kept);
    }

    #[test]
    fn an_older_copy_is_replaced_and_the_other_build_is_left() {
        let root = tempfile::tempdir().unwrap();
        login(root.path(), ".claude");
        let dev = format!("/old/probe {SUBCOMMAND} --dev");
        let old = format!("/old/probe {SUBCOMMAND}");
        std::fs::write(
            root.path().join(".claude/settings.json"),
            serde_json::to_vec_pretty(&json!({
                "hooks": {"SessionStart": [
                    {"hooks": [
                        {"type": "command", "command": "echo theirs"},
                        {"type": "command", "command": old},
                        {"type": "command", "command": dev}
                    ]}
                ]}
            }))
            .unwrap(),
        )
        .unwrap();
        let settings = settings(root.path());
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        let installed = read(&root.path().join(".claude/settings.json"));
        let commands = command(&installed);
        assert!(commands.contains(&"echo theirs"), "{commands:?}");
        assert!(commands.contains(&dev.as_str()), "{commands:?}");
        assert_eq!(
            commands
                .iter()
                .filter(|c| c.contains(SUBCOMMAND) && !c.ends_with(" --dev"))
                .count(),
            1,
            "{commands:?}"
        );
        assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
        let removed = read(&root.path().join(".claude/settings.json"));
        let left = command(&removed);
        assert_eq!(left, vec!["echo theirs", dev.as_str()]);
    }

    #[test]
    fn a_bad_file_is_left_unchanged_and_blocks_the_other_login() {
        let root = tempfile::tempdir().unwrap();
        login(root.path(), ".claude");
        login(root.path(), ".claude-work");
        std::fs::write(root.path().join(".claude/settings.json"), "{}\n").unwrap();
        std::fs::write(root.path().join(".claude-work/settings.json"), "[1]\n").unwrap();
        let settings = settings(root.path());
        let error = settings.set(SETTING, &json!(true)).unwrap().unwrap_err();
        assert!(error.contains("not a JSON object"), "{error}");
        assert_eq!(read(&root.path().join(".claude/settings.json")), json!({}));
        assert_eq!(
            std::fs::read(root.path().join(".claude-work/settings.json")).unwrap(),
            b"[1]\n"
        );
    }

    #[test]
    #[cfg(unix)]
    fn a_symlink_is_rewritten_at_its_target() {
        let root = tempfile::tempdir().unwrap();
        login(root.path(), ".claude");
        let real = root.path().join("real.json");
        std::fs::write(&real, "{\"keep\":1}\n").unwrap();
        std::fs::remove_file(root.path().join(".claude/settings.json")).ok();
        symlink(&real, root.path().join(".claude/settings.json")).unwrap();
        let settings = settings(root.path());
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        assert!(
            std::fs::symlink_metadata(root.path().join(".claude/settings.json"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(read(&real)["keep"], 1);
        assert_eq!(command(&read(&real)).len(), 1);
        assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
        assert!(
            std::fs::symlink_metadata(root.path().join(".claude/settings.json"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        let kept = read(&real);
        assert_eq!(kept["keep"], 1);
        assert!(kept.get("hooks").is_none(), "{kept}");
        assert!(real.exists());
    }

    #[test]
    fn turning_off_keeps_a_preexisting_empty_file() {
        let root = tempfile::tempdir().unwrap();
        login(root.path(), ".claude");
        let path = root.path().join(".claude/settings.json");
        std::fs::write(&path, "{}\n").unwrap();
        let settings = settings(root.path());
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
        assert_eq!(read(&path), json!({}));
        assert!(path.is_file());
    }

    #[test]
    #[cfg(unix)]
    fn a_later_login_that_cannot_be_written_rolls_the_earlier_one_back() {
        let root = tempfile::tempdir().unwrap();
        login(root.path(), ".claude");
        login(root.path(), ".claude-work");
        let work = root.path().join(".claude-work");
        let mut blocked = std::fs::metadata(&work).unwrap().permissions();
        blocked.set_mode(0o555);
        std::fs::set_permissions(&work, blocked).unwrap();
        struct ModeRestore<'a> {
            dir: &'a Path,
        }
        impl Drop for ModeRestore<'_> {
            fn drop(&mut self) {
                if let Ok(meta) = std::fs::metadata(self.dir) {
                    let mut perms = meta.permissions();
                    perms.set_mode(0o755);
                    let _ = std::fs::set_permissions(self.dir, perms);
                }
            }
        }
        let _restore = ModeRestore { dir: &work };
        let probe = work.join(".probe-write");
        if std::fs::File::create(&probe).is_ok() {
            return;
        }
        let settings = settings(root.path());
        let error = settings.set(SETTING, &json!(true)).unwrap().unwrap_err();
        assert!(error.contains("cannot be written"), "{error}");
        assert!(
            !root.path().join(".claude/settings.json").exists(),
            "the login written first is removed again"
        );
        assert!(!work.join("settings.json").exists());
    }

    #[test]
    #[cfg(unix)]
    fn a_snapshot_failure_after_a_write_rolls_that_write_back() {
        let root = tempfile::tempdir().unwrap();
        login(root.path(), ".claude");
        login(root.path(), ".claude-work");
        let first = root.path().join(".claude/settings.json");
        let second = root.path().join(".claude-work/settings.json");
        std::fs::write(&first, "{\"keep\":1}\n").unwrap();
        std::fs::write(&second, "{\"keep\":2}\n").unwrap();
        let mut blocked = std::fs::metadata(&second).unwrap().permissions();
        blocked.set_mode(0o000);
        std::fs::set_permissions(&second, blocked).unwrap();
        struct ModeRestore<'a> {
            file: &'a Path,
        }
        impl Drop for ModeRestore<'_> {
            fn drop(&mut self) {
                if let Ok(meta) = std::fs::metadata(self.file) {
                    let mut perms = meta.permissions();
                    perms.set_mode(0o644);
                    let _ = std::fs::set_permissions(self.file, perms);
                }
            }
        }
        let _restore = ModeRestore { file: &second };
        if std::fs::read(&second).is_ok() {
            return;
        }
        let mut open = std::fs::metadata(&second).unwrap().permissions();
        open.set_mode(0o644);
        std::fs::set_permissions(&second, open).unwrap();

        let settings = settings(root.path());
        let planned = vec![
            (first.clone(), json!({"keep": 1, "changed": true})),
            (second.clone(), json!({"keep": 2, "changed": true})),
        ];
        let error = store_planned(
            &planned,
            |path| settings.snapshot(path),
            |path, value| {
                let stored = settings.store(path, value, &[]);
                if stored.is_ok() && path == first {
                    let mut perms = std::fs::metadata(&second).unwrap().permissions();
                    perms.set_mode(0o000);
                    std::fs::set_permissions(&second, perms).unwrap();
                }
                stored
            },
            |path, previous| settings.restore(path, previous),
        )
        .unwrap_err();
        assert!(error.contains("cannot be read"), "{error}");
        assert_eq!(read(&first), json!({"keep": 1}));
        let mut open = std::fs::metadata(&second).unwrap().permissions();
        open.set_mode(0o644);
        std::fs::set_permissions(&second, open).unwrap();
        assert_eq!(read(&second), json!({"keep": 2}));
    }

    #[test]
    fn refresh_copies_an_enabled_hook_to_a_new_login_and_leaves_off_alone() {
        let root = tempfile::tempdir().unwrap();
        login(root.path(), ".claude");
        let settings = settings(root.path());
        settings.refresh();
        assert!(!root.path().join(".claude/settings.json").exists());
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        login(root.path(), ".claude-work");
        settings.refresh();
        assert_eq!(
            command(&read(&root.path().join(".claude-work/settings.json"))).len(),
            1
        );
    }

    #[test]
    fn absent_without_a_login_directory() {
        let root = tempfile::tempdir().unwrap();
        let settings = settings(root.path());
        assert!(settings.get().is_empty());
        let error = settings.set(SETTING, &json!(true)).unwrap().unwrap_err();
        assert!(error.contains("No Claude Code login"), "{error}");
        assert!(!root.path().join(".claude").exists());
        assert_eq!(
            settings.set(SETTING, &json!("yes")),
            Some(Err(format!("{SETTING} must be true or false.")))
        );
        assert_eq!(settings.set("direct_delivery", &json!(true)), None);
    }

    #[test]
    fn login_settings_is_the_only_list_the_hook_uses() {
        let root = tempfile::tempdir().unwrap();
        login(root.path(), ".claude");
        login(root.path(), ".claude-work");
        login(root.path(), ".seclaude");
        let config = ClaudeConfig {
            home: root.path().join(".claude"),
            executable: None,
            app_sessions: None,
            dirs: ClaudeDirs::default(),
        };
        let names: Vec<String> = ClaudeSettings::new(&config)
            .login_settings()
            .into_iter()
            .filter_map(|login| {
                login
                    .user_settings
                    .parent()
                    .and_then(|dir| dir.file_name())
                    .map(|name| name.to_string_lossy().into_owned())
            })
            .collect();
        assert_eq!(
            names,
            vec![".claude".to_string(), ".claude-work".to_string()]
        );
    }

    #[test]
    fn an_unshared_login_loses_a_hook_installed_while_it_was_shared() {
        let root = tempfile::tempdir().unwrap();
        login(root.path(), ".claude");
        login(root.path(), ".claude-work");
        let relay = root.path().join("relay");
        std::fs::create_dir_all(&relay).unwrap();
        let record = relay.join(crate::relay::claude_dirs::FILE);
        let config = ClaudeConfig {
            home: root.path().join(".claude"),
            executable: None,
            app_sessions: None,
            dirs: ClaudeDirs {
                environment: Vec::new(),
                file: Some(record.clone()),
            },
        };
        let settings = ClaudeSessionHookSettings::new(
            &config,
            ClaudeSessionHookSettings::command_for(Path::new("/Apps/Agent Relay.app/probe"), false),
        );
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        let primary = root.path().join(".claude/settings.json");
        let work = root.path().join(".claude-work/settings.json");
        assert_eq!(command(&read(&work)).len(), 1);
        let work_dir = root.path().join(".claude-work");
        std::fs::write(
            &record,
            serde_json::to_vec(&json!({
                "folders": { work_dir.to_str().unwrap(): { "shared": false } }
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            settings.get()[SETTING],
            true,
            "a leftover hook on an unshared login still counts as on"
        );
        settings.refresh();
        assert!(
            !work.exists(),
            "refresh takes the hook out of a folder that is no longer shared"
        );
        assert_eq!(command(&read(&primary)).len(), 1);
        assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
        // Both files were the hook's own: gone once it is out.
        assert!(!primary.exists());
        assert!(!work.exists());
        assert_eq!(settings.get()[SETTING], false);
    }

    #[test]
    fn turning_on_does_nothing_when_every_login_is_unshared() {
        let root = tempfile::tempdir().unwrap();
        login(root.path(), ".claude");
        login(root.path(), ".claude-work");
        let relay = root.path().join("relay");
        std::fs::create_dir_all(&relay).unwrap();
        let record = relay.join(crate::relay::claude_dirs::FILE);
        let config = ClaudeConfig {
            home: root.path().join(".claude"),
            executable: None,
            app_sessions: None,
            dirs: ClaudeDirs {
                environment: Vec::new(),
                file: Some(record.clone()),
            },
        };
        let settings = ClaudeSessionHookSettings::new(
            &config,
            ClaudeSessionHookSettings::command_for(Path::new("/Apps/Agent Relay.app/probe"), false),
        );
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        let primary = root.path().join(".claude/settings.json");
        let work = root.path().join(".claude-work/settings.json");
        let primary_bytes = std::fs::read(&primary).unwrap();
        let work_bytes = std::fs::read(&work).unwrap();
        std::fs::write(
            &record,
            serde_json::to_vec(&json!({
                "folders": {
                    root.path().join(".claude").to_str().unwrap(): { "shared": false },
                    root.path().join(".claude-work").to_str().unwrap(): { "shared": false }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let error = settings.set(SETTING, &json!(true)).unwrap().unwrap_err();
        assert!(error.contains("No shared Claude Code login"), "{error}");
        assert_eq!(std::fs::read(&primary).unwrap(), primary_bytes);
        assert_eq!(std::fs::read(&work).unwrap(), work_bytes);
        assert_eq!(settings.get()[SETTING], true);
    }

    #[test]
    fn an_unreadable_unshared_file_does_not_block_shared_logins() {
        let root = tempfile::tempdir().unwrap();
        login(root.path(), ".claude");
        login(root.path(), ".claude-work");
        let relay = root.path().join("relay");
        std::fs::create_dir_all(&relay).unwrap();
        let record = relay.join(crate::relay::claude_dirs::FILE);
        let config = ClaudeConfig {
            home: root.path().join(".claude"),
            executable: None,
            app_sessions: None,
            dirs: ClaudeDirs {
                environment: Vec::new(),
                file: Some(record.clone()),
            },
        };
        let settings = ClaudeSessionHookSettings::new(
            &config,
            ClaudeSessionHookSettings::command_for(Path::new("/Apps/Agent Relay.app/probe"), false),
        );
        let primary = root.path().join(".claude/settings.json");
        let work = root.path().join(".claude-work/settings.json");
        std::fs::write(&work, "not json").unwrap();
        std::fs::write(
            &record,
            serde_json::to_vec(&json!({
                "folders": {
                    root.path().join(".claude-work").to_str().unwrap(): { "shared": false }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(settings.set(SETTING, &json!(true)), Some(Ok(())));
        assert_eq!(command(&read(&primary)).len(), 1);
        assert_eq!(std::fs::read(&work).unwrap(), b"not json");
        assert_eq!(settings.set(SETTING, &json!(false)), Some(Ok(())));
        assert!(
            !primary.exists(),
            "the hook's own file goes once it is empty"
        );
        assert_eq!(std::fs::read(&work).unwrap(), b"not json");
        assert_eq!(settings.get()[SETTING], false);
    }
}
