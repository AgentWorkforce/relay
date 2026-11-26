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
//! - that asked for exactly the command line that ancestor runs: the script
//!   appears in the call as one whole string literal (JS or JSON), or the
//!   call's argv is the process's.
//!
//! Every chat's current turn must be read in full: a rollout the app-server
//! does not have open, or whose current turn runs past the bounded tail this
//! reads, leaves the answer unknown, and the caller is refused. A copied
//! `CODEX_THREAD_ID` therefore names nobody: the copying chat's own pending
//! call asked for its command too, so two chats would match. As with the
//! watcher, the first process to ask binds the call.
//!
//! The trust this rests on: a chat cannot write another chat's rollout. Same-user processes
//! can (any process of this user can write the file), so forging attribution
//! takes deliberately writing a tool call into another chat's transcript,
//! not just copying its environment.

use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::watch::{runs_command, Spawned};

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

/// One tool call a chat has made in its current turn and has no output for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Pending {
    pub call: String,
    /// When Codex recorded the call, in milliseconds since the epoch.
    pub recorded_ms: i64,
    /// The call's string literals: a code-mode script's JS strings, or every
    /// string in a function call's JSON arguments.
    pub literals: Vec<String>,
    /// Argument arrays the call carries (`shell`, `local_shell_call`).
    pub argvs: Vec<Vec<String>>,
}

impl Pending {
    /// Whether this call asked for the command `argv` is running.
    fn requested(&self, argv: &[String]) -> bool {
        self.literals.iter().any(|script| script_runs(script, argv))
            || self
                .argvs
                .iter()
                .any(|announced| runs_command(announced, argv))
    }
}

/// Whether a process running `argv` runs `script` as Codex runs a command:
/// `<shell> -c|-lc <script>` (PowerShell's `-Command`, `cmd /c`), or the
/// script's own words when the shell replaced itself with a lone command.
pub(crate) fn script_runs(script: &str, argv: &[String]) -> bool {
    if script.trim().is_empty() || argv.is_empty() {
        return false;
    }
    let count = argv.len();
    if count >= 3 && argv[count - 1] == script {
        let program = argv[0]
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(&argv[0])
            .to_ascii_lowercase();
        let program = program.strip_suffix(".exe").unwrap_or(&program);
        let flag = argv[count - 2].to_ascii_lowercase();
        let posix = matches!(program, "sh" | "bash" | "zsh" | "dash" | "ksh" | "fish")
            && matches!(flag.as_str(), "-c" | "-lc");
        let windows = (matches!(program, "powershell" | "pwsh") && flag == "-command")
            || (program == "cmd" && flag == "/c");
        if posix || windows {
            return true;
        }
    }
    shell_words::split(script).is_ok_and(|words| words == argv)
}

