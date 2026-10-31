//! Drives the OpenClaw Gateway route against a real local Gateway, the way
//! delivery does, and checks each step: the handshake and what the Gateway
//! offers, its agents, a send per relay sender, a resend that must not
//! repeat the turn, a sender whose session is still answering, the
//! answers, and a trusted sender's message reaching the main session.
//!
//! ```text
//! cargo run --example openclaw_live -- [agent] [resend]
//! ```
//!
//! `resend`, after restarting the Gateway, sends the last run's first
//! message again: the restarted Gateway has forgotten its idempotency, so
//! only the session's history keeps the turn from repeating.
//!
//! It reads the Gateway from `OPENCLAW_STATE_DIR` / `OPENCLAW_CONFIG_PATH`
//! like OpenClaw's CLI, and keeps its device key under a scratch app-data
//! directory (`OPENCLAW_LIVE_DATA`, default `./openclaw-live-data`), so the
//! installed app's key is never touched. A model that answers a message
//! containing `SLOW` slowly makes the busy check observable.

use agent_relay_probe::relay::delivery::policy::MessageRef;
use agent_relay_probe::relay::inject::{DeliveryRoute, InjectOutcome};
use agent_relay_probe::relay::openclaw;
use serde_json::json;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

struct Sender {
    name: String,
    delivery_id: String,
    message_id: String,
}

impl Sender {
    fn new(run: &str, name: &str, n: u32) -> Sender {
        // A fresh session per run: the busy check must hold for a session
        // the Gateway is still creating.
        Sender {
            name: format!("{name}-{run}"),
            delivery_id: format!("del_live_{run}_{name}_{n}"),
            message_id: format!("msg_live_{run}_{name}_{n}"),
        }
    }

    fn address(&self) -> String {
        format!("{}@test-node", self.name)
    }

    fn route(&self) -> (String, String, String, String) {
        (
            self.delivery_id.clone(),
            self.message_id.clone(),
            self.name.clone(),
            self.address(),
        )
    }

    fn text(&self, agent: &str, body: &str) -> String {
        format!(
            "[via Agent Relay — from @{} ({}) to @{agent} · message {} · ref {}]\n\n{body}",
            self.name,
            self.address(),
            self.message_id,
            MessageRef::of(&self.message_id)
        )
    }
}

fn send(
    config: &openclaw::OpenClawConfig,
    agent: &str,
    sender: &Sender,
    body: &str,
) -> InjectOutcome {
    let (delivery_id, message_id, name, address) = sender.route();
    let route = DeliveryRoute {
        delivery_id: &delivery_id,
        message_id: &message_id,
        reason: Some("dm"),
        channel_id: None,
        sender: Some(&name),
        sender_id: None,
        sender_address: Some(&address),
        native: false,
    };
    openclaw::send(
        config,
        agent,
        "live-test",
        &route,
        &sender.text(agent, body),
    )
}

fn key_of(agent: &str, sender: &Sender) -> String {
    let (delivery_id, message_id, name, address) = sender.route();
    openclaw::session_key(
        agent,
        "live-test",
        &DeliveryRoute {
            delivery_id: &delivery_id,
            message_id: &message_id,
            reason: Some("dm"),
            channel_id: None,
            sender: Some(&name),
            sender_id: None,
            sender_address: Some(&address),
            native: false,
        },
    )
}

