//! Which chat started a command under a Codex app-server that cannot be
//! watched, read from the chats' own transcripts.
//!
//! [`super::watch`] asks the managed app-server daemon which chat announced
//! a command. An app-server another program runs over stdio (the ChatGPT
//! desktop app's, say) accepts no second client, so nothing can subscribe to
//! its announcements. It does keep every chat's rollout open, and Codex
//! records the model's tool call there (a code-mode `exec` script, or an
//! `exec_command`/`shell` call) before it starts the command the call asks
//! for, and records the call's output only once the call is over.
//!
//! So a caller under such an app-server is the claimed chat's only when, of
//! all the chats whose writer locks the app-server holds, exactly that one has
//! a tool call
//!
//! - still pending in its current turn (no output recorded yet),
//! - recorded no later than the caller's ancestor directly under the
//!   app-server started, and
//! - that asked for exactly the command line that ancestor runs: a code-mode
//!   script hands it as a whole string literal to a `cmd`/`command`
//!   property, or an `exec_command`/`shell` call names it as its `cmd` or
//!   `command`. A command built any other way is not seen, and refused.
//!
//! Every chat's current turn must be read in full. A rollout the app-server
//! does not have open, a current turn longer than the bounded tail this
//! reads, or a file that is not the one the app-server has open (its
//! creation time differs) leaves the answer unknown, and the caller is
//! refused. A copied `CODEX_THREAD_ID` therefore names nobody: the copying
//! chat's own pending call asked for its command too, so the claimed chat is
//! not the only one that did. As with the watcher, the first process to ask
//! binds the requested command, in every form a process can run it.
//!
//! The trust this rests on: a chat cannot write another chat's rollout. Any
//! process of this user can, so forging attribution takes deliberately
//! writing a tool call into another chat's transcript, not just copying its
//! environment. As with the watcher, a chat that builds another chat's
//! pending command line some other way and starts it first is named as that
//! chat for that one command, whose text the other chat chose; the other
//! chat's own process is then refused.

use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::watch::Spawned;

/// The first tail read of a rollout; most turns fit.
const FIRST_TAIL: u64 = 256 * 1024;
/// The most read from the end of one rollout. A current turn longer than
/// this leaves that chat unknown.
pub const MAX_TAIL: u64 = 8 * 1024 * 1024;
/// How long after the caller's command started its call record is surely on
/// disk: reads before then are not trusted to show every chat's calls.
const SETTLE_MS: i64 = 100;
/// How often the rollouts are read again while no chat shows the command.
const POLL: Duration = Duration::from_millis(50);
/// The most commands remembered as bound.
const MAX_BOUND: usize = 4096;
/// How long a binding is kept before it may make room for another: longer
/// than any command a call keeps running.
const BOUND_KEEP: Duration = Duration::from_secs(24 * 3600);

/// One tool call a chat has made in its current turn and has no output for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Pending {
    pub call: String,
    /// When Codex recorded the call, in milliseconds since the epoch.
    pub recorded_ms: i64,
    /// The command scripts the call asked for: in a code-mode script, each
    /// whole string literal given as a `cmd`/`command` property; in an
    /// `exec_command`/`shell` function call, its `cmd` or `command` string.
    pub literals: Vec<String>,
    /// Command argument arrays the call asked for (`shell`'s `command`,
    /// `local_shell_call`'s action).
    pub argvs: Vec<Vec<String>>,
}

impl Pending {
    /// Which of this call's requested commands (`literals`, then `argvs`, by
    /// index) the command `argv` is running is.
    fn requested(&self, argv: &[String]) -> Vec<usize> {
        let scripts = self
            .literals
            .iter()
            .enumerate()
            .filter(|(_, script)| script_runs(script, argv))
            .map(|(at, _)| at);
        let arrays = self
            .argvs
            .iter()
            .enumerate()
            .filter(|(_, announced)| argv_runs(announced, argv))
            .map(|(at, _)| self.literals.len() + at);
        scripts.chain(arrays).collect()
    }
}

/// The function tools that run a command line.
const EXEC_TOOLS: [&str; 5] = [
    "exec_command",
    "shell",
    "shell_command",
    "local_shell",
    "container.exec",
];

