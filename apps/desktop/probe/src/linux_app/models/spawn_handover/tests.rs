//! The Mac's `SpawnHandoverTests` pin the same behavior and wording.

use super::*;
use crate::linux_app::models::{LocalSessionRow, SessionOpenDestination, SessionOpening};
use crate::linux_app::prefs::SessionOpenPreference;
use crate::relay::contract::agents::SessionRegistration;
use crate::relay::contract::spawned::SessionSpawn;
use crate::relay::store::{SessionKind, Target};

const SESSION: &str = "0b6f2d0e-8a51-4a5c-9c3e-5d1f0a2b3c4d";

fn session(kind: SessionKind, spawn: Option<SessionSpawn>) -> LocalSession {
    LocalSession {
        target: Target::new(kind, SESSION),
        title: "Fix CI".into(),
        project: Some("api".into()),
        directory: Some("/work/api".into()),
        live: true,
        running: Some(true),
        holder: None,
        updated_at_ms: None,
        host: None,
        registration: Some(SessionRegistration {
            name: "c1".into(),
            address: "c1@desk-desktop".into(),
            spawn,
            ..SessionRegistration::default()
        }),
        suggested_name: "c1".into(),
    }
}

fn row(session: LocalSession) -> LocalSessionRow {
    LocalSessionRow {
        upload: None,
        relay: Some(session),
    }
}

fn spawn(harness: &str, can_take_over: bool, taken_over: bool) -> Option<SessionSpawn> {
    Some(SessionSpawn {
        harness: harness.into(),
        can_take_over,
        taken_over,
    })
}

#[test]
fn what_is_offered_follows_the_core() {
    let headless = session(SessionKind::ClaudeTerminal, spawn("claude", true, false));
    let taken = session(SessionKind::ClaudeTerminal, spawn("claude", false, true));
    let codex = session(SessionKind::Codex, spawn("codex", false, false));
    let own = session(SessionKind::ClaudeTerminal, None);
    assert_eq!(SpawnHandover::of(Some(&own)), None);
    assert_eq!(
        SpawnHandover::of(Some(&headless)),
        Some(SpawnHandover::TakeOver)
    );
    assert_eq!(
        SpawnHandover::of(Some(&taken)),
        Some(SpawnHandover::TakenOver)
    );
    assert_eq!(
        SpawnHandover::of(Some(&codex)),
        Some(SpawnHandover::OpenLive)
    );
    assert_eq!(
        SpawnHandover::transcript_agent(Some(&headless)).as_deref(),
        Some("c1")
    );
    assert_eq!(SpawnHandover::transcript_agent(Some(&taken)), None);
    assert_eq!(SpawnHandover::transcript_agent(Some(&codex)), None);
    assert!(SpawnHandover::joins(Some(&headless)));
    assert!(SpawnHandover::joins(Some(&codex)));
    assert!(!SpawnHandover::joins(Some(&taken)));
    assert!(!SpawnHandover::joins(None));
}

#[test]
fn a_headless_claude_is_taken_over_never_resumed_beside_it() {
    let headless = session(SessionKind::ClaudeTerminal, spawn("claude", true, false));
    let taken = session(SessionKind::ClaudeTerminal, spawn("claude", false, true));
    assert_eq!(SessionOpening::for_row(&row(headless.clone())), None);
    let resumed = SessionOpening::for_row(&row(taken.clone())).unwrap();
    assert_eq!(
        resumed.command.as_deref(),
        Some(format!("cd -- '/work/api' && claude --resume '{SESSION}'").as_str())
    );
    // A newer read of the session wins over the row's.
    assert!(
        SessionOpening::for_session(&row(headless.clone()), Some(&taken), Some(&taken)).is_some()
    );
    assert!(SessionOpening::for_session(&row(taken), Some(&headless), Some(&headless)).is_none());
}

#[test]
fn a_spawned_codex_thread_opens_only_live_in_codex() {
    let codex = session(SessionKind::Codex, spawn("codex", false, false));
    let action = SessionOpening::for_row(&row(codex)).unwrap();
    assert!(action.live_only);
    assert_eq!(action.command, None);
    assert_eq!(action.title(), "Open in Codex");
    assert_eq!(
        action.deep_link.as_deref(),
        Some(format!("codex://threads/{SESSION}").as_str())
    );
    assert_eq!(
        action.destination(SessionOpenPreference::Terminal, true),
        SessionOpenDestination::Desktop
    );
    let missing = action.destination(SessionOpenPreference::Automatic, false);
    assert_eq!(missing, SessionOpenDestination::Unavailable);
    assert_eq!(action.button_title(missing), "Open in Codex");
    let own = SessionOpening::for_row(&row(session(SessionKind::Codex, None))).unwrap();
    assert!(!own.live_only);
    assert!(own.command.is_some());
    assert_eq!(
        own.button_title(SessionOpenDestination::Unavailable),
        "Set up session opening"
    );
}

