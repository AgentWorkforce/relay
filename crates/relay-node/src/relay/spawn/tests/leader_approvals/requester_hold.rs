//! While the organization holds messages from senders who are not its
//! admins (`claude_delivery_policy`), the agent that spawned a session
//! answers that session's requests only when the delivery policy would
//! deliver its reply: it is one of the organization's admins, by
//! authenticated address or by name. Otherwise the reply takes the ordinary
//! path, where the hold keeps it for the person. Approval DMs name it, and
//! it is sent a copy, only when the organization counts its name among its
//! admins.

use super::*;

fn by_requester(f: &Fixture) -> String {
    format!("the spawning agent @grokbot ({})", f.requester.id)
}

/// The requester's reply, with its authenticated address.
fn from_requester(f: &Fixture, id: &str, text: &str) -> Delivery {
    addressed(dm(id, &f.requester, text), "grokbot@desk")
}

#[tokio::test]
async fn under_a_hold_a_spawning_agent_that_is_not_an_admin_never_answers() {
    let f = fixture().await;
    f.set(None, Some(true), None);
    organization_holds(&f, &["someone-else", "someone@else"]);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3be101";
    let codex = f.spawned("codex", THREAD);
    const SESSION: &str = "a1d0c2e4-0000-4000-8000-00000000e101";
    let claude = f.spawned("claude", SESSION);
    assert!(f.core.approving_requester(&codex).is_some());
    for (index, verb) in ["approve", "deny"].into_iter().enumerate() {
        let notice = codex_request(THREAD, 1101 + index as u64);
        let reply = from_requester(
            &f,
            &format!("codex-{verb}"),
            &format!("{verb} {}", notice.reference),
        );
        assert!(not_one(f.core.owner_reply(&codex, &reply).await), "{verb}");
        assert!(codex_drive::has_pending(THREAD, &notice.reference));
        assert_eq!(codex_drive::recorded_answer(&notice.reference), None);
        assert!(!f
            .core
            .store
            .read(|store| store.injected_delivery_ids.contains(&reply.id)));
        // The ordinary path then holds the message for the person.
        assert_eq!(f.core.claude_delivery.decide(&codex, &reply), Consent::Hold);

        let request = claude_request(SESSION, &format!("rh-{verb}"));
        let reply = from_requester(
            &f,
            &format!("claude-{verb}"),
            &format!("{verb} {}", request.reference),
        );
        assert!(not_one(f.core.owner_reply(&claude, &reply).await), "{verb}");
        assert!(requests::has_pending(SESSION, &request.reference));
        assert!(requests::due(SESSION).is_empty());
        assert!(!f
            .core
            .store
            .read(|store| store.injected_delivery_ids.contains(&reply.id)));
        assert_eq!(
            f.core.claude_delivery.decide(&claude, &reply),
            Consent::Hold
        );
    }
    requests::forget(SESSION);
}

