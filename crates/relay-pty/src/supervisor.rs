//! Auto-restart supervisor for crashed agents.
//!
//! Tracks restart state per agent and decides whether to restart or mark
//! permanently dead based on configurable policies (max restarts, cooldown,
//! consecutive failure limits). The supervisor is generic over an opaque
//! payload the caller registers alongside each agent (typically everything
//! needed to respawn it — spawn spec, callbacks, prompt options) and hands
//! back unchanged when a restart is due; it never inspects the payload.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Configurable restart policy attached to an agent at spawn time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RestartPolicy {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_max_restarts")]
    pub max_restarts: u32,
    #[serde(default = "default_cooldown_ms")]
    pub cooldown_ms: u64,
    #[serde(default = "default_max_consecutive")]
    pub max_consecutive_failures: u32,
}

fn default_true() -> bool {
    true
}
fn default_max_restarts() -> u32 {
    5
}
fn default_cooldown_ms() -> u64 {
    2000
}
fn default_max_consecutive() -> u32 {
    3
}

impl Default for RestartPolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            max_restarts: 5,
            cooldown_ms: 2000,
            max_consecutive_failures: 3,
        }
    }
}

/// Internal state tracked per agent for restart decisions.
struct RestartState<T> {
    total_restarts: u32,
    consecutive_failures: u32,
    last_exit: Option<Instant>,
    policy: RestartPolicy,
    payload: T,
}

/// Decision returned by the supervisor after an agent exits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestartDecision {
    Restart { delay: Duration },
    PermanentlyDead { reason: String },
}

/// Info about an agent pending restart, exposed for the event loop. Carries
/// the payload registered at spawn time so the caller can respawn without
/// keeping its own copy.
pub struct PendingRestart<T> {
    pub payload: T,
    pub restart_count: u32,
}

/// Manages restart state for all supervised agents.
pub struct Supervisor<T> {
    states: HashMap<String, RestartState<T>>,
}

impl<T> Default for Supervisor<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> Supervisor<T> {
    pub fn new() -> Self {
        Self {
            states: HashMap::new(),
        }
    }

    /// Register an agent for supervision. Called at spawn time.
    pub fn register(&mut self, name: &str, payload: T, policy: RestartPolicy) {
        self.states.insert(
            name.to_string(),
            RestartState {
                total_restarts: 0,
                consecutive_failures: 0,
                last_exit: None,
                policy,
                payload,
            },
        );
    }

    /// Unregister an agent (intentional release — no restart).
    pub fn unregister(&mut self, name: &str) {
        self.states.remove(name);
    }

    /// Called when an agent process exits. Returns a restart decision.
    ///
    /// Returns `None` if the agent is not supervised (was released or never registered).
    pub fn on_exit(
        &mut self,
        name: &str,
        _exit_code: Option<i32>,
        _signal: Option<&str>,
    ) -> Option<RestartDecision> {
        let state = self.states.get_mut(name)?;

        if !state.policy.enabled {
            return Some(RestartDecision::PermanentlyDead {
                reason: "restart policy disabled".to_string(),
            });
        }

        state.consecutive_failures += 1;
        state.last_exit = Some(Instant::now());

        if state.total_restarts >= state.policy.max_restarts {
            return Some(RestartDecision::PermanentlyDead {
                reason: format!("exceeded max restarts ({})", state.policy.max_restarts),
            });
        }

        if state.consecutive_failures > state.policy.max_consecutive_failures {
            return Some(RestartDecision::PermanentlyDead {
                reason: format!(
                    "exceeded max consecutive failures ({})",
                    state.policy.max_consecutive_failures
                ),
            });
        }

        let delay = Duration::from_millis(state.policy.cooldown_ms);
        Some(RestartDecision::Restart { delay })
    }

    /// Called after a successful restart to reset consecutive failure count.
    /// Clears the recorded exit so the agent is no longer considered pending:
    /// it only becomes restartable again after another `on_exit`.
    pub fn on_restarted(&mut self, name: &str) {
        if let Some(state) = self.states.get_mut(name) {
            state.total_restarts += 1;
            state.consecutive_failures = 0;
            state.last_exit = None;
        }
    }

    /// Get the current restart count for an agent.
    pub fn restart_count(&self, name: &str) -> u32 {
        self.states.get(name).map(|s| s.total_restarts).unwrap_or(0)
    }

    /// Check if an agent is registered with the supervisor.
    pub fn is_supervised(&self, name: &str) -> bool {
        self.states.contains_key(name)
    }
}