/// Whether a process running `argv` runs the command array `announced`:
/// exactly, or, when `announced` is `<shell> -c|-lc <script>` for a shell
/// [`script_runs`] knows, as that script. Another program's `-c` source is
/// never read as a shell script.
pub(crate) fn argv_runs(announced: &[String], argv: &[String]) -> bool {
    if announced.is_empty() || argv.is_empty() {
        return false;
    }
    if announced == argv {
        return true;
    }
    let count = announced.len();
    count >= 3
        && is_shell_flag(&announced[0], &announced[count - 2])
        && script_runs(&announced[count - 1], argv)
}

/// Whether `program flag <script>` is how a shell runs a script: `sh`,
/// `bash`, `zsh`, `dash`, `ksh` or `fish` with `-c`/`-lc`, PowerShell with
/// `-Command`, or `cmd /c`.
fn is_shell_flag(program: &str, flag: &str) -> bool {
    let program = program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(program)
        .to_ascii_lowercase();
    let program = program.strip_suffix(".exe").unwrap_or(&program);
    let flag = flag.to_ascii_lowercase();
    (matches!(program, "sh" | "bash" | "zsh" | "dash" | "ksh" | "fish")
        && matches!(flag.as_str(), "-c" | "-lc"))
        || (matches!(program, "powershell" | "pwsh") && flag == "-command")
        || (program == "cmd" && flag == "/c")
}

/// Whether a process running `argv` runs `script` as Codex runs a command:
/// `<shell> -c|-lc <script>` (PowerShell's `-Command`, `cmd /c`), or the
/// script's own words when the shell replaced itself with a lone command.
pub(crate) fn script_runs(script: &str, argv: &[String]) -> bool {
    if script.trim().is_empty() || argv.is_empty() {
        return false;
    }
    let count = argv.len();
    if count >= 3 && argv[count - 1] == script && is_shell_flag(&argv[0], &argv[count - 2]) {
        return true;
    }
    shell_words::split(script).is_ok_and(|words| words == argv)
}

/// The tool calls the rollout at `path` shows pending in the chat's current
/// turn, read from its end. `None` when that turn cannot be read in full, or
/// the file opened is not the one the app-server has open (`birth_ns`, its
/// open file's creation time, when the platform reports one).
#[cfg(test)]
pub(crate) fn pending_calls(path: &Path, birth_ns: Option<i128>) -> Option<Vec<Pending>> {
    match read_pending(path, birth_ns) {
        Ok(pending) => Some(pending),
        Err(_) => None,
    }
}

/// Why a rollout's current turn could not be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Unread {
    /// Its last record is still being written: read it again.
    Writing,
    /// It cannot be read in full.
    Unknown,
}

/// [`pending_calls`], telling a record still being written apart.
pub(crate) fn read_pending(path: &Path, birth_ns: Option<i128>) -> Result<Vec<Pending>, Unread> {
    let unknown = |_| Unread::Unknown;
    let mut file = std::fs::File::open(path).map_err(unknown)?;
    let metadata = file.metadata().map_err(unknown)?;
    if let Some(expected) = birth_ns {
        let created = metadata
            .created()
            .map_err(unknown)?
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| Unread::Unknown)?;
        if i128::try_from(created.as_nanos()).ok() != Some(expected) {
            return Err(Unread::Unknown);
        }
    }
    let length = metadata.len();
    let mut window = FIRST_TAIL;
    loop {
        let start = length.saturating_sub(window);
        file.seek(SeekFrom::Start(start)).map_err(unknown)?;
        let mut bytes = Vec::with_capacity((length - start) as usize);
        file.by_ref()
            .take(length - start)
            .read_to_end(&mut bytes)
            .map_err(unknown)?;
        // A record without its newline yet may be another call: wait for it
        // rather than read the turn without it.
        if bytes.last().is_some_and(|last| *last != b'\n') {
            return Err(Unread::Writing);
        }
        let text = String::from_utf8_lossy(&bytes);
        let whole = start == 0;
        if let Some(found) = current_turn(&text, whole) {
            return Ok(found);
        }
        if whole || window >= MAX_TAIL {
            return Err(Unread::Unknown);
        }
        window = (window * 4).min(MAX_TAIL);
    }
}

