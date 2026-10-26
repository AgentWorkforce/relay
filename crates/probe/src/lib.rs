//! Native Agent Relay messaging surface.
//!
//! The probe owns Relaycast credentials, exposes a loopback API to local
//! sessions, and provides the public `relay` command. It deliberately does not
//! own terminal emulation, session history, or either desktop application.

mod cli;
mod config;
mod engine;
mod relaycast_client;
mod server;

pub use cli::run;
pub use config::{normalize_origin, Config, ConfigStore};
pub use server::{app, AppState};
