//! What a relay agent is doing, derived on the desktop it runs on from what
//! its harness records anyway, so an agent never has to report it: whether a
//! turn is running, the repository and branch it works in, and a short line
//! made of the session's title and the in-progress item of its own to-do
//! list (Claude Code's tasks or TodoWrite, Codex's `update_plan`).
//!
//! Transcripts are tail-read: the first look reads at most `FIRST_READ`
//! bytes from the end, later looks only what was appended. Git is read from
//! the repository's files, never by running `git`, and cached.

pub mod publication;

use crate::relay::people::{Liveness, RosterAgent, RosterWhere};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// Whether a turn is running.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(extend("x-fallback" = "idle"))]
pub enum AgentTurn {
    /// A turn is running, or one is blocked on a permission.
    Working,
    /// Between turns: ready for a message.
    Idle,
}

/// What an agent is doing, as the desktop it runs on derived it. Every
/// field is absent when its harness or session does not say.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct AgentActivity {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<AgentTurn>,
    /// The repository of its working directory: the `origin` remote's
    /// name, else the checkout's folder name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// The checked-out branch, or a short commit when detached.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// The session's title and its to-do list's item in progress, at most
    /// `DOING_CHARACTERS` characters, without invite links.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doing: Option<String>,
    /// When it last changed, in milliseconds since the epoch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_ms: Option<i64>,
}

impl AgentActivity {
    /// Whether it says anything at all.
    pub fn is_empty(&self) -> bool {
        self.turn.is_none() && self.repo.is_none() && self.branch.is_none() && self.doing.is_none()
    }

    /// The same activity without its time, for telling changes apart.
    pub fn untimed(&self) -> AgentActivity {
        AgentActivity {
            updated_ms: None,
            ..self.clone()
        }
    }

    /// Reads one from a roster record's `activity` metadata, dropping what
    /// does not fit what a desktop publishes.
    pub fn from_metadata(value: &Value) -> Option<AgentActivity> {
        let text = |key: &str, limit: usize| {
            value[key]
                .as_str()
                .map(|text| clip(&without_invites(text), limit))
                .filter(|text| !text.is_empty())
        };
        let activity = AgentActivity {
            turn: serde_json::from_value(value["turn"].clone()).ok(),
            repo: text("repo", NAME_CHARACTERS),
            branch: text("branch", NAME_CHARACTERS),
            doing: text("doing", DOING_CHARACTERS),
            updated_ms: value["updated_ms"].as_i64(),
        };
        (!activity.is_empty()).then_some(activity)
    }
}

/// Each live roster agent's `activity`: for this computer's agents what the
/// core derived last (`local`), for every other its Relaycast record's
/// `activity` metadata in `items`. An agent not live has none.
pub fn fill_roster(
    agents: &mut [RosterAgent],
    items: &[Value],
    local: &HashMap<String, AgentActivity>,
) {
    for agent in agents.iter_mut().filter(|a| a.liveness == Liveness::Live) {
        agent.activity = if agent.where_runs == RosterWhere::ThisComputer {
            local.get(&agent.name).cloned()
        } else {
            items
                .iter()
                .find(|item| item["name"] == agent.name.as_str())
                .and_then(|item| AgentActivity::from_metadata(&item["metadata"]["activity"]))
        };
    }
}

/// What one session's own records say, before its title is added.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SessionActivity {
    pub turn: Option<AgentTurn>,
    pub repo: Option<String>,
    pub branch: Option<String>,
    /// The item in progress on its to-do list.
    pub task: Option<String>,
}

/// The longest `doing` line.
pub const DOING_CHARACTERS: usize = 120;
/// The longest repository or branch name.
const NAME_CHARACTERS: usize = 80;

impl SessionActivity {
    /// The published activity for a session titled `title`.
    pub fn with_title(self, title: &str) -> Option<AgentActivity> {
        let activity = AgentActivity {
            turn: self.turn,
            repo: self.repo.map(|repo| clip(&repo, NAME_CHARACTERS)),
            branch: self.branch.map(|branch| clip(&branch, NAME_CHARACTERS)),
            doing: doing_line(title, self.task.as_deref()),
            updated_ms: None,
        };
        (!activity.is_empty()).then_some(activity)
    }
}