/// The pending calls in `text`, the end of a rollout (all of it when
/// `whole`). `None` when the text does not reach back to the current turn's
/// start, or a record in that turn does not parse.
pub(crate) fn current_turn(text: &str, whole: bool) -> Option<Vec<Pending>> {
    // A partial first line (a cut mid-record) and an unfinished last line
    // (still being written) are not records.
    let body = if whole {
        text
    } else {
        text.split_once('\n').map_or("", |(_, rest)| rest)
    };
    let complete = match body.rfind('\n') {
        Some(end) => &body[..end],
        None => "",
    };
    let lines: Vec<&str> = complete.lines().filter(|l| !l.trim().is_empty()).collect();
    let mut records = Vec::with_capacity(lines.len());
    let mut boundary = None;
    for line in lines.iter().rev() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            // A broken record inside the current turn leaves it unknown.
            if boundary.is_none() {
                return None;
            }
            break;
        };
        if is_turn_boundary(&record) {
            boundary = Some(());
            break;
        }
        records.push(record);
    }
    if boundary.is_none() && !whole {
        return None;
    }
    records.reverse();
    let mut pending: Vec<Pending> = Vec::new();
    for record in &records {
        if record["type"] != "response_item" {
            continue;
        }
        let payload = &record["payload"];
        let Some(kind) = payload["type"].as_str() else {
            continue;
        };
        let call = payload["call_id"].as_str().map(str::to_string);
        match kind {
            "custom_tool_call_output"
            | "function_call_output"
            | "local_shell_call_output"
            | "tool_search_output" => {
                if let Some(call) = call {
                    pending.retain(|p| p.call != call);
                }
            }
            "custom_tool_call" | "function_call" | "local_shell_call" => {
                let (Some(call), Some(recorded_ms)) = (call, record_ms(record)) else {
                    continue;
                };
                let mut literals = Vec::new();
                let mut argvs = Vec::new();
                match kind {
                    "custom_tool_call" => {
                        if payload["name"] == "exec" {
                            literals = js_command_literals(payload["input"].as_str().unwrap_or(""));
                        }
                    }
                    "function_call" => {
                        let exec = payload["name"]
                            .as_str()
                            .is_some_and(|name| EXEC_TOOLS.contains(&name));
                        if let Some(arguments) = payload["arguments"]
                            .as_str()
                            .and_then(|a| serde_json::from_str::<Value>(a).ok())
                            .filter(|_| exec)
                        {
                            command_fields(&arguments, &mut literals, &mut argvs);
                        }
                    }
                    _ => command_fields(&payload["action"], &mut literals, &mut argvs),
                }
                pending.retain(|p| p.call != call);
                pending.push(Pending {
                    call,
                    recorded_ms,
                    literals,
                    argvs,
                });
            }
            _ => {}
        }
    }
    Some(pending)
}

/// A record that starts or ends a turn: calls before it are no longer
/// running.
fn is_turn_boundary(record: &Value) -> bool {
    record["type"] == "event_msg"
        && matches!(
            record["payload"]["type"].as_str(),
            Some(
                "task_started"
                    | "task_complete"
                    | "turn_aborted"
                    | "turn_started"
                    | "turn_complete"
            )
        )
}

/// A record's `timestamp`, in milliseconds since the epoch.
fn record_ms(record: &Value) -> Option<i64> {
    let text = record["timestamp"].as_str()?;
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|time| time.timestamp_millis())
}

/// The command an exec tool's arguments ask for: a `cmd` or `command`
/// string as a script, or a `command` array of strings as an argv.
fn command_fields(value: &Value, literals: &mut Vec<String>, argvs: &mut Vec<Vec<String>>) {
    for field in ["cmd", "command"] {
        match &value[field] {
            Value::String(script) => literals.push(script.clone()),
            Value::Array(items) => {
                let words: Option<Vec<String>> = items
                    .iter()
                    .map(|item| item.as_str().map(str::to_string))
                    .collect();
                if let Some(words) = words.filter(|words| !words.is_empty()) {
                    argvs.push(words);
                }
            }
            _ => {}
        }
    }
}