fn wait_answer(config: &openclaw::OpenClawConfig, agent: &str, sender: &Sender) -> Option<String> {
    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline {
        if let Some(answer) =
            openclaw::final_answer(config, agent, &MessageRef::of(&sender.message_id))
        {
            return Some(answer);
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    None
}

/// How many user turns in `key` carry `sender`'s message.
fn turns(config: &openclaw::OpenClawConfig, key: &str, sender: &Sender) -> usize {
    let gateway = openclaw::gateway(config).unwrap();
    let mut connection = openclaw::Connection::open(config, &gateway).unwrap();
    let history = connection
        .call("chat.history", json!({ "sessionKey": key, "limit": 1000 }))
        .unwrap_or_default();
    history["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["role"] == "user" && m.to_string().contains(&sender.message_id))
        .count()
}

struct Checks(Vec<(String, bool)>);

impl Checks {
    fn check(&mut self, what: &str, ok: bool, detail: impl std::fmt::Debug) {
        println!("{} {what}: {detail:?}", if ok { "PASS" } else { "FAIL" });
        self.0.push((what.to_string(), ok));
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let agent = args.first().cloned().unwrap_or_else(|| "main".into());
    let env: BTreeMap<String, String> = std::env::vars().collect();
    let home = PathBuf::from(env.get("HOME").cloned().unwrap_or_default());
    let data = PathBuf::from(
        env.get("OPENCLAW_LIVE_DATA")
            .cloned()
            .unwrap_or_else(|| "openclaw-live-data".into()),
    );
    let config = openclaw::OpenClawConfig::new(&env, &home, &data);
    let mut checks = Checks(Vec::new());
    let gateway = match openclaw::gateway(&config) {
        Ok(gateway) => gateway,
        Err(reason) => {
            println!("gateway unavailable: {}", reason.reason());
            std::process::exit(1);
        }
    };
    let opened = openclaw::Connection::open(&config, &gateway);
    checks.check("handshake", opened.is_ok(), opened.as_ref().err());
    let Ok(connection) = opened else {
        std::process::exit(1)
    };
    let features = connection.features.clone();
    drop(connection);
    println!("features: {features:?}");
    println!("settings notice version: {:?}", config.unlimited_version());
    let agents = openclaw::discover(&config);
    checks.check(
        "agents listed",
        agents.iter().any(|row| row.target.id == agent),
        agents.iter().map(|r| &r.title).collect::<Vec<_>>(),
    );
    let last_run = data.join("last-run");
    if args.get(1).map(String::as_str) == Some("resend") {
        let run = std::fs::read_to_string(&last_run).unwrap_or_default();
        let alice = Sender::new(run.trim(), "alice-live", 1);
        let after = send(&config, &agent, &alice, "Please answer in one sentence.");
        checks.check(
            "resend after restart",
            after == InjectOutcome::Delivered,
            &after,
        );
        let count = turns(&config, &key_of(&agent, &alice), &alice);
        checks.check("still one turn", count == 1, count);
        let failed = checks.0.iter().any(|c| !c.1);
        println!(
            "{} resend {}",
            features.version,
            if failed { "FAILED" } else { "OK" }
        );
        std::process::exit(if failed { 2 } else { 0 });
    }
    let run = format!("{}", std::process::id());
    let _ = std::fs::create_dir_all(&data);
    let _ = std::fs::write(&last_run, &run);

    // A sender's message, its resend, its answer, a resend after it.
    let alice = Sender::new(&run, "alice-live", 1);
    let outcome = send(&config, &agent, &alice, "Please answer in one sentence.");
    checks.check("send", outcome == InjectOutcome::Delivered, &outcome);
    let again = send(&config, &agent, &alice, "Please answer in one sentence.");
    checks.check("resend at once", again == InjectOutcome::Delivered, &again);
    let answer = wait_answer(&config, &agent, &alice);
    checks.check("answer", answer.is_some(), &answer);
    let after = send(&config, &agent, &alice, "Please answer in one sentence.");
    checks.check(
        "resend after answer",
        after == InjectOutcome::Delivered,
        &after,
    );
    let key = key_of(&agent, &alice);
    let count = turns(&config, &key, &alice);
    checks.check("one turn only", count == 1, count);

    // A sender whose session is still answering waits.
    let bob = Sender::new(&run, "bob-live", 1);
    let slow = send(&config, &agent, &bob, "SLOW: take your time.");
    checks.check("slow send", slow == InjectOutcome::Delivered, &slow);
    std::thread::sleep(Duration::from_secs(2));
    let bob2 = Sender::new(&run, "bob-live", 2);
    let busy = send(&config, &agent, &bob2, "And a second question.");
    checks.check(
        "busy session waits",
        matches!(busy, InjectOutcome::Waiting(_)),
        &busy,
    );
    let slow_answer = wait_answer(&config, &agent, &bob);
    checks.check("slow answer", slow_answer.is_some(), &slow_answer);
    let second = send(&config, &agent, &bob2, "And a second question.");
    checks.check(
        "second after answer",
        second == InjectOutcome::Delivered,
        &second,
    );
    let second_answer = wait_answer(&config, &agent, &bob2);
    checks.check("second answer", second_answer.is_some(), &second_answer);

    // Where relay senders' sessions are limited, alice's is answer-only.
    let listed = openclaw::Connection::open(&config, &gateway).and_then(|mut c| {
        c.call(
            "sessions.list",
            json!({ "agentId": agent, "search": key, "limit": 5 }),
        )
    });
    let row = listed.ok().and_then(|l| {
        l["sessions"]
            .as_array()
            .and_then(|rows| rows.first().cloned())
    });
    let mode = row
        .as_ref()
        .and_then(|row| row["permissionMode"].as_str().map(str::to_string));
    checks.check(
        "session limits as the Gateway allows",
        if features.session_limits {
            mode.as_deref() == Some("read-only")
        } else {
            mode.is_none()
        },
        (&mode, row.as_ref().map(|r| r["toolOverrides"].clone())),
    );

    // A trusted sender reaches the main session.
    let owner = Sender::new(&run, "owner", 1);
    config.trusted.set(&json!([owner.name])).unwrap();
    let trusted = send(&config, &agent, &owner, "Trusted hello.");
    checks.check(
        "trusted send",
        trusted == InjectOutcome::Delivered,
        &trusted,
    );
    let owner_answer = wait_answer(&config, &agent, &owner);
    checks.check("trusted answer", owner_answer.is_some(), &owner_answer);
    let main = openclaw::main_session_key(&agent);
    let count = turns(&config, &main, &owner);
    checks.check("trusted turn in main session", count == 1, count);
    config.trusted.set(&json!([])).unwrap();

    let failed: Vec<&String> = checks.0.iter().filter(|c| !c.1).map(|c| &c.0).collect();
    println!(
        "{} {}: {} checks, failed {failed:?}",
        features.version,
        if failed.is_empty() { "OK" } else { "FAILED" },
        checks.0.len()
    );
    std::process::exit(if failed.is_empty() { 0 } else { 2 });
}