/// `title · task`, either alone, or nothing; one line of at most
/// `DOING_CHARACTERS` characters, without invite links.
pub fn doing_line(title: &str, task: Option<&str>) -> Option<String> {
    let title = clip(&without_invites(title), usize::MAX);
    let task = task
        .map(|task| clip(&without_invites(task), usize::MAX))
        .filter(|task| !task.is_empty());
    let line = match (title.is_empty(), task) {
        (false, Some(task)) if !title.eq_ignore_ascii_case(&task) => format!("{title} · {task}"),
        (false, _) => title,
        (true, Some(task)) => task,
        (true, None) => return None,
    };
    Some(clip(&line, DOING_CHARACTERS))
}

/// One line of single spaces, cut to `limit` characters with an ellipsis.
fn clip(text: &str, limit: usize) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= limit {
        return line;
    }
    let mut cut: String = line.chars().take(limit.saturating_sub(1)).collect();
    cut.truncate(cut.trim_end().len());
    cut.push('…');
    cut
}

/// `text` without the words that let someone in: Agent Relay links, Relay
/// Connect and other invite or join links, links carrying a token or code,
/// and Relay workspace keys.
pub fn without_invites(text: &str) -> String {
    text.split_whitespace()
        .filter(|word| !is_invite(word))
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_invite(word: &str) -> bool {
    let lower = word.to_ascii_lowercase();
    let word = lower.trim_start_matches(|c: char| !c.is_ascii_alphanumeric());
    // A key anywhere in the word, as in `RELAY_API_KEY=rk_live_…`.
    if word.starts_with("agentrelay://") || word.contains("rk_live_") || word.contains("rk_test_") {
        return true;
    }
    // An assignment of a secret: `API_TOKEN=…`, `password:…`.
    let secret = ["key", "token", "secret", "password"];
    if let Some((name, value)) = word.split_once(['=', ':']) {
        if !value.is_empty() && !value.starts_with("//") && secret.iter().any(|s| name.contains(s))
        {
            return true;
        }
    }
    if !word.contains("://") {
        return false;
    }
    [
        "/connect", "/invite", "/join", "token=", "invite=", "code=", "key=",
    ]
    .iter()
    .any(|marker| word.contains(marker))
}

// MARK: To-do lists

/// The item in progress in a to-do list: `Some(None)` when the list has
/// none, `None` when `items` is no to-do list.
fn in_progress(items: &[Value]) -> Option<Option<String>> {
    // An empty list clears the one before it.
    if !items.is_empty() && !items.iter().any(|item| item["status"].is_string()) {
        return None;
    }
    Some(
        items
            .iter()
            .find(|item| matches!(item["status"].as_str(), Some("in_progress" | "in-progress")))
            .and_then(|item| {
                ["activeForm", "content", "step", "subject"]
                    .iter()
                    .find_map(|key| item[*key].as_str())
                    .map(str::to_string)
            }),
    )
}

/// The to-do list one transcript line writes: Claude Code's `TodoWrite`
/// tool call, or Codex's `update_plan` function call (whose arguments are a
/// JSON string). `None` when the line writes none.
pub fn todo_written(line: &Value) -> Option<Option<String>> {
    // Codex: {"type":"response_item","payload":{"type":"function_call","name":"update_plan",...}}
    let payload = &line["payload"];
    if payload["type"] == "function_call" && payload["name"] == "update_plan" {
        let arguments: Value = serde_json::from_str(payload["arguments"].as_str()?).ok()?;
        return in_progress(arguments["plan"].as_array()?);
    }
    // Claude Code: an assistant message whose content has a TodoWrite tool use.
    let mut found = None;
    for block in line["message"]["content"].as_array().into_iter().flatten() {
        if block["type"] == "tool_use" && block["name"] == "TodoWrite" {
            if let Some(list) = block["input"]["todos"]
                .as_array()
                .and_then(|t| in_progress(t))
            {
                found = Some(list);
            }
        }
    }
    found
}

/// The item in progress on a Claude Code session's task list, the files of
/// `<config>/tasks/<session>/`; `None` when it has no task list.
pub fn claude_task(tasks: &Path) -> Option<Option<String>> {
    let entries = std::fs::read_dir(tasks).ok()?;
    let mut items = Vec::new();
    for entry in entries.flatten().take(500) {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if entry.metadata().map_or(true, |m| m.len() > 256 * 1024) {
            continue;
        }
        if let Some(item) = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        {
            items.push((path, item));
        }
    }
    // The lowest-numbered task first, as Claude Code lists them.
    items.sort_by_key(|(path, _)| {
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default();
        (stem.parse::<u64>().unwrap_or(u64::MAX), stem.to_string())
    });
    let items: Vec<Value> = items.into_iter().map(|(_, item)| item).collect();
    in_progress(&items)
}

/// How much of a transcript the first look reads, from its end.
const FIRST_READ: u64 = 2 << 20;
/// How many transcripts' tails are kept.
const TAILS: usize = 256;

struct Tail {
    offset: u64,
    /// The latest to-do list's item in progress; `None` before any list.
    task: Option<Option<String>>,
}

static TAIL: LazyLock<Mutex<HashMap<PathBuf, Tail>>> = LazyLock::new(Default::default);

/// The latest to-do list written in the JSONL transcript at `path`: only
/// what was appended since the last look is read. `None` when the
/// transcript writes none, `Some(None)` when its list has nothing in
/// progress.
pub fn transcript_task(path: &Path) -> Option<Option<String>> {
    use std::io::{Read, Seek, SeekFrom};
    let length = std::fs::metadata(path).ok()?.len();
    let mut tails = TAIL.lock().unwrap_or_else(|e| e.into_inner());
    if tails.len() >= TAILS && !tails.contains_key(path) {
        tails.clear();
    }
    let tail = tails.entry(path.to_path_buf()).or_insert(Tail {
        offset: 0,
        task: None,
    });
    if tail.offset == length {
        return tail.task.clone();
    }
    // A shorter file is a new one: read it again.
    if length < tail.offset {
        *tail = Tail {
            offset: 0,
            task: None,
        };
    }
    let first = tail.offset == 0;
    let start = if first {
        length.saturating_sub(FIRST_READ)
    } else {
        tail.offset
    };
    let mut bytes = Vec::new();
    let read = std::fs::File::open(path).and_then(|mut file| {
        file.seek(SeekFrom::Start(start))?;
        file.take(length - start).read_to_end(&mut bytes)
    });
    if read.is_err() {
        return tail.task.clone();
    }
    // Up to the last complete line; a line still being written is read next
    // time. A first look from the middle skips its partial first line.
    let end = bytes
        .iter()
        .rposition(|b| *b == b'\n')
        .map_or(0, |at| at + 1);
    let skip = if first && start > 0 {
        bytes
            .iter()
            .position(|b| *b == b'\n')
            .map_or(end, |at| at + 1)
    } else {
        0
    };
    for line in bytes[skip.min(end)..end].split(|b| *b == b'\n') {
        // Most lines are model output: parse only those that can write a list.
        if !contains(line, b"\"TodoWrite\"") && !contains(line, b"\"update_plan\"") {
            continue;
        }
        if let Some(task) = serde_json::from_slice::<Value>(line)
            .ok()
            .and_then(|value| todo_written(&value))
        {
            tail.task = Some(task);
        }
    }
    tail.offset = start + end as u64;
    tail.task.clone()
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

// MARK: Git

/// How long a directory's repository and branch are kept.
const GIT_FOR: Duration = Duration::from_secs(30);

type Place = Option<(String, Option<String>)>;
static GIT: LazyLock<Mutex<HashMap<PathBuf, (Instant, Place)>>> = LazyLock::new(Default::default);

/// The repository and branch `directory` is in, read from its files and
/// cached for `GIT_FOR`.
pub fn repo_and_branch(directory: &Path) -> Place {
    let now = Instant::now();
    {
        let cache = GIT.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, place)) = cache.get(directory) {
            if now.duration_since(*at) < GIT_FOR {
                return place.clone();
            }
        }
    }
    let place = read_repo_and_branch(directory);
    let mut cache = GIT.lock().unwrap_or_else(|e| e.into_inner());
    if cache.len() >= TAILS {
        cache.retain(|_, (at, _)| now.duration_since(*at) < GIT_FOR);
    }
    cache.insert(directory.to_path_buf(), (now, place.clone()));
    place
}