/// The string literals a JS source gives as a `cmd` or `command` property
/// (`{cmd: "…"}`, `{"command": '…'}`): what a code-mode script hands
/// `tools.exec_command`. A command built any other way is not seen.
pub(crate) fn js_command_literals(source: &str) -> Vec<String> {
    js_literals(source)
        .into_iter()
        .filter(|(_, command)| *command)
        .map(|(literal, _)| literal)
        .collect()
}

/// Every string literal in a JS source, decoded.
#[cfg(test)]
pub(crate) fn js_string_literals(source: &str) -> Vec<String> {
    js_literals(source)
        .into_iter()
        .map(|(literal, _)| literal)
        .collect()
}

/// Whether the literal starting at `quote` is the value of a `cmd` or
/// `command` property: `cmd:`, `"cmd":` or `'command':` right before it.
fn is_command_value(chars: &[char], quote: usize) -> bool {
    let mut at = quote;
    let skip_space = |at: &mut usize| {
        while *at > 0 && chars[*at - 1].is_whitespace() {
            *at -= 1;
        }
    };
    skip_space(&mut at);
    if at == 0 || chars[at - 1] != ':' {
        return false;
    }
    at -= 1;
    skip_space(&mut at);
    let mut end = at;
    let quoted = at > 0 && matches!(chars[at - 1], '"' | '\'');
    if quoted {
        end -= 1;
    }
    let mut begin = end;
    while begin > 0
        && (chars[begin - 1].is_ascii_alphanumeric() || matches!(chars[begin - 1], '_' | '$'))
    {
        begin -= 1;
    }
    let key: String = chars[begin..end].iter().collect();
    if key != "cmd" && key != "command" {
        return false;
    }
    if quoted {
        begin > 0 && chars[begin - 1] == chars[end]
    } else {
        begin == 0
            || !(chars[begin - 1].is_ascii_alphanumeric()
                || matches!(chars[begin - 1], '_' | '$' | '.'))
    }
}

/// Reserved words after which a `/` starts a regular expression, not a
/// division (not after a `.`, where they are property names). `await` is
/// one too: a code-mode cell is a module with top-level `await`. `of` and
/// `yield` can be identifiers, so they are not here.
const REGEX_AFTER_WORDS: [&str; 11] = [
    "return", "typeof", "case", "do", "else", "in", "void", "delete", "throw", "new", "await",
];

/// The string literals in a JS source, decoded, each with whether it is a
/// `cmd`/`command` property's value: `"…"`, `'…'`, and template literals
/// without substitutions. Comments and regular expression literals are
/// skipped; a template with a `${…}` substitution is not a literal.
fn js_literals(source: &str) -> Vec<(String, bool)> {
    let chars: Vec<char> = source.chars().collect();
    let mut literals = Vec::new();
    // The last significant character outside literals and comments, and
    // the word it ends, to tell a regular expression from a division.
    let mut last: Option<char> = None;
    let mut word = String::new();
    // Whether that word follows a `.` (a property name).
    let mut word_after_dot = false;
    let mut at = 0;
    while at < chars.len() {
        let c = chars[at];
        match c {
            '/' if chars.get(at + 1) == Some(&'/') => {
                while at < chars.len() && chars[at] != '\n' {
                    at += 1;
                }
                continue;
            }
            '/' if chars.get(at + 1) == Some(&'*') => {
                at += 2;
                while at < chars.len() && !(chars[at] == '*' && chars.get(at + 1) == Some(&'/')) {
                    at += 1;
                }
                at += 2;
                continue;
            }
            '/' if last.is_none_or(|prev| "(,=:[!&|?{};+-*%<>~^".contains(prev))
                || (last.is_some_and(|prev| prev.is_ascii_alphanumeric())
                    && !word_after_dot
                    && REGEX_AFTER_WORDS.contains(&word.as_str())) =>
            {
                at += 1;
                let mut class = false;
                while at < chars.len() && chars[at] != '\n' {
                    match chars[at] {
                        '\\' => at += 1,
                        '[' => class = true,
                        ']' => class = false,
                        '/' if !class => break,
                        _ => {}
                    }
                    at += 1;
                }
                at += 1;
                last = Some('/');
                word.clear();
                continue;
            }
            quote @ ('"' | '\'' | '`') => {
                let command = is_command_value(&chars, at);
                let (literal, next) = js_literal(&chars, at + 1, quote);
                if let Some(literal) = literal {
                    literals.push((literal, command));
                }
                at = next;
                last = Some(quote);
                word.clear();
                continue;
            }
            c if c.is_whitespace() => {}
            c => {
                let ident = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '$';
                if ident(c) {
                    if at == 0 || !ident(chars[at - 1]) {
                        word.clear();
                        word_after_dot = last == Some('.');
                    }
                    word.push(c);
                } else {
                    word.clear();
                }
                last = Some(c);
            }
        }
        at += 1;
    }
    literals
}