impl<T: Clone> Supervisor<T> {
    /// Returns agents that have exited and whose cooldown has elapsed.
    pub fn pending_restarts(&self) -> Vec<(String, PendingRestart<T>)> {
        let now = Instant::now();
        self.states
            .iter()
            .filter_map(|(name, state)| {
                let last_exit = state.last_exit?;
                let cooldown = Duration::from_millis(state.policy.cooldown_ms);
                if now.saturating_duration_since(last_exit) >= cooldown
                    && state.total_restarts < state.policy.max_restarts
                    && state.consecutive_failures <= state.policy.max_consecutive_failures
                    && state.policy.enabled
                {
                    Some((
                        name.clone(),
                        PendingRestart {
                            payload: state.payload.clone(),
                            restart_count: state.total_restarts + 1,
                        },
                    ))
                } else {
                    None
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stand-in for whatever respawn context a caller registers.
    #[derive(Debug, Clone, PartialEq, Eq)]
    struct TestPayload {
        name: String,
        task: Option<String>,
    }

    fn test_payload(name: &str) -> TestPayload {
        TestPayload {
            name: name.to_string(),
            task: None,
        }
    }

    #[test]
    fn default_policy_has_sane_values() {
        let p = RestartPolicy::default();
        assert!(p.enabled);
        assert_eq!(p.max_restarts, 5);
        assert_eq!(p.cooldown_ms, 2000);
        assert_eq!(p.max_consecutive_failures, 3);
    }

    #[test]
    fn restart_policy_round_trip() {
        let p = RestartPolicy::default();
        let json = serde_json::to_string(&p).unwrap();
        let p2: RestartPolicy = serde_json::from_str(&json).unwrap();
        assert_eq!(p2.max_restarts, 5);
        assert!(p2.enabled);
    }

    #[test]
    fn restart_policy_defaults_on_empty_json() {
        let p: RestartPolicy = serde_json::from_str("{}").unwrap();
        assert!(p.enabled);
        assert_eq!(p.max_restarts, 5);
    }

    #[test]
    fn register_and_unregister() {
        let mut sup = Supervisor::new();
        sup.register("w1", test_payload("w1"), RestartPolicy::default());
        assert!(sup.is_supervised("w1"));

        sup.unregister("w1");
        assert!(!sup.is_supervised("w1"));
    }

    #[test]
    fn unregistered_agent_returns_none_on_exit() {
        let mut sup = Supervisor::<TestPayload>::new();
        assert!(sup.on_exit("unknown", Some(1), None).is_none());
    }

    #[test]
    fn first_crash_triggers_restart() {
        let mut sup = Supervisor::new();
        sup.register(
            "w1",
            TestPayload {
                name: "w1".to_string(),
                task: Some("do stuff".to_string()),
            },
            RestartPolicy::default(),
        );

        let decision = sup.on_exit("w1", Some(1), None).unwrap();
        match decision {
            RestartDecision::Restart { delay } => {
                assert_eq!(delay, Duration::from_millis(2000));
            }
            other => panic!("expected Restart, got {:?}", other),
        }
    }

    #[test]
    fn exceeding_max_restarts_is_permanent_death() {
        let mut sup = Supervisor::new();
        let policy = RestartPolicy {
            max_restarts: 2,
            max_consecutive_failures: 10, // high so this doesn't trigger
            ..Default::default()
        };
        sup.register("w1", test_payload("w1"), policy);

        // First crash -> restart
        assert!(matches!(
            sup.on_exit("w1", Some(1), None),
            Some(RestartDecision::Restart { .. })
        ));
        sup.on_restarted("w1"); // count = 1

        // Second crash -> restart
        assert!(matches!(
            sup.on_exit("w1", Some(1), None),
            Some(RestartDecision::Restart { .. })
        ));
        sup.on_restarted("w1"); // count = 2

        // Third crash -> permanently dead (hit max_restarts=2)
        let decision = sup.on_exit("w1", Some(1), None).unwrap();
        assert!(matches!(decision, RestartDecision::PermanentlyDead { .. }));
    }

    #[test]
    fn consecutive_failures_trigger_permanent_death() {
        let mut sup = Supervisor::new();
        let policy = RestartPolicy {
            max_consecutive_failures: 2,
            max_restarts: 10, // high so this doesn't trigger
            ..Default::default()
        };
        sup.register("w1", test_payload("w1"), policy);

        // Crash 1 -> consecutive=1, restart
        assert!(matches!(
            sup.on_exit("w1", Some(1), None),
            Some(RestartDecision::Restart { .. })
        ));
        // Don't call on_restarted — simulating rapid back-to-back failures

        // Crash 2 -> consecutive=2, still restartable (<=2)
        assert!(matches!(
            sup.on_exit("w1", Some(1), None),
            Some(RestartDecision::Restart { .. })
        ));

        // Crash 3 -> consecutive=3, exceeds max_consecutive_failures=2
        let decision = sup.on_exit("w1", Some(1), None).unwrap();
        assert!(matches!(decision, RestartDecision::PermanentlyDead { .. }));
    }

    #[test]
    fn restarted_agent_is_not_pending_until_next_exit() {
        let mut sup = Supervisor::new();
        let policy = RestartPolicy {
            cooldown_ms: 0,
            ..Default::default()
        };
        sup.register("w1", test_payload("w1"), policy);

        sup.on_exit("w1", Some(1), None);
        assert_eq!(sup.pending_restarts().len(), 1);

        sup.on_restarted("w1");
        assert!(sup.pending_restarts().is_empty());
    }

    #[test]
    fn on_restarted_resets_consecutive_failures() {
        let mut sup = Supervisor::new();
        let policy = RestartPolicy {
            max_consecutive_failures: 2,
            max_restarts: 10,
            ..Default::default()
        };
        sup.register("w1", test_payload("w1"), policy);

        // Two crashes
        sup.on_exit("w1", Some(1), None);
        sup.on_exit("w1", Some(1), None);

        // Successful restart resets consecutive
        sup.on_restarted("w1");

        // Next crash should restart (not permanent death)
        assert!(matches!(
            sup.on_exit("w1", Some(1), None),
            Some(RestartDecision::Restart { .. })
        ));
    }

    #[test]
    fn disabled_policy_is_permanent_death() {
        let mut sup = Supervisor::new();
        let policy = RestartPolicy {
            enabled: false,
            ..Default::default()
        };
        sup.register("w1", test_payload("w1"), policy);

        let decision = sup.on_exit("w1", Some(1), None).unwrap();
        assert!(matches!(decision, RestartDecision::PermanentlyDead { .. }));
    }

    #[test]
    fn released_agent_not_restarted() {
        let mut sup = Supervisor::new();
        sup.register("w1", test_payload("w1"), RestartPolicy::default());
        sup.unregister("w1");

        // Should return None — not supervised
        assert!(sup.on_exit("w1", Some(0), None).is_none());
    }

    #[test]
    fn pending_restarts_respects_cooldown() {
        let mut sup = Supervisor::new();
        let policy = RestartPolicy {
            cooldown_ms: 0, // instant cooldown for test
            ..Default::default()
        };
        sup.register(
            "w1",
            TestPayload {
                name: "w1".to_string(),
                task: Some("task".to_string()),
            },
            policy,
        );

        sup.on_exit("w1", Some(1), None);

        let pending = sup.pending_restarts();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].0, "w1");
        assert_eq!(pending[0].1.payload.name, "w1");
        assert_eq!(pending[0].1.payload.task.as_deref(), Some("task"));
        assert_eq!(pending[0].1.restart_count, 1);
    }

    #[test]
    fn pending_restarts_not_returned_during_cooldown() {
        let mut sup = Supervisor::new();
        let policy = RestartPolicy {
            cooldown_ms: 60_000, // 60 seconds
            ..Default::default()
        };
        sup.register("w1", test_payload("w1"), policy);

        sup.on_exit("w1", Some(1), None);

        // Still in cooldown — should not be pending
        let pending = sup.pending_restarts();
        assert!(pending.is_empty());
    }

    #[test]
    fn restart_count_tracks_total() {
        let mut sup = Supervisor::new();
        sup.register("w1", test_payload("w1"), RestartPolicy::default());

        assert_eq!(sup.restart_count("w1"), 0);

        sup.on_exit("w1", Some(1), None);
        sup.on_restarted("w1");
        assert_eq!(sup.restart_count("w1"), 1);

        sup.on_exit("w1", Some(1), None);
        sup.on_restarted("w1");
        assert_eq!(sup.restart_count("w1"), 2);
    }

    #[test]
    fn pending_restarts_carry_payload_unchanged() {
        let mut sup = Supervisor::new();
        let policy = RestartPolicy {
            cooldown_ms: 0,
            ..Default::default()
        };
        let payload = TestPayload {
            name: "w1".to_string(),
            task: Some("resume".to_string()),
        };
        sup.register("w1", payload.clone(), policy);

        sup.on_exit("w1", Some(1), None);

        let pending = sup.pending_restarts();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].1.payload, payload);
    }

    #[test]
    fn restart_count_returns_zero_for_unknown() {
        let sup = Supervisor::<TestPayload>::new();
        assert_eq!(sup.restart_count("nope"), 0);
    }
}