/// The tool calls the rollout at `path` shows pending in the chat's current
/// turn, read from its end. `None` when that turn cannot be read in full.
pub(crate) fn pending_calls(path: &Path) -> Option<Vec<Pending>> {
    let mut file = std::fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    let mut window = FIRST_TAIL;
    loop {
        let start = length.saturating_sub(window);
        file.seek(SeekFrom::Start(start)).ok()?;
        let mut bytes = Vec::with_capacity((length - start) as usize);
        file.by_ref()
            .take(length - start)
            .read_to_end(&mut bytes)
            .ok()?;
        let text = String::from_utf8_lossy(&bytes);
        let whole = start == 0;
        if let Some(found) = current_turn(&text, whole) {
            return Some(found);
        }
        if whole || window >= MAX_TAIL {
            return None;
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
                            literals = js_string_literals(payload["input"].as_str().unwrap_or(""));
                        }
                    }
                    "function_call" => {
                        if let Some(arguments) = payload["arguments"]
                            .as_str()
                            .and_then(|a| serde_json::from_str::<Value>(a).ok())
                        {
                            json_strings(&arguments, &mut literals, &mut argvs, 0);
                        }
                    }
                    _ => json_strings(&payload["action"], &mut literals, &mut argvs, 0),
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

/// Every string in `value`, and every array of strings as an argv.
fn json_strings(
    value: &Value,
    literals: &mut Vec<String>,
    argvs: &mut Vec<Vec<String>>,
    depth: usize,
) {
    if depth > 16 {
        return;
    }
    match value {
        Value::String(text) => literals.push(text.clone()),
        Value::Array(items) => {
            let words: Option<Vec<String>> = items
                .iter()
                .map(|item| item.as_str().map(str::to_string))
                .collect();
            match words {
                Some(words) if !words.is_empty() => argvs.push(words),
                _ => items
                    .iter()
                    .for_each(|item| json_strings(item, literals, argvs, depth + 1)),
            }
        }
        Value::Object(fields) => fields
            .values()
            .for_each(|item| json_strings(item, literals, argvs, depth + 1)),
        _ => {}
    }
}

/// The string literals in a JS source, decoded: `"…"`, `'…'`, and template
/// literals without substitutions. Comments are skipped; a template with a
/// `${…}` substitution is not a literal.
pub(crate) fn js_string_literals(source: &str) -> Vec<String> {
    let chars: Vec<char> = source.chars().collect();
    let mut literals = Vec::new();
    let mut at = 0;
    while at < chars.len() {
        match chars[at] {
            '/' if chars.get(at + 1) == Some(&'/') => {
                while at < chars.len() && chars[at] != '\n' {
                    at += 1;
                }
            }
            '/' if chars.get(at + 1) == Some(&'*') => {
                at += 2;
                while at < chars.len() && !(chars[at] == '*' && chars.get(at + 1) == Some(&'/')) {
                    at += 1;
                }
                at += 2;
            }
            quote @ ('"' | '\'' | '`') => {
                let (literal, next) = js_literal(&chars, at + 1, quote);
                if let Some(literal) = literal {
                    literals.push(literal);
                }
                at = next;
                continue;
            }
            _ => {}
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
    Matched(BTreeMap<String, Vec<String>>),
    /// A held chat's current turn could not be read.
    Unknown(String),
}

/// Reads every held chat's rollout (`rollouts`: thread → the path the
/// app-server has open) for a pending call, recorded by `latest_ms`, that
/// asked for the command `argv` runs.
pub(crate) fn read(
    rollouts: &BTreeMap<String, PathBuf>,
    argv: &[String],
    latest_ms: i64,
) -> Reading {
    let mut matched = BTreeMap::new();
    for (thread, path) in rollouts {
        let Some(pending) = pending_calls(path) else {
            return Reading::Unknown(thread.clone());
        };
        let calls: Vec<String> = pending
            .iter()
            .filter(|call| call.recorded_ms <= latest_ms && call.requested(argv))
            .map(|call| call.call.clone())
            .collect();
        if !calls.is_empty() {
            matched.insert(thread.clone(), calls);
        }
    }
    Reading::Matched(matched)
}

/// The held chats' rollouts as the app-server has them open: thread → path,
/// for each lock it holds. `None` when a held chat has no open rollout, or
/// two that disagree.
pub(crate) fn held_rollouts(
    locks: &BTreeSet<String>,
    open: &[PathBuf],
) -> Option<BTreeMap<String, PathBuf>> {
    let mut rollouts: BTreeMap<String, PathBuf> = BTreeMap::new();
    for path in open {
        let Some(thread) = crate::relay::process::rollout_thread_of_path(path) else {
            continue;
        };
        if !locks.contains(&thread) {
            continue;
        }
        match rollouts.get(&thread) {
            Some(existing) if existing != path => return None,
            _ => {
                rollouts.insert(thread, path.clone());
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
    rollouts: &BTreeMap<String, PathBuf>,
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
            Reading::Matched(matched) if matched.is_empty() => {}
            Reading::Matched(matched) => {
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

/// The processes each call's command has vouched for: (thread, call,
/// command line) → (pid, kernel start).
#[derive(Default)]
struct Bound {
    by_command: HashMap<(String, String, Vec<String>), (i32, u64)>,
    order: VecDeque<(String, String, Vec<String>)>,
}

fn bound() -> &'static Mutex<Bound> {
    static BOUND: OnceLock<Mutex<Bound>> = OnceLock::new();
    BOUND.get_or_init(|| Mutex::new(Bound::default()))
}

/// Binds `spawned` to the first of `calls` (one chat's, each asking for its
/// command) that it already holds or that is free. False when every one
/// vouched for another process first.
fn bind(thread: &str, calls: &[String], spawned: &Spawned) -> bool {
    let mut bound = bound().lock().unwrap_or_else(|e| e.into_inner());
    let me = (spawned.pid, spawned.start);
    let keys: Vec<_> = calls
        .iter()
        .map(|call| (thread.to_string(), call.clone(), spawned.argv.clone()))
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
    if bound.order.len() >= MAX_BOUND {
        if let Some(oldest) = bound.order.pop_front() {
            bound.by_command.remove(&oldest);
        }
    }
    bound.order.push_back(free.clone());
    bound.by_command.insert(free, me);
    true
}

#[cfg(test)]
mod tests;