fn read_repo_and_branch(directory: &Path) -> Place {
    let (top, git_dir) = directory.ancestors().find_map(|folder| {
        let dot_git = folder.join(".git");
        if dot_git.is_dir() {
            return Some((folder.to_path_buf(), dot_git));
        }
        // A worktree or submodule: `.git` is a file naming the real one.
        let pointer = std::fs::read_to_string(&dot_git).ok()?;
        let named = pointer.trim().strip_prefix("gitdir:")?.trim();
        Some((folder.to_path_buf(), folder.join(named)))
    })?;
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let head = head.trim();
    let branch = match head.strip_prefix("ref:") {
        Some(reference) => {
            let reference = reference.trim();
            Some(
                reference
                    .strip_prefix("refs/heads/")
                    .unwrap_or(reference)
                    .to_string(),
            )
        }
        None => head
            .get(..7)
            .filter(|sha| sha.chars().all(|c| c.is_ascii_hexdigit()))
            .map(str::to_string),
    };
    // A worktree's config and remotes are in the repository it belongs to.
    let common = std::fs::read_to_string(git_dir.join("commondir"))
        .ok()
        .map(|common| git_dir.join(common.trim()))
        .unwrap_or_else(|| git_dir.clone());
    let common = std::fs::canonicalize(&common).unwrap_or(common);
    let repo = std::fs::read_to_string(common.join("config"))
        .ok()
        .and_then(|config| origin_name(&config))
        .or_else(|| {
            // The main checkout's folder, also for a linked worktree.
            let checkout = if common.file_name().is_some_and(|n| n == ".git") {
                common.parent().map(Path::to_path_buf)
            } else {
                None
            }
            .unwrap_or(top);
            checkout
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
        })?;
    Some((repo, branch))
}

