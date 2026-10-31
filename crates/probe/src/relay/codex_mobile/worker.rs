use super::*;
use crate::relay::client;
use crate::relay::links::Endpoint;
use provider::Control;
use std::collections::HashSet;

pub(super) async fn run(
    core: Arc<Core>,
    authority: Authority,
    mut commands: mpsc::Receiver<Command>,
) {
    let Some(mut control) = connect(&core, &authority).await else {
        return;
    };
    let scope = control.scope().clone();
    if scope.thread != authority.registration.target.id
        || scope.message != authority.message
        || scope.home.is_empty()
        || scope.window.is_empty()
        || scope.generation.is_empty()
        || scope.turn.is_empty()
    {
        return;
    }
    let mut forwarded = HashSet::new();
    let mut retries = std::collections::HashMap::<String, (Instant, u64)>::new();
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(1800) && authority.current(&core) {
        let polled = tokio::task::spawn_blocking(move || {
            let result = control.poll();
            (control, result)
        })
        .await;
        let Ok((returned, result)) = polled else {
            return;
        };
        control = returned;
        let Ok(requests) = result else {
            break;
        };
        let verified = core
            .delivery
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .codex_mobile
            .sessions
            .get(&authority.registration.agent_id)
            .and_then(|session| session.verified);
        if verified.is_none_or(|at| at.elapsed() >= Duration::from_secs(5)) {
            match authority.check_owner(&core).await {
                OwnerProof::Current(_) => {}
                OwnerProof::Revoked => {
                    break;
                }
                OwnerProof::Unavailable => {
                    set_ready(&core, &authority, false);
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
            }
        }
        let notices = publish(&core, &authority, &scope, requests).await;
        let current: HashSet<_> = notices
            .iter()
            .map(|(reference, _)| reference.clone())
            .collect();
        forwarded.retain(|reference| current.contains(reference));
        retries.retain(|reference, _| current.contains(reference));
        for (reference, ticket) in notices {
            let retry = retries
                .entry(reference.clone())
                .or_insert((Instant::now(), 5));
            if !forwarded.contains(&reference) && Instant::now() >= retry.0 {
                retry.0 = Instant::now() + Duration::from_secs(retry.1);
                retry.1 = (retry.1 * 2).min(30);
                if forward(&core, &reference, &ticket).await {
                    forwarded.insert(reference);
                }
            }
        }
        while let Ok(command) = commands.try_recv() {
            let Some((returned, outcome)) = decide(
                &core,
                &authority,
                control,
                &command.reference,
                command.decision,
            )
            .await
            else {
                let _ = command.reply.send(DecisionOutcome::InDoubt);
                return;
            };
            control = returned;
            let _ = command.reply.send(outcome);
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let _ = tokio::task::spawn_blocking(move || control.close()).await;
}

async fn connect(core: &Arc<Core>, authority: &Authority) -> Option<Box<dyn Control>> {
    let started = Instant::now();
    for _ in 0..60 {
        if started.elapsed() > Duration::from_secs(300) {
            return None;
        }
        match authority.check_owner(core).await {
            OwnerProof::Current(_) => {}
            OwnerProof::Revoked => return None,
            OwnerProof::Unavailable => {
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        }
        let injector = core.plugins.injector.clone();
        let registration = authority.registration.clone();
        let message = authority.message.clone();
        let control = tokio::task::spawn_blocking(move || {
            injector.codex_mobile_control(&registration, &message)
        })
        .await
        .ok()
        .flatten();
        if control.is_some() {
            return control;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    None
}

fn ledger_root(core: &Core) -> std::path::PathBuf {
    core.config.app_data_dir.join("codex-mobile-consumed")
}
pub(super) fn request_key(scope: &provider::Scope, request: &ApprovalRequest) -> String {
    // Ownership/window/connection changes cannot resurrect the same physical
    // provider request. Those proofs belong to the live ticket, not this key.
    let id = serde_json::to_vec(request.id()).unwrap_or_default();
    let kind = match request.kind() {
        crate::relay::codex::follower::ApprovalKind::Command => "command",
        crate::relay::codex::follower::ApprovalKind::File => "file",
    };
    ledger::digest(&[
        scope.home.as_bytes(),
        scope.thread.as_bytes(),
        scope.turn.as_bytes(),
        request.item().as_bytes(),
        kind.as_bytes(),
        &id,
    ])
}
async fn publish(
    core: &Core,
    authority: &Authority,
    scope: &provider::Scope,
    requests: Vec<ApprovalRequest>,
) -> Vec<(String, Ticket)> {
    let root = ledger_root(core);
    let captured_scope = scope.clone();
    let candidates = tokio::task::spawn_blocking(move || {
        requests
            .into_iter()
            .filter(|r| {
                r.turn() == captured_scope.turn
                    && (r.allows(Decision::Accept) || r.allows(Decision::Decline))
            })
            .take(MAX_REQUESTS)
            .filter_map(|request| {
                let description = description::safe(&request)?;
                let key = request_key(&captured_scope, &request);
                (!ledger::consumed(&root, &key)).then_some((request, key, description))
            })
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default();
    if !authority.current(core) {
        return vec![];
    }
    let notices = {
        let mut state = core
            .delivery
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let manager = &mut state.codex_mobile;
        manager.tickets.retain(|_, ticket| {
            ticket.authority.generation != authority.generation
                || candidates
                    .iter()
                    .any(|(request, _, _)| request == &ticket.request)
        });
        for (request, key, description) in candidates {
            if manager.tickets.values().any(|ticket| {
                ticket.authority.generation == authority.generation && ticket.request == request
            }) {
                continue;
            }
            let reference = new_reference();
            manager.tickets.entry(reference).or_insert_with(|| Ticket {
                authority: authority.clone(),
                scope: scope.clone(),
                request,
                expires: Instant::now() + TTL,
                key,
                description,
            });
        }
        manager
            .tickets
            .iter()
            .filter(|(_, ticket)| {
                ticket.authority.generation == authority.generation
                    && ticket.expires > Instant::now()
            })
            .map(|(reference, ticket)| (reference.clone(), ticket.clone()))
            .collect()
    };
    set_ready(core, authority, true);
    notices
}
async fn forward(core: &Core, reference: &str, ticket: &Ticket) -> bool {
    let Some(owner) = ticket.authority.owner(core).await else {
        set_ready(core, &ticket.authority, false);
        return false;
    };
    if !ticket.authority.current(core) || ticket.expires <= Instant::now() {
        return false;
    }
    let Some((current, token)) = core
        .agent_credential(&ticket.authority.registration.name)
        .filter(|(current, _)| same_registration(current, &ticket.authority.registration))
    else {
        return false;
    };
    let Some(response) = description::reply_options(
        reference,
        ticket.request.allows(Decision::Accept),
        ticket.request.allows(Decision::Decline),
    ) else {
        return false;
    };
    let text=format!("[Codex approval {reference} for @{}]\n{}\n{response} Only the signed-in machine owner may answer.",current.display_name(),ticket.description);
    client::send_dm(
        &current.base_url,
        &current.sender_token(token),
        &Endpoint::Name(owner.into()),
        &text,
        Some(format!("codex-mobile-approval-{reference}")),
    )
    .await
    .is_ok()
}

async fn decide(
    core: &Arc<Core>,
    authority: &Authority,
    mut control: Box<dyn Control>,
    reference: &str,
    decision: Decision,
) -> Option<(Box<dyn Control>, DecisionOutcome)> {
    let ticket = {
        core.delivery
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .codex_mobile
            .tickets
            .get(reference)
            .cloned()
    };
    let Some(ticket) = ticket.filter(|ticket| {
        ticket.authority.generation == authority.generation
            && ticket.scope == *control.scope()
            && ticket.expires > Instant::now()
    }) else {
        return Some((control, DecisionOutcome::Refused));
    };
    if authority.owner(core).await.is_none() {
        return Some((control, DecisionOutcome::Refused));
    }
    let root = ledger_root(core);
    let core = core.clone();
    // The task owns the control and has no other sender. Even a lost result
    // cannot make the consumed request eligible in another process/restart.
    tokio::task::spawn_blocking(move || {
        let outcome = control.decide(&ticket.request, decision, &|| {
            ticket.expires > Instant::now()
                && ticket.authority.verified_current(&core)
                && ledger::consume(&root, &ticket.key)
                && ticket.expires > Instant::now()
                && ticket.authority.verified_current(&core)
        });
        (control, outcome)
    })
    .await
    .ok()
}

fn set_ready(core: &Core, authority: &Authority, ready: bool) {
    let changed = {
        let mut state = core
            .delivery
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state
            .codex_mobile
            .sessions
            .get_mut(&authority.registration.agent_id)
            .filter(|session| {
                session.authority.generation == authority.generation && !session.revoked
            })
            .is_some_and(|session| {
                let ready = ready
                    && session
                        .verified
                        .is_some_and(|seen| seen.elapsed() < Duration::from_secs(5));
                let changed = session.ready.is_some() != ready;
                session.ready = ready.then(Instant::now);
                changed
            })
    };
    if changed {
        core.mobile_handoff_changed(&authority.registration);
    }
}