#[test]
fn a_hosted_session_without_a_live_app_is_never_resumed_beside_it() {
    let hosted = session(SessionKind::Grok, spawn("grok", false, false));
    assert_eq!(
        SpawnHandover::of(Some(&hosted)),
        Some(SpawnHandover::OpenLive)
    );
    assert!(SpawnHandover::joins(Some(&hosted)));
    assert_eq!(SessionOpening::for_row(&row(hosted.clone())), None);
    assert_eq!(
        SpawnHandover::hosted_note(Some(&hosted), None),
        Some(SPAWN_HOSTED)
    );
    let own = SessionOpening::for_row(&row(session(SessionKind::Grok, None))).unwrap();
    assert_eq!(
        own.command.as_deref(),
        Some(format!("cd -- '/work/api' && grok --resume '{SESSION}'").as_str())
    );
    let thread = session(SessionKind::Codex, spawn("codex", false, false));
    let live = SessionOpening::for_row(&row(thread.clone()));
    assert_eq!(
        SpawnHandover::hosted_note(Some(&thread), live.as_ref()),
        Some(SPAWN_CODEX_HOSTED)
    );
    let headless = session(SessionKind::ClaudeTerminal, spawn("claude", true, false));
    assert_eq!(SpawnHandover::hosted_note(Some(&headless), None), None);
    let taken = session(SessionKind::ClaudeTerminal, spawn("claude", false, true));
    let resumed = SessionOpening::for_row(&row(taken.clone()));
    assert_eq!(
        SpawnHandover::hosted_note(Some(&taken), resumed.as_ref()),
        None
    );
    let plain = session(SessionKind::Grok, None);
    assert_eq!(SpawnHandover::hosted_note(Some(&plain), Some(&own)), None);
}

#[test]
fn following_continues_where_the_page_says_or_rereads_it() {
    let at = |id| LocalTranscriptCursor { ts_ms: 0, id };
    let page = |follow| LocalTranscriptPage {
        entries: Vec::new(),
        next_cursor: None,
        follow_cursor: follow,
    };
    assert_eq!(
        SpawnHandover::follow_cursor(Some(&at(10)), &page(Some(at(42)))),
        Some(at(42))
    );
    assert_eq!(
        SpawnHandover::follow_cursor(Some(&at(10)), &page(None)),
        Some(at(10))
    );
    assert_eq!(SpawnHandover::follow_cursor(None, &page(None)), None);
}

#[test]
fn wording_matches_the_mac() {
    assert_eq!(SPAWN_TAKE_OVER_TITLE, "Take over in Terminal");
    assert_eq!(spawn_confirm_title("c1"), "Take over @c1?");
    assert_eq!(
        spawn_confirm_message("c1"),
        "Agent Relay stops its headless Claude, then opens the session in Terminal. @c1 keeps its name, so messages to it reach the session you open."
    );
    assert_eq!(
        spawn_working_message("c1"),
        "@c1 is in the middle of a turn. Agent Relay can wait for the turn to end, or interrupt it now."
    );
    assert_eq!(spawn_waiting("c1"), "Waiting for @c1 to finish its turn…");
    assert_eq!(spawn_interrupt_title("c1"), "Interrupt @c1 now?");
    assert_eq!(SPAWN_AFTER_TURN, "Take Over After This Turn");
    assert_eq!(SPAWN_INTERRUPT, "Interrupt and Take Over");
    assert_eq!(
        SPAWN_CODEX_HOSTED,
        "Agent Relay’s Codex app server runs this thread. Open it in Codex to watch or steer it live; it is not resumed in Terminal while Agent Relay hosts it."
    );
    assert_eq!(
        SPAWN_HOSTED,
        "Agent Relay runs this session. Follow it and message it here; it is not resumed in Terminal while Agent Relay runs it."
    );
    assert_eq!(
        SPAWN_INTERRUPT_MESSAGE,
        "The turn it is running stops where it is. The session you open has everything up to there."
    );
    assert_eq!(
        spawn_taken_over("c1"),
        "Taken over: this session is yours now. Messages to @c1 reach it while it runs."
    );
    assert_eq!(spawn_composer_placeholder("c1"), "Message @c1");
    assert_eq!(
        spawn_no_folder("abc"),
        "Agent Relay stopped the headless agent, but its folder is unknown. Resume it yourself with claude --resume abc."
    );
}
