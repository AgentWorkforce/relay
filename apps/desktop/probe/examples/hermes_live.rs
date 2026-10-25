//! Drives the Hermes route against a real local relay profile, the way
//! delivery does: lists it, sends one message as each of two relay senders,
//! resends each delivery, and waits for each answer.
//!
//! ```text
//! cargo run --example hermes_live -- [message]
//! ```

use agent_relay_probe::relay::delivery::policy::MessageRef;
use agent_relay_probe::relay::hermes;
use agent_relay_probe::relay::inject::DeliveryRoute;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn main() {
    let message = std::env::args().nth(1).unwrap_or_else(|| {
        "Reply with one short sentence naming the sender of this message.".into()
    });
    let env: BTreeMap<String, String> = std::env::vars().collect();
    let home = PathBuf::from(env.get("HOME").cloned().unwrap_or_default());
    let data = PathBuf::from(
        env.get("HERMES_LIVE_DATA")
            .cloned()
            .unwrap_or_else(|| "hermes-live-data".into()),
    );
    let config = hermes::HermesConfig::new(&env, &home, &data);
    println!(
        "profile home: {} enabled: {}",
        config.home.display(),
        config.enabled()
    );
    match hermes::api(&config) {
        Ok(api) => println!("api: port {}", api.port),
        Err(reason) => {
            println!("api unavailable: {}", reason.reason());
            std::process::exit(1);
        }
    }
    for row in hermes::discover(&config) {
        println!("listed: {} — {}", row.target.id, row.title);
    }
    let run = std::process::id();
    let senders = [
        ("alice-live", "alice-live@test-node"),
        ("bob-live", "bob-live@test-node"),
    ];
    let mut pending = Vec::new();
    for (name, address) in senders {
        let delivery_id = format!("del_live_{run}_{name}");
        let message_id = format!("msg_live_{run}_{name}");
        let route = DeliveryRoute {
            delivery_id: &delivery_id,
            message_id: &message_id,
            reason: Some("dm"),
            channel_id: None,
            sender: Some(name),
            sender_address: Some(address),
            native: false,
        };
        let text = format!("[via Agent Relay from @{name}] {message}");
        println!("session {}", hermes::session_id("live-test", &route));
        println!(
            "send {name}: {:?}",
            hermes::send(&config, "live-test", &route, &text)
        );
        println!(
            "resend {name}: {:?}",
            hermes::send(&config, "live-test", &route, &text)
        );
        pending.push((name, message_id));
    }
    let deadline = Instant::now() + Duration::from_secs(240);
    while !pending.is_empty() && Instant::now() < deadline {
        pending.retain(|(name, message_id)| {
            match hermes::final_answer(&config, &MessageRef::of(message_id)) {
                Some(answer) => {
                    println!("answer for {name}: {answer}");
                    false
                }
                None => true,
            }
        });
        std::thread::sleep(Duration::from_secs(3));
    }
    for (name, _) in &pending {
        println!("no answer for {name} within 4 minutes");
    }
    std::process::exit(if pending.is_empty() { 0 } else { 2 });
}
