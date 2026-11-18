use super::super::leader::{LeaderRuntime, Opened, SessionOpen, SystemLeaders};
use super::*;
use crate::relay::existing_session::Outcome;

const SOURCE: &str = "01a0fd4c-3771-7a20-9f41-6f86d56624f9";
const COPY: &str = "7b2e6f0a-1c4d-4e8f-9a3b-5d6c7e8f9a0b";

/// Under `/tmp`, so a leader socket's path fits, with the folders a fork
/// runs between.
struct World {
    root: tempfile::TempDir,
}

impl World {
    fn new() -> World {
        World {
            root: tempfile::tempdir_in("/tmp").unwrap(),
        }
    }

    fn path(&self) -> &Path {
        self.root.path()
    }

    fn folder(&self, name: &str) -> PathBuf {
        let folder = self.path().join(name);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::canonicalize(folder).unwrap()
    }

    /// What the stand-in `grok` was sent as `name`, if it was.
    fn sent(&self, name: &str) -> Option<Value> {
        let line = std::fs::read_to_string(self.path().join(format!("grok.{name}"))).ok()?;
        Some(serde_json::from_str(&line).unwrap())
    }

    /// Every removal the stand-in `grok` was asked for, in order.
    fn deletes(&self) -> Vec<Value> {
        std::fs::read_to_string(self.path().join("grok.delete"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    /// How the stand-in `grok` answers `method` (`load` or `delete`) from
    /// now on: see `fake_grok`.
    fn mode(&self, method: &str, mode: &str) {
        std::fs::write(self.path().join(format!("grok.mode.{method}")), mode).unwrap();
    }
}

/// How the stand-in `grok` answers `_x.ai/session/fork`.
enum Answer {
    Copied(&'static str),
    Error(i64),
    /// No answer at all.
    Silent,
}

/// Sets how the stand-in `grok` answers the next fork, forgetting what it
/// was sent before. A data file beside it, so one test writes (and runs)
/// one script only.
fn answer(world: &World, answer: Answer) {
    for sent in [
        "arguments",
        "fork",
        "load",
        "prompt",
        "delete",
        "mode.load",
        "mode.delete",
    ] {
        let _ = std::fs::remove_file(world.path().join(format!("grok.{sent}")));
    }
    let line = match answer {
        Answer::Copied(id) => {
            json!({"jsonrpc": "2.0", "id": "@ID@", "result": {"newSessionId": id}})
        }
        // The error's data names the session's files, as Grok's can.
        Answer::Silent => Value::Null,
        Answer::Error(code) => json!({
            "jsonrpc": "2.0",
            "id": "@ID@",
            "error": {
                "code": code,
                "message": "session file /srv/someone/.grok/sessions/x not found",
                "data": "/srv/someone",
            },
        }),
    };
    let line = if line.is_null() {
        String::new()
    } else {
        format!("{line}\n")
    };
    std::fs::write(world.path().join("grok.answer"), line).unwrap();
}

/// A stand-in `grok` that speaks the ACP a fork is opened with: initialize,
/// `_x.ai/session/fork` (answered as `answer` set), `session/load`,
/// `session/new`, one prompt and `_x.ai/session/delete`, each kept beside
/// it as it arrives (`grok.fork`, `grok.load`, `grok.prompt`, and every
/// removal in `grok.delete`). `World::mode` makes the load fail (`error`)
/// or name another session (`other`), and the removal fail (`error`) or
/// never be answered (`silent`).
fn fake_grok(world: &World, first: Answer) -> PathBuf {
    answer(world, first);
    let executable = world.path().join("grok");
    let script = format!(
        r#"#!/bin/sh
id() {{ printf '%s' "$1" | sed -E 's/.*"id":"([^"]+)".*/\1/'; }}
mode() {{ cat "$0.mode.$1" 2>/dev/null || echo ok; }}
printf '%s\n' "$@" > "$0.arguments"
while read -r line; do
  rid=$(id "$line")
  case "$line" in
  *'"method":"initialize"'*)
    printf '{{"jsonrpc":"2.0","id":"%s","result":{{"protocolVersion":1,"_meta":{{"modelState":{{"currentModelId":"grok-4.7"}},"agentVersion":"1.0.46"}}}}}}\n' "$rid" ;;
  *'"method":"_x.ai/session/fork"'*)
    printf '%s\n' "$line" > "$0.fork"
    sed "s/@ID@/$rid/" "$0.answer" ;;
  *'"method":"session/load"'*)
    printf '%s\n' "$line" > "$0.load"
    case "$(mode load)" in
    error) printf '{{"jsonrpc":"2.0","id":"%s","error":{{"code":-32603,"message":"no"}}}}\n' "$rid" ;;
    other) printf '{{"jsonrpc":"2.0","id":"%s","result":{{"sessionId":"{SOURCE}"}}}}\n' "$rid" ;;
    *) printf '{{"jsonrpc":"2.0","id":"%s","result":{{"sessionId":"{COPY}"}}}}\n' "$rid" ;;
    esac ;;
  *'"method":"session/new"'*)
    printf '{{"jsonrpc":"2.0","id":"%s","result":{{"sessionId":"{COPY}"}}}}\n' "$rid" ;;
  *'"method":"session/prompt"'*)
    printf '%s\n' "$line" > "$0.prompt"
    printf '{{"jsonrpc":"2.0","method":"_x.ai/queue/changed","params":{{"sessionId":"{COPY}","runningPromptId":"server-1","runningText":"fix the build"}}}}\n'
    printf '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"{COPY}","update":{{"sessionUpdate":"user_message_chunk","content":{{"type":"text","text":"fix the build"}}}}}}}}\n' ;;
  *'"method":"_x.ai/session/delete"'*)
    printf '%s\n' "$line" >> "$0.delete"
    case "$(mode delete)" in
    error) printf '{{"jsonrpc":"2.0","id":"%s","error":{{"code":-32601,"message":"no"}}}}\n' "$rid" ;;
    silent) ;;
    *) printf '{{"jsonrpc":"2.0","id":"%s","result":{{"success":true}}}}\n' "$rid" ;;
    esac ;;
  esac