/// One JS string literal whose body starts at `at`: its decoded text (`None`
/// for a template with a substitution, or one left unterminated) and the
/// index after its closing quote.
fn js_literal(chars: &[char], mut at: usize, quote: char) -> (Option<String>, usize) {
    let mut text = String::new();
    let mut substituted = false;
    while at < chars.len() {
        let c = chars[at];
        if c == quote {
            return ((!substituted).then_some(text), at + 1);
        }
        if quote != '`' && c == '\n' {
            return (None, at);
        }
        if quote == '`' && c == '$' && chars.get(at + 1) == Some(&'{') {
            substituted = true;
            // Skip the substitution, minding nested braces.
            let mut depth = 0usize;
            at += 1;
            while at < chars.len() {
                match chars[at] {
                    '{' => depth += 1,
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    _ => {}
                }
                at += 1;
            }
            at += 1;
            continue;
        }
        if c != '\\' {
            text.push(c);
            at += 1;
            continue;
        }
        at += 1;
        let Some(&escaped) = chars.get(at) else {
            break;
        };
        at += 1;
        match escaped {
            'n' => text.push('\n'),
            'r' => text.push('\r'),
            't' => text.push('\t'),
            'b' => text.push('\u{8}'),
            'f' => text.push('\u{c}'),
            'v' => text.push('\u{b}'),
            '0' if !chars.get(at).is_some_and(char::is_ascii_digit) => text.push('\0'),
            '\r' => {
                if chars.get(at) == Some(&'\n') {
                    at += 1;
                }
            }
            '\n' | '\u{2028}' | '\u{2029}' => {}
            'x' => {
                let hex: String = chars.iter().skip(at).take(2).collect();
                match u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                    Some(decoded) if hex.len() == 2 => {
                        text.push(decoded);
                        at += 2;
                    }
                    _ => return (None, skip_to(chars, at, quote)),
                }
            }
            'u' => match decode_unicode_escape(chars, at) {
                Some((decoded, next)) => {
                    text.push_str(&decoded);
                    at = next;
                }
                None => return (None, skip_to(chars, at, quote)),
            },
            other => text.push(other),
        }
    }
    (None, chars.len())
}

/// After an undecodable escape: the index after the literal's closing quote.
fn skip_to(chars: &[char], mut at: usize, quote: char) -> usize {
    while at < chars.len() {
        match chars[at] {
            '\\' => at += 2,
            c if c == quote => return at + 1,
            _ => at += 1,
        }
    }
    chars.len()
}

/// `\uXXXX` (pairing a surrogate with a following `\uXXXX`) or `\u{X…}`
/// whose body starts at `at`: the text and the index after it.
fn decode_unicode_escape(chars: &[char], at: usize) -> Option<(String, usize)> {
    let hex = |from: usize, count: usize| -> Option<u32> {
        let digits: String = chars.iter().skip(from).take(count).collect();
        (digits.len() == count && digits.chars().all(|c| c.is_ascii_hexdigit()))
            .then(|| u32::from_str_radix(&digits, 16).ok())
            .flatten()
    };
    if chars.get(at) == Some(&'{') {
        let close = (at + 1..chars.len().min(at + 9)).find(|&i| chars[i] == '}')?;
        let digits: String = chars[at + 1..close].iter().collect();
        let code = u32::from_str_radix(&digits, 16).ok()?;
        return Some((char::from_u32(code)?.to_string(), close + 1));
    }
    let first = hex(at, 4)?;
    if (0xD800..0xDC00).contains(&first)
        && chars.get(at + 4) == Some(&'\\')
        && chars.get(at + 5) == Some(&'u')
    {
        if let Some(second) = hex(at + 6, 4).filter(|s| (0xDC00..0xE000).contains(s)) {
            let code = 0x10000 + ((first - 0xD800) << 10) + (second - 0xDC00);
            return Some((char::from_u32(code)?.to_string(), at + 10));
        }
    }
    Some((char::from_u32(first)?.to_string(), at + 4))
}

