use super::*;
use agent_relay_probe::linux_app::models::LocalSessionRow;

pub(super) fn switching_transcripts(runtime: &tokio::runtime::Runtime) {
    let release = Arc::new(Notify::new());
    let gate = release.clone();
    let case = Case::with(runtime, move |core| {
        let sessions: Vec<_> = ["first", "second"].into_iter().map(|name| {
            let mut session = local_session("claude-terminal", name, name, true,
                json!({"name": name, "address": format!("{name}@desk"), "added_by_session": false,
                    "spawn": {"harness": "claude", "can_take_over": true, "taken_over": false}}));
            session["directory"] = json!("/work/api");
            session
        }).collect();
        core.answer(
            "sessions.list",
            check::<method::SessionsList>(json!({"sessions": sessions})),
        );
        let mut agent = agents()["agents"][0].clone();
        agent["name"] = json!("first");
        agent["target"] = json!({"kind": "claude-terminal", "id": "first"});
        agent["spawn"] = json!({"harness": "claude", "holds_slot": true,
            "node": {"state": "unknown"}, "process": {"state": "running"},
            "work": {"state": "working"}, "unfinished": null});
        core.answer(
            "agents.list",
            check::<method::AgentsList>(json!({"agents": [agent]})),
        );
        core.answer(
            "agents.take_over",
            Answer::with(move |params| {
                let gate = gate.clone();
                async move {
                    if params["interrupt"] != true {
                        gate.notified().await;
                    }
                    Err(RpcError::new(ErrorKind::Busy, "Still working"))
                }
            }),
        );
    });
    case.set_state(workspace_snapshot());
    case.pump(|case| {
        case.app
            .with_state(|state| state.local_sessions.len() == 2 && state.local_agents.len() == 1)
    });
    case.app.go(Page::Sessions);
    let open = |name: &str| {
        let relay = case.app.with_state(|state| {
            state
                .local_sessions
                .iter()
                .find(|s| s.target.id == name)
                .cloned()
        });
        case.app.open_local_session(LocalSessionRow {
            upload: None,
            relay,
        });
    };
    open("first");
    let shell = case.app.shell().unwrap();
    let page = &shell.pages.sessions.transcript;
    page.join.take_over.emit_clicked();
    case.pump(|case| case.called("agents.take_over").len() == 1);
    assert!(page.join.interrupt.is_visible());
    open("second");
    assert!(!page.join.interrupt.is_visible());
    // Even a queued click from the previous transcript remains pinned to first.
    page.join.interrupt.emit_clicked();
    case.pump(|case| case.called("agents.take_over").len() == 2);
    assert_eq!(case.called("agents.take_over")[1]["name"], "first");
    assert_eq!(case.called("agents.take_over")[1]["interrupt"], true);
    release.notify_one();
    case.pump(|_| page.join.take_over.is_sensitive());
    assert!(!labels(&page.sidebar)
        .iter()
        .any(|label| label.contains("Still working")));
    open("first");
    assert!(labels(&page.sidebar)
        .iter()
        .any(|label| label.contains("Still working")));
    open("second");
    let mut leaked = false;
    walk(page.sidebar.upcast_ref(), &mut |widget| {
        if let Some(label) = widget.downcast_ref::<gtk::Label>() {
            leaked |= label.is_visible() && label.text().contains("Still working");
        }
    });
    assert!(
        !leaked,
        "opening another transcript hides the previous session's error"
    );
    open("first");
    assert!(labels(&page.sidebar)
        .iter()
        .any(|label| label.contains("Still working")));
}