done
"#
    );
    write_executable(&executable, &script);
    executable
}

/// Writes `script` to `path` from a child process. A file this process
/// held open for writing would be inherited by any process another test
/// starts meanwhile, and Linux refuses to run a file open for writing.
fn write_executable(path: &Path, script: &str) {
    use std::io::Write;
    let mut writer = std::process::Command::new("sh")
        .args(["-c", "cat > \"$1\" && chmod 700 \"$1\"", "sh"])
        .arg(path)
        .stdin(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    writer
        .stdin
        .take()
        .unwrap()
        .write_all(script.as_bytes())
        .unwrap();
    assert!(writer.wait().unwrap().success());
}

fn open_fork(
    world: &World,
    executable: &Path,
    source: ForkFrom,
    directory: &Path,
) -> Result<(Opened, Outcome), OpenError> {
    open_with(world, executable, Some(source), directory, &|_| true)
}

/// Opens a session as a launch does, its leader accepted when `accept`
/// says so.
fn open_with(
    world: &World,
    executable: &Path,
    fork: Option<ForkFrom>,
    directory: &Path,
    accept: &dyn Fn(&Opened) -> bool,
) -> Result<(Opened, Outcome), OpenError> {
    let socket = world.path().join("leader.sock");
    let open = SessionOpen {
        executable,
        socket: &socket,
        directory,
        text: "fix the build",
        timeout: Duration::from_secs(10),
        fork,
    };
    SystemLeaders.open(&open, accept)
}

/// The removal of the copy, made in `directory`, that Grok is asked for.
fn removal(directory: &Path) -> Value {
    json!({"sessionId": COPY, "cwd": directory})
}

#[test]
fn a_copy_that_does_not_load_is_removed_again() {
    let world = World::new();
    let executable = fake_grok(&world, Answer::Copied(COPY));
    let source_folder = world.folder("source");
    let project = world.folder("project");
    let source = ForkFrom {
        session_id: SOURCE,
        cwd: &source_folder,
    };
    for load in ["error", "other"] {
        answer(&world, Answer::Copied(COPY));
        world.mode("load", load);
        let refused = open_fork(&world, &executable, source, &project);
        assert_eq!(refused, Err(OpenError::Fork(FAILED.into())), "{load}");
        let deletes = world.deletes();
        assert_eq!(deletes.len(), 1, "{load}");
        assert_eq!(deletes[0]["method"], "_x.ai/session/delete");
        // The folder the copy was made and loaded in, not the source's.
        assert_eq!(deletes[0]["params"], removal(&project), "{load}");
        assert!(world.sent("prompt").is_none());
    }
}

#[test]
fn a_copy_whose_leader_is_not_accepted_is_removed_again() {
    let world = World::new();
    let executable = fake_grok(&world, Answer::Copied(COPY));
    let project = world.folder("project");
    let source = ForkFrom {
        session_id: SOURCE,
        cwd: &project,
    };
    let refused = open_with(&world, &executable, Some(source), &project, &|_| false);
    assert_eq!(
        refused,
        Err(OpenError::Failed("its leader could not be verified".into()))
    );
    let deletes = world.deletes();
    assert_eq!(deletes.len(), 1);
    assert_eq!(deletes[0]["params"], removal(&project));
    assert!(world.sent("prompt").is_none());
}

#[test]
fn a_copy_whose_first_task_is_not_taken_is_removed_again() {
    use crate::relay::existing_session::Failure;
    let world = World::new();
    let executable = fake_grok(&world, Answer::Copied(COPY));
    let project = world.folder("project");
    let source = ForkFrom {
        session_id: SOURCE,
        cwd: &project,
    };
    let socket = world.path().join("leader.sock");
    let mut client = LeaderClient::start(&executable, &socket, &project).unwrap();
    for (outcome, removed) in [
        (Outcome::Retry(Failure::TimedOut), true),
        (Outcome::Waiting(Failure::TimedOut), true),
        (Outcome::Refused(Failure::IdentityMismatch), true),
        (Outcome::InDoubt(Failure::TimedOut), false),
        (
            Outcome::Delivered {
                receipt_id: "grok-acp:server-1".into(),
            },
            false,
        ),
    ] {
        answer(&world, Answer::Copied(COPY));
        settle(&mut client, source, COPY, &project, &outcome);
        let expected = if removed {
            vec![json!({
                "jsonrpc": "2.0",
                "method": "_x.ai/session/delete",
                "params": removal(&project),
            })]
        } else {
            vec![]
        };
        let deletes: Vec<Value> = world
            .deletes()
            .into_iter()
            .map(|mut delete| {
                delete.as_object_mut().unwrap().remove("id");
                delete
            })
            .collect();
        assert_eq!(deletes, expected, "{outcome:?}");
    }
}

#[test]
fn the_source_is_never_removed() {
    let world = World::new();
    let executable = fake_grok(&world, Answer::Copied(COPY));
    let project = world.folder("project");
    let source = ForkFrom {
        session_id: SOURCE,
        cwd: &project,
    };
    let socket = world.path().join("leader.sock");
    let mut client = LeaderClient::start(&executable, &socket, &project).unwrap();
    for copied in [SOURCE, "not-a-session", ""] {
        discard(&mut client, source, copied, &project);
        settle(
            &mut client,
            source,
            copied,
            &project,
            &Outcome::Refused(crate::relay::existing_session::Failure::IdentityMismatch),
        );
    }
    assert!(world.deletes().is_empty());
}

#[test]
fn a_removal_that_fails_or_goes_unanswered_leaves_the_error_as_it_was() {
    let world = World::new();
    let executable = fake_grok(&world, Answer::Copied(COPY));
    let project = world.folder("project");
    let source = ForkFrom {
        session_id: SOURCE,
        cwd: &project,
    };
    for delete in ["error", "silent"] {
        answer(&world, Answer::Copied(COPY));
        world.mode("load", "error");
        world.mode("delete", delete);
        let started = Instant::now();
        let refused = open_fork(&world, &executable, source, &project);
        assert_eq!(refused, Err(OpenError::Fork(FAILED.into())), "{delete}");
        assert!(started.elapsed() < DISCARD_TIMEOUT + Duration::from_secs(2));
        assert_eq!(world.deletes().len(), 1, "{delete}");

        answer(&world, Answer::Copied(COPY));
        world.mode("delete", delete);
        let started = Instant::now();
        let refused = open_with(&world, &executable, Some(source), &project, &|_| false);
        assert_eq!(
            refused,
            Err(OpenError::Failed("its leader could not be verified".into())),
            "{delete}"
        );
        assert!(started.elapsed() < DISCARD_TIMEOUT + Duration::from_secs(2));
        assert_eq!(world.deletes().len(), 1, "{delete}");
    }
}

#[test]
fn a_fork_that_grok_did_not_answer_removes_nothing() {
    let world = World::new();
    let executable = fake_grok(&world, Answer::Silent);
    let project = world.folder("project");
    let source = ForkFrom {
        session_id: SOURCE,
        cwd: &project,
    };
    let socket = world.path().join("leader.sock");
    let open = SessionOpen {
        executable: &executable,
        socket: &socket,
        directory: &project,
        text: "fix the build",
        timeout: Duration::from_secs(2),
        fork: Some(source),
    };
    let refused = SystemLeaders.open(&open, &|_| true);
    assert_eq!(refused, Err(OpenError::Fork(FAILED.into())));
    assert!(world.sent("fork").is_some());
    assert!(world.deletes().is_empty());
}

#[test]
fn a_new_session_removes_nothing() {
    let world = World::new();
    let executable = fake_grok(&world, Answer::Copied(COPY));
    let project = world.folder("project");
    let (opened, _) = open_with(&world, &executable, None, &project, &|_| true).unwrap();
    assert_eq!(opened.session_id, COPY);
    assert!(world.sent("fork").is_none());
    assert!(world.deletes().is_empty());
    let refused = open_with(&world, &executable, None, &project, &|_| false);
    assert!(refused.is_err());
    assert!(world.deletes().is_empty());
}

#[test]
fn a_fork_copies_the_session_loads_the_copy_and_gives_it_the_task() {
    let world = World::new();
    let executable = fake_grok(&world, Answer::Copied(COPY));
    let project = world.folder("project");
    let source = ForkFrom {
        session_id: SOURCE,
        cwd: &project,
    };
    let (opened, outcome) = open_fork(&world, &executable, source, &project).unwrap();
    assert_eq!(opened.session_id, COPY);
    assert_eq!(opened.model_id, "grok-4.7");
    assert_eq!(
        outcome,
        Outcome::Delivered {
            receipt_id: "grok-acp:server-1".into()
        }
    );
    let fork = world.sent("fork").unwrap();
    assert_eq!(fork["method"], "_x.ai/session/fork");
    assert_eq!(
        fork["params"],
        json!({
            "sourceSessionId": SOURCE,
            "sourceCwd": project,
            "newCwd": project,
        })
    );
    let load = world.sent("load").unwrap();
    assert_eq!(load["method"], "session/load");
    assert_eq!(
        load["params"],
        json!({
            "sessionId": COPY,
            "cwd": project,
            "mcpServers": [],
            "_meta": {"yoloMode": true},
        })
    );
    // The copy is prompted, never the source.
    let prompt = world.sent("prompt").unwrap();
    assert_eq!(prompt["method"], "session/prompt");
    assert_eq!(prompt["params"]["sessionId"], COPY);
    assert_eq!(prompt["params"]["prompt"][0]["text"], "fix the build");
    assert!(world.deletes().is_empty());
}

#[test]
fn a_grok_without_forking_is_told_to_update_and_a_missing_session_is_not_found() {
    let world = World::new();
    let executable = fake_grok(&world, Answer::Error(METHOD_NOT_FOUND));
    let project = world.folder("project");
    for (code, expected) in [
        (METHOD_NOT_FOUND, TOO_OLD),
        (INTERNAL_ERROR, NOT_FOUND),
        (-32000, FAILED),
    ] {
        answer(&world, Answer::Error(code));
        let source = ForkFrom {
            session_id: SOURCE,
            cwd: &project,
        };
        let refused = open_fork(&world, &executable, source, &project);
        assert_eq!(refused, Err(OpenError::Fork(expected.into())), "{code}");
        // Grok's own words, and the paths in them, go nowhere.
        assert!(!format!("{refused:?}").contains("someone"));
        assert!(world.sent("load").is_none());
        assert!(world.sent("prompt").is_none());
        assert!(world.deletes().is_empty());
    }
}

#[test]
fn a_copy_named_badly_is_not_loaded() {
    let world = World::new();
    let executable = fake_grok(&world, Answer::Copied(COPY));
    let project = world.folder("project");
    for copy in ["not-a-session", SOURCE] {
        answer(&world, Answer::Copied(copy));
        let source = ForkFrom {
            session_id: SOURCE,
            cwd: &project,
        };
        let refused = open_fork(&world, &executable, source, &project);
        assert_eq!(refused, Err(OpenError::Fork(FAILED.into())), "{copy}");
        assert!(world.sent("load").is_none());
        assert!(world.deletes().is_empty());
    }
}

#[test]
fn a_fork_whose_folder_is_gone_asks_grok_nothing() {
    let world = World::new();
    let executable = fake_grok(&world, Answer::Copied(COPY));
    let project = world.folder("project");
    let gone = world.path().join("gone");
    let source = ForkFrom {
        session_id: SOURCE,
        cwd: &gone,
    };
    let refused = open_fork(&world, &executable, source, &project);
    assert_eq!(refused, Err(OpenError::Fork(FOLDER_GONE.into())));
    assert!(world.sent("fork").is_none());
    assert!(world.sent("prompt").is_none());
}

#[test]
fn a_source_that_is_not_a_grok_session_starts_nothing() {
    let world = World::new();
    let executable = fake_grok(&world, Answer::Copied(COPY));
    let project = world.folder("project");
    for session_id in ["../../etc", "ses_abc", ""] {
        let source = ForkFrom {
            session_id,
            cwd: &project,
        };
        let refused = open_fork(&world, &executable, source, &project);
        assert_eq!(refused, Err(OpenError::Fork(FAILED.into())), "{session_id}");
    }
    let relative = ForkFrom {
        session_id: SOURCE,
        cwd: Path::new("project"),
    };
    assert_eq!(
        open_fork(&world, &executable, relative, &project),
        Err(OpenError::Fork(FAILED.into()))
    );
    // Not even its client was started.
    assert!(!world.path().join("grok.arguments").exists());
}

/// Files `summary` where Grok keeps session `id` of folder `cwd`.
fn summary_at(home: &Path, cwd: &str, id: &str, summary: &str) -> PathBuf {
    let session = GrokConfig {
        home: home.to_path_buf(),
    }
    .session_dir(cwd, id);
    std::fs::create_dir_all(&session).unwrap();
    std::fs::write(session.join("summary.json"), summary).unwrap();
    session
}

fn summary(id: &str, cwd: &str) -> String {
    json!({"info": {"id": id, "cwd": cwd, "title": "fix the build"}}).to_string()
}

#[test]
fn a_sessions_folder_is_read_from_groks_summary_of_it() {
    let world = World::new();
    let home = world.path().join(".grok");
    let cwd = "/work/the project";
    summary_at(&home, cwd, SOURCE, &summary(SOURCE, cwd));
    assert_eq!(saved_directory(&home, SOURCE), Some(PathBuf::from(cwd)));
    // Another session, and a home with no sessions, have none.
    assert_eq!(saved_directory(&home, COPY), None);
    assert_eq!(saved_directory(&world.path().join("empty"), SOURCE), None);
}

#[test]
fn a_summary_that_does_not_match_where_it_is_filed_is_passed_over() {
    let world = World::new();
    let home = world.path().join(".grok");
    // Another session's summary.
    summary_at(&home, "/work/a", SOURCE, &summary(COPY, "/work/a"));
    // Naming a folder it is not filed under.
    summary_at(
        &home,
        "/work/b",
        SOURCE,
        &summary(SOURCE, "/work/elsewhere"),
    );
    // Not JSON, or with no folder.
    summary_at(&home, "/work/c", SOURCE, "not json");
    summary_at(
        &home,
        "/work/d",
        SOURCE,
        &json!({"info": {"id": SOURCE}}).to_string(),
    );
    assert_eq!(saved_directory(&home, SOURCE), None);
}

/// Files `summary` under the sessions folder named `folder`, as it is.
fn summary_in(home: &Path, folder: &str, id: &str, summary: &str) {
    let session = home.join("sessions").join(folder).join(id);
    std::fs::create_dir_all(&session).unwrap();
    std::fs::write(session.join("summary.json"), summary).unwrap();
}

#[test]
fn an_older_summary_without_info_is_found_by_the_folder_it_is_filed_under() {
    let world = World::new();
    let home = world.path().join(".grok");
    let cwd = "/work/caf\u{e9} project";
    let old = json!({"generated_title": "x"}).to_string();
    summary_at(&home, cwd, SOURCE, &old);
    assert_eq!(saved_directory(&home, SOURCE), Some(PathBuf::from(cwd)));
}

#[test]
fn an_older_summary_under_a_name_grok_would_not_write_is_passed_over() {
    let world = World::new();
    let home = world.path().join(".grok");
    let old = json!({"generated_title": "x"}).to_string();
    // Lowercase hex, and a character Grok always encodes.
    summary_in(&home, "%2fwork%2fproject", SOURCE, &old);
    summary_in(&home, "%2Fwork%2Fa b", SOURCE, &old);
    // A relative folder, and names that do not decode.
    summary_in(&home, "work%2Fproject", SOURCE, &old);
    summary_in(&home, "%2Fwork%2", SOURCE, &old);
    summary_in(&home, "%2Fwork%FF", SOURCE, &old);
    assert_eq!(saved_directory(&home, SOURCE), None);
}

#[test]
fn a_summary_whose_info_does_not_match_is_not_read_by_its_folder_name() {
    let world = World::new();
    let home = world.path().join(".grok");
    let cwd = "/work/project";
    // The folder name decodes to `cwd`, but the summary says otherwise.
    summary_at(&home, cwd, SOURCE, &summary(SOURCE, "/work/elsewhere"));
    assert_eq!(saved_directory(&home, SOURCE), None);
    std::fs::remove_dir_all(home.join("sessions")).unwrap();
    summary_at(&home, cwd, SOURCE, &summary(COPY, cwd));
    assert_eq!(saved_directory(&home, SOURCE), None);
    std::fs::remove_dir_all(home.join("sessions")).unwrap();
    for info in [json!(null), json!("x"), json!({"id": SOURCE})] {
        summary_at(&home, cwd, SOURCE, &json!({"info": info}).to_string());
        assert_eq!(saved_directory(&home, SOURCE), None, "{info}");
    }
    // Nor is a summary that is not an object.
    summary_at(&home, cwd, SOURCE, "[]");
    assert_eq!(saved_directory(&home, SOURCE), None);
}

#[test]
fn nothing_outside_the_grok_home_is_read() {
    let world = World::new();
    let home = world.path().join(".grok");
    let outside = world.path().join("outside");
    let cwd = "/work/project";
    // A session id that climbs out of the sessions folder.
    summary_at(&outside, cwd, SOURCE, &summary(SOURCE, cwd));
    std::fs::create_dir_all(home.join("sessions")).unwrap();
    assert_eq!(saved_directory(&home, "../../outside/sessions"), None);
    assert_eq!(saved_directory(&home, &format!("../{SOURCE}")), None);

    // A session folder that is a link out of the home.
    let encoded = GrokConfig { home: home.clone() }
        .session_dir(cwd, SOURCE)
        .parent()
        .unwrap()
        .to_path_buf();
    let linked = GrokConfig {
        home: outside.clone(),
    }
    .session_dir(cwd, SOURCE)
    .parent()
    .unwrap()
    .to_path_buf();
    std::os::unix::fs::symlink(&linked, &encoded).unwrap();
    assert_eq!(saved_directory(&home, SOURCE), None);
    std::fs::remove_file(&encoded).unwrap();

    // A summary that is a link out of the home.
    let session = GrokConfig { home: home.clone() }.session_dir(cwd, SOURCE);
    std::fs::create_dir_all(&session).unwrap();
    std::os::unix::fs::symlink(
        linked.join(SOURCE).join("summary.json"),
        session.join("summary.json"),
    )
    .unwrap();
    assert_eq!(saved_directory(&home, SOURCE), None);

    // The sessions folder itself as a link.
    let linked_home = world.path().join("linked-home");
    std::fs::create_dir_all(&linked_home).unwrap();
    std::os::unix::fs::symlink(outside.join("sessions"), linked_home.join("sessions")).unwrap();
    assert_eq!(saved_directory(&linked_home, SOURCE), None);
}

#[test]
fn an_oversized_summary_is_not_read() {
    let world = World::new();
    let home = world.path().join(".grok");
    let cwd = "/work/project";
    let padded = json!({
        "info": {"id": SOURCE, "cwd": cwd},
        "padding": "x".repeat(SUMMARY_LIMIT as usize),
    });
    summary_at(&home, cwd, SOURCE, &padded.to_string());
    assert_eq!(saved_directory(&home, SOURCE), None);
}

/// Forks a real Grok session. Needs Grok 1.0.46 or later signed in, and a
/// session of its own with at least one turn, in `RELAY_GROK_FORK_SOURCE`
/// (its id) and `RELAY_GROK_FORK_CWD` (its folder). Run from
/// `crates/relay-node` with:
///
/// ```text
/// RELAY_GROK_FORK_SOURCE=<session id> RELAY_GROK_FORK_CWD=<its folder> \
/// CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER="env -u SSL_CERT_FILE -u SSL_CERT_DIR" \
/// cargo test --lib harness::grok::fork::tests::a_real_grok_forks_a_real_session -- --ignored --nocapture
/// ```
///
/// It starts its own leader and leaves the source as it was; the copy is a
/// new session in the same folder that Grok keeps, answering "fork ok".
#[test]
#[ignore = "needs a signed-in Grok and one of its sessions"]
fn a_real_grok_forks_a_real_session() {
    use super::super::leader::LeaderStart;
    let source = std::env::var("RELAY_GROK_FORK_SOURCE").expect("RELAY_GROK_FORK_SOURCE");
    let cwd = PathBuf::from(std::env::var("RELAY_GROK_FORK_CWD").expect("RELAY_GROK_FORK_CWD"));
    let user_home = PathBuf::from(std::env::var("HOME").expect("HOME"));
    let home = GrokConfig::from_env(&|name| std::env::var(name).ok(), &user_home).home;
    assert_eq!(
        saved_directory(&home, &source).as_deref(),
        Some(cwd.as_path()),
        "Grok's summary of the source names its folder"
    );
    let executable = super::super::find_executable(None, &home).expect("Grok is installed");
    let world = World::new();
    let socket = world.path().join("leader.sock");
    let log = world.path().join("leader.log");
    let environment = std::env::vars().collect();
    let pid = SystemLeaders
        .start(
            &LeaderStart {
                executable: &executable,
                socket: &socket,
                directory: &cwd,
                environment: &environment,
                log: &log,
            },
            None,
        )
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    while !socket.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    let open = SessionOpen {
        executable: &executable,
        socket: &socket,
        directory: &cwd,
        text: "Reply with exactly: fork ok",
        timeout: Duration::from_secs(60),
        fork: Some(ForkFrom {
            session_id: &source,
            cwd: &cwd,
        }),
    };
    let opened = SystemLeaders.open(&open, &|_| true);
    // The leader is this test's own: ended by its pid.
    unsafe { libc::kill(pid, libc::SIGTERM) };
    let (opened, outcome) = opened.unwrap();
    println!("copy {} answered {outcome:?}", opened.session_id);
    assert_ne!(opened.session_id, source);
    assert!(matches!(outcome, Outcome::Delivered { .. }));
}