/// What the held chats' transcripts say about one command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Reading {
    /// The chats with a pending call that asked for the command, and those
    /// calls.
    Matched {
        matched: BTreeMap<String, Vec<(String, usize)>>,
        /// Every held chat's pending call ids, matching or not.
        live: BTreeMap<String, BTreeSet<String>>,
    },
    /// A held chat's current turn could not be read.
    Unknown(String),
    /// A held chat's last record is still being written.
    Writing(String),
}

/// Reads every held chat's rollout (`rollouts`: thread → the file the
/// app-server has open) for a pending call, recorded by `latest_ms`, that
/// asked for the command `argv` runs: each as (call id, which of its
/// requested commands).
pub(crate) fn read(
    rollouts: &BTreeMap<String, Rollout>,
    argv: &[String],
    latest_ms: i64,
) -> Reading {
    let mut matched = BTreeMap::new();
    let mut live = BTreeMap::new();
    for (thread, rollout) in rollouts {
        let pending = match read_pending(&rollout.path, rollout.birth_ns) {
            Ok(pending) => pending,
            Err(Unread::Writing) => return Reading::Writing(thread.clone()),
            Err(Unread::Unknown) => return Reading::Unknown(thread.clone()),
        };
        let calls: Vec<(String, usize)> = pending
            .iter()
            .filter(|call| call.recorded_ms <= latest_ms)
            .flat_map(|call| {
                call.requested(argv)
                    .into_iter()
                    .map(|which| (call.call.clone(), which))
            })
            .collect();
        if !calls.is_empty() {
            matched.insert(thread.clone(), calls);
        }
        live.insert(
            thread.clone(),
            pending.iter().map(|call| call.call.clone()).collect(),
        );
    }
    Reading::Matched { matched, live }
}

/// One held chat's rollout, as the app-server has it open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rollout {
    pub path: PathBuf,
    /// The open file's creation time, when the platform reports it: the file
    /// read must be that same file, not one put in its place.
    pub birth_ns: Option<i128>,
}

/// The held chats' rollouts as the app-server has them open: thread →
/// rollout, for each lock it holds. `None` when a held chat has no open
/// rollout, or two that disagree.
pub fn held_rollouts(
    locks: &BTreeSet<String>,
    open: &[crate::relay::process::OpenedFile],
) -> Option<BTreeMap<String, Rollout>> {
    let mut rollouts: BTreeMap<String, Rollout> = BTreeMap::new();
    for file in open {
        let Some(thread) = crate::relay::process::rollout_thread_of_path(&file.path) else {
            continue;
        };
        if !locks.contains(&thread) {
            continue;
        }
        let rollout = Rollout {
            path: file.path.clone(),
            birth_ns: file.birth_ns,
        };
        match rollouts.get(&thread) {
            Some(existing) if *existing != rollout => return None,
            _ => {
                rollouts.insert(thread, rollout);
            }
        }
    }
    (rollouts.len() == locks.len()).then_some(rollouts)
}

/// Why the transcripts did not name the caller, for diagnostics (no command
/// text: it can carry secrets).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    NoOpenRollout,
    Unknown(String),
    NotSeen,
    OtherChats(Vec<String>),
    AlreadyBound,
}