#[tokio::test]
async fn under_a_hold_an_admin_spawning_agent_answers_by_address_or_by_name() {
    let f = fixture().await;
    f.set(None, Some(true), None);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3be102";
    let codex = f.spawned("codex", THREAD);
    const SESSION: &str = "a1d0c2e4-0000-4000-8000-00000000e102";
    let claude = f.spawned("claude", SESSION);
    for (index, admins) in [["grokbot@desk", "other"], ["grokbot", "other"]]
        .iter()
        .enumerate()
    {
        organization_holds(&f, admins);
        let notice = codex_request(THREAD, 1111 + index as u64);
        let reply = from_requester(
            &f,
            &format!("codex-admin-{index}"),
            &format!("approve {}", notice.reference),
        );
        assert_eq!(
            settled(f.core.owner_reply(&codex, &reply).await),
            format!("Codex approval reply from {}: Answered", by_requester(&f)),
            "{admins:?}"
        );
        let answer = codex_drive::recorded_answer(&notice.reference).unwrap();
        assert_eq!(answer["decision"], "accept", "{answer}");

        let request = claude_request(SESSION, &format!("rh-admin-{index}"));
        let reply = from_requester(
            &f,
            &format!("claude-admin-{index}"),
            &format!("deny {}", request.reference),
        );
        assert_eq!(
            settled(f.core.owner_reply(&claude, &reply).await),
            format!("Claude approval reply from {}: Answered", by_requester(&f)),
            "{admins:?}"
        );
    }
    let due = requests::due(SESSION);
    assert_eq!(due.len(), 2);
    assert!(due
        .iter()
        .all(|(_, line)| line.contains(r#""behavior":"deny""#)));
    requests::forget(SESSION);
}

// Only an authenticated address proves who sent a message: without one the
// policy reads the queue first, and the spawning agent answers nothing
// meanwhile, even one the organization names among its admins.
#[tokio::test]
async fn under_a_hold_a_spawning_agents_reply_without_a_sender_address_never_answers() {
    let f = fixture().await;
    f.set(None, Some(true), None);
    organization_holds(&f, &["grokbot"]);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3be103";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 1121);
    let reply = dm(
        "no-address",
        &f.requester,
        &format!("approve {}", notice.reference),
    );
    assert_eq!(
        f.core.claude_delivery.decide(&registration, &reply),
        Consent::ReadQueue
    );
    assert!(not_one(f.core.owner_reply(&registration, &reply).await));
    assert!(codex_drive::has_pending(THREAD, &notice.reference));
    assert_eq!(codex_drive::recorded_answer(&notice.reference), None);
}

// A held reply the person approves is one the policy delivers: on the next
// pass it answers.
#[tokio::test]
async fn a_held_reply_the_person_approves_answers_on_the_next_pass() {
    let f = fixture().await;
    f.set(None, Some(true), None);
    organization_holds(&f, &["someone-else"]);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3be104";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 1131);
    let reply = from_requester(&f, "approved", &format!("approve {}", notice.reference));
    assert!(not_one(f.core.owner_reply(&registration, &reply).await));
    assert_eq!(
        f.core.claude_delivery.decide(&registration, &reply),
        Consent::Hold
    );
    assert!(f.core.claude_delivery.hold(&registration, &reply).unwrap());
    assert_eq!(
        f.core.claude_delivery.approve(&reply.id).unwrap(),
        Some(registration.name.clone())
    );
    assert_eq!(
        f.core.claude_delivery.decide(&registration, &reply),
        Consent::Deliver
    );
    assert_eq!(
        settled(f.core.owner_reply(&registration, &reply).await),
        format!("Codex approval reply from {}: Answered", by_requester(&f))
    );
}

#[tokio::test]
async fn a_hold_that_begins_after_the_notice_wins_and_one_lifted_lets_the_requester_answer() {
    let f = fixture().await;
    f.set(None, Some(true), None);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3be105";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 1141);
    // Noticed with no hold: it named the spawning agent and sent it a copy.
    f.core
        .forward_to_owner(&registration, &f.token(), &notice)
        .await;
    assert_eq!(copies_to(&f, "grokbot").len(), 1, "{:?}", f.approval_dms());
    organization_holds(&f, &["someone-else"]);
    let approve = format!("approve {}", notice.reference);
    let reply = from_requester(&f, "hold-begun", &approve);
    assert!(not_one(f.core.owner_reply(&registration, &reply).await));
    assert!(codex_drive::has_pending(THREAD, &notice.reference));
    assert_eq!(codex_drive::recorded_answer(&notice.reference), None);
    // Lifted: the same reply answers.
    f.core.claude_delivery.set_organization_hold(None);
    let reply = from_requester(&f, "hold-lifted", &approve);
    assert_eq!(
        settled(f.core.owner_reply(&registration, &reply).await),
        format!("Codex approval reply from {}: Answered", by_requester(&f))
    );
}

// Reading whether a Claude's request is open asks whether its process is
// alive, off the async thread: a hold that begins meanwhile wins.
#[tokio::test]
async fn a_hold_that_begins_during_the_open_request_read_makes_no_approver() {
    let f = fixture().await;
    f.set(None, Some(true), None);
    const SESSION: &str = "a1d0c2e4-0000-4000-8000-00000000e106";
    let registration = f.spawned("claude", SESSION);
    let request = claude_request(SESSION, "rh-during");
    let (asked, asking) = std::sync::mpsc::channel();
    let (release, proceed) = std::sync::mpsc::channel();
    *f.spawner.pause_alive.lock().unwrap() = Some((asked, proceed));
    let reply = from_requester(&f, "during", &format!("approve {}", request.reference));
    let answering = {
        let (core, registration, reply) = (f.core.clone(), registration.clone(), reply.clone());
        tokio::spawn(async move { core.owner_reply(&registration, &reply).await })
    };
    tokio::task::spawn_blocking(move || asking.recv_timeout(Duration::from_secs(5)))
        .await
        .unwrap()
        .expect("the process check");
    organization_holds(&f, &["someone-else"]);
    release.send(()).unwrap();
    assert!(not_one(answering.await.unwrap()));
    assert!(requests::has_pending(SESSION, &request.reference));
    assert!(requests::due(SESSION).is_empty());
    assert!(!f
        .core
        .store
        .read(|store| store.injected_delivery_ids.contains(&reply.id)));
    requests::forget(SESSION);
}

/// The closing line of an approval DM only the owner may answer.
const OWNER_ONLY: &str = "Only the signed-in machine owner may answer.";

// Under a hold a spawning agent that is not one of the organization's
// admins by name is not named and is sent no copy; the owner's copy alone
// marks the request forwarded.
#[tokio::test]
async fn under_a_hold_notices_name_and_reach_the_spawning_agent_only_when_it_is_an_admin() {
    let f = fixture().await;
    f.set(None, Some(true), None);
    // An admin by address only is not one by name.
    organization_holds(&f, &["someone-else", "grokbot@desk"]);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3be107";
    let codex = f.spawned("codex", THREAD);
    assert!(f.core.requester_to_notify(&codex).is_none());
    let notice = codex_request(THREAD, 1151);
    f.core.forward_to_owner(&codex, &f.token(), &notice).await;
    let owner = copies_to(&f, "owner");
    assert_eq!(owner.len(), 1, "{:?}", f.approval_dms());
    assert!(owner[0].0.ends_with(OWNER_ONLY), "{}", owner[0].0);
    assert!(!owner[0].0.contains("grokbot"), "{}", owner[0].0);
    assert!(
        copies_to(&f, "grokbot").is_empty(),
        "{:?}",
        f.approval_dms()
    );
    assert!(codex_drive::unforwarded(THREAD).is_empty(), "forwarded");

    const SESSION: &str = "a1d0c2e4-0000-4000-8000-00000000e107";
    let claude = f.spawned("claude", SESSION);
    let request = claude_request(SESSION, "rh-notice");
    f.core.forward_request(&claude, &f.token(), &request).await;
    let owner = copies_to(&f, "owner");
    assert_eq!(owner.len(), 2, "{:?}", f.approval_dms());
    assert!(owner[1].0.ends_with(OWNER_ONLY), "{}", owner[1].0);
    assert!(
        copies_to(&f, "grokbot").is_empty(),
        "{:?}",
        f.approval_dms()
    );
    assert!(requests::unforwarded(SESSION).is_empty(), "forwarded");

    // Named among the admins: named, and sent a copy.
    organization_holds(&f, &["someone-else", "grokbot"]);
    let notice = codex_request(THREAD, 1152);
    f.core.forward_to_owner(&codex, &f.token(), &notice).await;
    let request = claude_request(SESSION, "rh-notice-admin");
    f.core.forward_request(&claude, &f.token(), &request).await;
    let copies = copies_to(&f, "grokbot");
    assert_eq!(copies.len(), 2, "{:?}", f.approval_dms());
    for (text, _) in &copies {
        assert!(
            text.ends_with(
                "The signed-in machine owner or @grokbot, the agent that spawned this session, \
                 may answer; the first answer counts."
            ),
            "{text}"
        );
    }
    assert_eq!(copies_to(&f, "owner")[2..].len(), 2);
    requests::forget(SESSION);
}

// With approvals from workspace leaders on too, a spawning agent that is
// not an admin is left out of the text, which names the owner and the
// admin leaders.
#[tokio::test]
async fn under_a_hold_with_leaders_on_the_text_names_the_owner_and_admin_leaders_only() {
    let f = fixture().await;
    f.set(Some(true), Some(true), None);
    organization_holds(&f, &["lead"]);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3be108";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 1161);
    f.core
        .forward_to_owner(&registration, &f.token(), &notice)
        .await;
    let owner = copies_to(&f, "owner");
    assert_eq!(owner.len(), 1, "{:?}", f.approval_dms());
    assert!(
        owner[0].0.ends_with(
            "The signed-in machine owner or a workspace leader that is one of the \
             organization's admins may answer; the first answer counts."
        ),
        "{}",
        owner[0].0
    );
    assert!(
        copies_to(&f, "grokbot").is_empty(),
        "{:?}",
        f.approval_dms()
    );
}

#[tokio::test]
async fn under_a_hold_the_owners_own_reply_still_answers() {
    let f = fixture().await;
    f.set(None, Some(true), None);
    organization_holds(&f, &["someone-else"]);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3be109";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 1171);
    let reply = dm("owner", &f.owner, &format!("deny {}", notice.reference));
    assert_eq!(
        settled(f.core.owner_reply(&registration, &reply).await),
        "Codex approval reply from the machine owner: Answered"
    );
    const SESSION: &str = "a1d0c2e4-0000-4000-8000-00000000e109";
    let claude = f.spawned("claude", SESSION);
    let request = claude_request(SESSION, "rh-owner");
    let reply = dm(
        "owner-claude",
        &f.owner,
        &format!("approve {}", request.reference),
    );
    assert_eq!(
        settled(f.core.owner_reply(&claude, &reply).await),
        "Claude approval reply from the machine owner: Answered"
    );
    requests::forget(SESSION);
}

// Without a hold nothing changes: the same text, the owner and the spawning
// agent, the same keys; and the spawning agent answers.
#[tokio::test]
async fn without_a_hold_notices_and_answers_are_unchanged_byte_for_byte() {
    let f = fixture().await;
    f.set(None, None, None);
    const THREAD: &str = "01a1235e-70e1-7cb1-8619-e2c8bf3be110";
    let registration = f.spawned("codex", THREAD);
    let notice = codex_request(THREAD, 1181);
    f.core
        .forward_to_owner(&registration, &f.token(), &notice)
        .await;
    let reference = &notice.reference;
    let expected = format!(
        "[Codex approval {reference} for @c1]\n\
         Status: `waiting_for_approval`. Unanswered requests expire as an explicit denial after 15 minutes.\n\
         {}\n\
         Reply `approve {reference}` or `deny {reference}` within 15 minutes. \
         The signed-in machine owner or @grokbot, the agent that spawned this session, \
         may answer; the first answer counts.",
        notice.description
    );
    let key = |id: &str| format!("spawn-approval-{reference}-{}", MessageRef::of(id));
    assert_eq!(
        f.approval_dms(),
        vec![
            ("owner".into(), expected.clone(), key(&f.owner.id)),
            ("grokbot".into(), expected, key(&f.requester.id)),
        ]
    );
    let reply = from_requester(&f, "no-hold", &format!("approve {reference}"));
    assert_eq!(
        settled(f.core.owner_reply(&registration, &reply).await),
        format!("Codex approval reply from {}: Answered", by_requester(&f))
    );

    const SESSION: &str = "a1d0c2e4-0000-4000-8000-00000000e110";
    let claude = f.spawned("claude", SESSION);
    let request = claude_request(SESSION, "rh-no-hold");
    f.core.forward_request(&claude, &f.token(), &request).await;
    let reference = &request.reference;
    let expected = format!(
        "[Claude approval {reference} for @c1]\n{}\n\
         Reply `approve {reference}` or `deny {reference}` within five minutes. \
         The signed-in machine owner or @grokbot, the agent that spawned this session, \
         may answer; the first answer counts.",
        request.description
    );
    let key = |id: &str| format!("spawn-approval-{reference}-{}", MessageRef::of(id));
    assert_eq!(
        f.approval_dms()[2..].to_vec(),
        vec![
            ("owner".into(), expected.clone(), key(&f.owner.id)),
            ("grokbot".into(), expected, key(&f.requester.id)),
        ]
    );
    let reply = from_requester(&f, "no-hold-claude", &format!("approve {reference}"));
    assert_eq!(
        settled(f.core.owner_reply(&claude, &reply).await),
        format!("Claude approval reply from {}: Answered", by_requester(&f))
    );
    requests::forget(SESSION);
}
