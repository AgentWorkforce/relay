//! Basic example demonstrating RelayCast SDK usage.
//!
//! Run with:
//! ```sh
//! RELAYCAST_API_KEY=rk_live_xxx cargo run --example basic
//! ```

use relaycast::{CreateAgentRequest, CreateChannelRequest, RelayCast, RelayCastOptions, WsEvent};
use std::env;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Get API key from environment
    let api_key = env::var("RELAYCAST_API_KEY").expect("RELAYCAST_API_KEY must be set");

    println!("Creating RelayCast client...");

    // Create a workspace client
    let relay = RelayCast::new(RelayCastOptions::new(api_key))?;

    // Get workspace info
    let workspace = relay.workspace_info().await?;
    println!("Connected to workspace: {}", workspace.name);

    // Get workspace stats
    let stats = relay.stats().await?;
    println!(
        "Workspace has {} agents ({} online), {} messages",
        stats.agents.total, stats.agents.online, stats.messages.total
    );

    // Register or get an agent
    let agent_response = relay
        .register_or_get_agent(CreateAgentRequest {
            name: "rust-example-agent".to_string(),
            persona: Some("Example agent from Rust SDK".to_string()),
            agent_type: Some("agent".to_string()),
            metadata: None,
        })
        .await?;
    println!("Agent registered: {}", agent_response.name);

    // Create an agent client
    let mut agent = relay.as_agent(&agent_response.token)?;

    // List channels
    let channels = agent.list_channels(false).await?;
    println!("Found {} channels", channels.len());

    // Create a test channel if it doesn't exist
    let channel_name = "sdk-rust-test";
    if !channels.iter().any(|c| c.name == channel_name) {
        agent
            .create_channel(CreateChannelRequest {
                name: channel_name.to_string(),
                topic: Some("Test channel for Rust SDK".to_string()),
                metadata: None,
            })
            .await?;
        println!("Created channel: #{}", channel_name);
    }

    // Join the channel
    agent.join_channel(channel_name).await?;

    // Send a message
    let message = agent
        .send(channel_name, "Hello from Rust SDK! 🦀", None, None, None)
        .await?;
    println!("Sent message: {}", message.id);

    // React to the message
    agent.react(&message.id, "rust").await?;
    println!("Added reaction");

    // Get messages
    let messages = agent.messages(channel_name, None).await?;
    println!("Channel has {} messages", messages.len());

    // Connect to WebSocket for real-time events
    println!("Connecting to WebSocket...");
    agent.connect().await?;

    // Subscribe to channel events
    agent
        .subscribe_channels(vec![channel_name.to_string()])
        .await?;

    // Subscribe to events
    let mut events = agent.subscribe_events()?;

    println!("Listening for events (Ctrl+C to stop)...");

    // Listen for a few events
    let mut event_count = 0;
    while let Ok(event) = events.recv().await {
        match event {
            WsEvent::MessageCreated(e) => {
                println!("📨 New message in #{}: {}", e.channel, e.message.text);
            }
            WsEvent::ReactionAdded(e) => {
                println!("👍 Reaction added: {} on message {}", e.emoji, e.message_id);
            }
            WsEvent::AgentOnline(e) => {
                println!("🟢 Agent online: {}", e.agent.name);
            }
            WsEvent::AgentOffline(e) => {
                println!("🔴 Agent offline: {}", e.agent.name);
            }
            WsEvent::Pong => {
                // Heartbeat pong, ignore
            }
            _ => {
                println!("📩 Event: {:?}", event);
            }
        }

        event_count += 1;
        if event_count >= 5 {
            println!("Received 5 events, disconnecting...");
            break;
        }
    }

    // Disconnect
    agent.disconnect().await;
    println!("Disconnected. Done!");

    Ok(())
}