/// Whether the transcripts of the chats an unwatchable app-server holds
/// (`rollouts`) name `thread` as the chat that started `spawned`, waiting up
/// to `wait` for its call to be readable. `slack_ms` is how far the kernel's
/// start time can lag Codex's clock. The first process to be vouched for
/// binds the call.
pub fn vouch(
    rollouts: &BTreeMap<String, Rollout>,
    thread: &str,
    spawned: &Spawned,
    slack_ms: i64,
    wait: Duration,
) -> Result<(), Refusal> {
    let thread = thread.to_lowercase();
    if !rollouts.contains_key(&thread) {
        return Err(Refusal::NoOpenRollout);
    }
    let latest_ms = spawned.start_ms.saturating_add(slack_ms);
    let deadline = Instant::now() + wait;
    // Wait until the command has run long enough that every call made before
    // it started is surely on disk.
    let settled = spawned.start_ms.saturating_add(SETTLE_MS);
    let now_ms = chrono::Utc::now().timestamp_millis();
    if now_ms < settled {
        std::thread::sleep(Duration::from_millis((settled - now_ms) as u64).min(wait));
    }
    loop {
        match read(rollouts, &spawned.argv, latest_ms) {
            Reading::Unknown(chat) => return Err(Refusal::Unknown(chat)),
            Reading::Writing(chat) => {
                if Instant::now() >= deadline {
                    return Err(Refusal::Unknown(chat));
                }
                std::thread::sleep(Duration::from_millis(10));
                continue;
            }
            Reading::Matched { matched, .. } if matched.is_empty() => {}
            Reading::Matched { matched, live } => {
                retire(&live);
                let others: Vec<String> = matched
                    .keys()
                    .filter(|chat| **chat != thread)
                    .cloned()
                    .collect();
                if !others.is_empty() {
                    return Err(Refusal::OtherChats(others));
                }
                let calls = matched.get(&thread).cloned().unwrap_or_default();
                return if bind(&thread, &calls, spawned) {
                    Ok(())
                } else {
                    Err(Refusal::AlreadyBound)
                };
            }
        }
        if Instant::now() >= deadline {
            return Err(Refusal::NotSeen);
        }
        std::thread::sleep(POLL);
    }
}

/// One command a call asked for: (thread, call id, which of the call's
/// requested commands).
type CommandKey = (String, String, usize);

/// The process each requested command has vouched for → (pid, kernel
/// start). Every process form of one requested command (`zsh -c S`, `bash
/// -c S`, `S`'s own words) shares its key, so only one process is ever named
/// for it.
#[derive(Default)]
struct Bound {
    by_command: HashMap<CommandKey, (i32, u64)>,
    order: VecDeque<(CommandKey, Instant)>,
}

fn bound() -> &'static Mutex<Bound> {
    static BOUND: OnceLock<Mutex<Bound>> = OnceLock::new();
    BOUND.get_or_init(|| Mutex::new(Bound::default()))
}

/// Forgets the bindings of calls the chats in `live` (each held chat's
/// pending calls) no longer have pending: a call with recorded output never
/// asks again, so its binding can go.
fn retire(live: &BTreeMap<String, BTreeSet<String>>) {
    let mut bound = bound().lock().unwrap_or_else(|e| e.into_inner());
    let over = |key: &CommandKey| {
        live.get(&key.0)
            .is_some_and(|pending| !pending.contains(&key.1))
    };
    bound.by_command.retain(|key, _| !over(key));
    bound.order.retain(|(key, _)| !over(key));
}

/// Binds `spawned` to the first of `calls` (one chat's requested commands
/// it runs) that it already holds or that is free. False when every one
/// vouched for another process first.
fn bind(thread: &str, calls: &[(String, usize)], spawned: &Spawned) -> bool {
    let mut bound = bound().lock().unwrap_or_else(|e| e.into_inner());
    let me = (spawned.pid, spawned.start);
    let keys: Vec<CommandKey> = calls
        .iter()
        .map(|(call, which)| (thread.to_string(), call.clone(), *which))
        .collect();
    if keys
        .iter()
        .any(|key| bound.by_command.get(key) == Some(&me))
    {
        return true;
    }
    let Some(free) = keys
        .into_iter()
        .find(|key| !bound.by_command.contains_key(key))
    else {
        return false;
    };
    // Still full after `retire`: only a binding old enough that its command
    // has surely ended makes room; otherwise nothing new is vouched for.
    if bound.order.len() >= MAX_BOUND {
        match bound.order.front() {
            Some((_, at)) if at.elapsed() >= BOUND_KEEP => {
                if let Some((oldest, _)) = bound.order.pop_front() {
                    bound.by_command.remove(&oldest);
                }
            }
            _ => return false,
        }
    }
    bound.order.push_back((free.clone(), Instant::now()));
    bound.by_command.insert(free, me);
    true
}

#[cfg(test)]
mod tests;
