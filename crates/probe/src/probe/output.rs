//! The probe's command output: plain text, or one JSON object per answer
//! (`--json`) carrying the bridge version.
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};

static JSON: AtomicBool = AtomicBool::new(false);

pub fn set_json(value: bool) {
    JSON.store(value, Ordering::Relaxed);
}

#[cfg_attr(not(feature = "history"), allow(dead_code))]
pub fn json_mode() -> bool {
    JSON.load(Ordering::Relaxed)
}

pub fn emit(mut value: Value) {
    value["bridge_version"] = json!(1);
    println!("{value}");
}