/// The repository name the `origin` remote's URL ends with.
pub fn origin_name(config: &str) -> Option<String> {
    let mut in_origin = false;
    for line in config.lines().map(str::trim) {
        if line.starts_with('[') {
            in_origin = line.replace(' ', "") == "[remote\"origin\"]";
            continue;
        }
        if !in_origin {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() != "url" {
            continue;
        }
        let url = value.trim().trim_end_matches('/');
        let url = url.strip_suffix(".git").unwrap_or(url);
        let name = url.rsplit(['/', ':', '\\']).next()?;
        return (!name.is_empty()).then(|| name.to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_doing_line_joins_title_and_task_and_stays_short() {
        assert_eq!(
            doing_line("Fix the roster", Some("Running tests")).as_deref(),
            Some("Fix the roster · Running tests")
        );
        assert_eq!(doing_line("Same", Some("same")).as_deref(), Some("Same"));
        assert_eq!(
            doing_line("  ", Some("Only task")).as_deref(),
            Some("Only task")
        );
        assert_eq!(doing_line("", None), None);
        let long = doing_line(&"word ".repeat(60), None).unwrap();
        assert_eq!(long.chars().count(), DOING_CHARACTERS);
        assert!(long.ends_with('…'));
    }

    #[test]
    fn invite_links_and_keys_are_left_out() {
        assert_eq!(
            doing_line(
                "Join https://agentrelay.com/connect/abc123 now",
                Some("open agentrelay://connect?code=1 then use rk_live_secret"),
            )
            .as_deref(),
            Some("Join now · open then use")
        );
        assert_eq!(
            without_invites("Set RELAY_API_KEY=rk_live_secret and api_token:abc then run"),
            "Set and then run"
        );
        assert_eq!(
            without_invites("Fix key handling: done"),
            "Fix key handling: done"
        );
        // Other links stay.
        assert_eq!(
            without_invites("Review https://github.com/a/b/pull/3"),
            "Review https://github.com/a/b/pull/3"
        );
        assert_eq!(without_invites("see (https://x.dev/join/abc)"), "see");
    }

    #[test]
    fn todo_lists_are_read_from_claude_and_codex_lines() {
        let claude = json!({"type":"assistant","message":{"content":[{"type":"tool_use","name":"TodoWrite","input":{"todos":[
            {"content":"Write tests","status":"completed","activeForm":"Writing tests"},
            {"content":"Run tests","status":"in_progress","activeForm":"Running tests"}]}}]}});
        assert_eq!(todo_written(&claude), Some(Some("Running tests".into())));
        let codex = json!({"type":"response_item","payload":{"type":"function_call","name":"update_plan",
            "arguments":"{\"plan\":[{\"step\":\"Map issues\",\"status\":\"completed\"},{\"step\":\"Spawn subagents\",\"status\":\"in_progress\"}]}"}});
        assert_eq!(todo_written(&codex), Some(Some("Spawn subagents".into())));
        let done = json!({"payload":{"type":"function_call","name":"update_plan","arguments":"{\"plan\":[{\"step\":\"a\",\"status\":\"completed\"}]}"}});
        assert_eq!(todo_written(&done), Some(None));
        assert_eq!(todo_written(&json!({"type":"user"})), None);
        // Clearing the list clears its task.
        let cleared = json!({"type":"assistant","message":{"content":[{"type":"tool_use","name":"TodoWrite","input":{"todos":[]}}]}});
        assert_eq!(todo_written(&cleared), Some(None));
    }

    #[test]
    fn a_transcript_is_read_incrementally_from_its_tail() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let plan = |step: &str| {
            format!(
                "{}\n",
                json!({"type":"response_item","payload":{"type":"function_call","name":"update_plan",
                    "arguments": json!({"plan":[{"step":step,"status":"in_progress"}]}).to_string()}})
            )
        };
        std::fs::write(&path, format!("{{\"type\":\"x\"}}\n{}", plan("First"))).unwrap();
        assert_eq!(transcript_task(&path), Some(Some("First".into())));
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        // A line still being written is read once it is complete.
        let second = plan("Second");
        file.write_all(&second.as_bytes()[..10]).unwrap();
        assert_eq!(transcript_task(&path), Some(Some("First".into())));
        file.write_all(&second.as_bytes()[10..]).unwrap();
        assert_eq!(transcript_task(&path), Some(Some("Second".into())));
        // A replaced, shorter file is read again.
        std::fs::write(&path, "{}\n").unwrap();
        assert_eq!(transcript_task(&path), None);
    }

    #[test]
    fn claude_task_lists_name_their_task_in_progress() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("1.json"),
            json!({"id":"1","subject":"Plan","status":"completed"}).to_string(),
        )
        .unwrap();
        std::fs::write(
            dir.path().join("2.json"),
            json!({"id":"2","subject":"Build","activeForm":"Building it","status":"in_progress"})
                .to_string(),
        )
        .unwrap();
        assert_eq!(claude_task(dir.path()), Some(Some("Building it".into())));
        assert_eq!(claude_task(&dir.path().join("missing")), None);
    }

    #[test]
    fn git_names_the_repository_and_branch_of_checkouts_and_worktrees() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("checkout");
        std::fs::create_dir_all(main.join(".git/worktrees/wt")).unwrap();
        std::fs::create_dir_all(main.join("src/deep")).unwrap();
        std::fs::write(main.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(
            main.join(".git/config"),
            "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = git@github.com:acme/relay-desktop.git\n",
        )
        .unwrap();
        assert_eq!(
            read_repo_and_branch(&main.join("src/deep")),
            Some(("relay-desktop".into(), Some("main".into())))
        );
        // A linked worktree on a detached commit.
        let worktree = dir.path().join("wt");
        std::fs::create_dir_all(&worktree).unwrap();
        let git_dir = main.join(".git/worktrees/wt");
        std::fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", git_dir.display()),
        )
        .unwrap();
        std::fs::write(git_dir.join("HEAD"), "8a27c5a4f00d\n").unwrap();
        std::fs::write(git_dir.join("commondir"), "../..\n").unwrap();
        assert_eq!(
            read_repo_and_branch(&worktree),
            Some(("relay-desktop".into(), Some("8a27c5a".into())))
        );
        // No remote: the main checkout's folder.
        std::fs::write(main.join(".git/config"), "[core]\n").unwrap();
        assert_eq!(
            read_repo_and_branch(&worktree),
            Some(("checkout".into(), Some("8a27c5a".into())))
        );
        assert_eq!(read_repo_and_branch(dir.path()), None);
    }

    #[test]
    fn roster_metadata_is_read_back_bounded() {
        let activity = AgentActivity::from_metadata(&json!({
            "turn": "working", "repo": "relay-desktop", "branch": "main",
            "doing": format!("{} https://agentrelay.com/connect/x", "a".repeat(200)), "updated_ms": 5
        }))
        .unwrap();
        assert_eq!(activity.turn, Some(AgentTurn::Working));
        assert_eq!(activity.doing.unwrap().chars().count(), DOING_CHARACTERS);
        assert_eq!(
            AgentActivity::from_metadata(&json!({"turn": "dancing"})),
            None
        );
        assert_eq!(AgentActivity::from_metadata(&Value::Null), None);
    }
}
