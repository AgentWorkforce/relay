//! Auto-restart supervisor for crashed agents.
//!
//! Tracks restart state per agent and decides whether to restart or mark
//! permanently dead based on configurable policies (max restarts, cooldown,
//! consecutive failure limits).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::protocol::AgentSpec;

/// Configurable restart policy attached to an agent at spawn time.
#[derive(Debug, Clone, Serialize, Deserialize)]
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
struct RestartState {
    total_restarts: u32,
    consecutive_failures: u32,
    last_exit: Option<Instant>,
    policy: RestartPolicy,
    pub spec: AgentSpec,
    pub initial_task: Option<String>,
    pub parent: Option<String>,
}

/// Decision returned by the supervisor after an agent exits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestartDecision {
    Restart { delay: Duration },
    PermanentlyDead { reason: String },
}

/// Info about an agent pending restart, exposed for the event loop.
pub struct PendingRestart {
    pub spec: AgentSpec,
    pub parent: Option<String>,
    pub initial_task: Option<String>,
    pub restart_count: u32,
}

/// Manages restart state for all supervised agents.
pub struct Supervisor {
    states: HashMap<String, RestartState>,
}

impl Supervisor {
    pub fn new() -> Self {
        Self {
            states: HashMap::new(),
        }
    }

    /// Register an agent for supervision. Called at spawn time.
    pub fn register(
        &mut self,
        name: &str,
        spec: AgentSpec,
        parent: Option<String>,
        initial_task: Option<String>,
        policy: RestartPolicy,
    ) {
        self.states.insert(
            name.to_string(),
            RestartState {
                total_restarts: 0,
                consecutive_failures: 0,
                last_exit: None,
                policy,
                spec,
                initial_task,
                parent,
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
                reason: format!(
                    "exceeded max restarts ({})",
                    state.policy.max_restarts
                ),
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
    pub fn on_restarted(&mut self, name: &str) {
        if let Some(state) = self.states.get_mut(name) {
            state.total_restarts += 1;
            state.consecutive_failures = 0;
        }
    }

    /// Returns agents that have exited and whose cooldown has elapsed.
    pub fn pending_restarts(&self) -> Vec<(String, PendingRestart)> {
        let now = Instant::now();
        self.states
            .iter()
            .filter_map(|(name, state)| {
                let last_exit = state.last_exit?;
                let cooldown = Duration::from_millis(state.policy.cooldown_ms);
                if now.duration_since(last_exit) >= cooldown
                    && state.total_restarts < state.policy.max_restarts
                    && state.consecutive_failures <= state.policy.max_consecutive_failures
                    && state.policy.enabled
                {
                    Some((
                        name.clone(),
                        PendingRestart {
                            spec: state.spec.clone(),
                            parent: state.parent.clone(),
                            initial_task: state.initial_task.clone(),
                            restart_count: state.total_restarts + 1,
                        },
                    ))
                } else {
                    None
                }
            })
            .collect()
    }

    /// Get the current restart count for an agent.
    pub fn restart_count(&self, name: &str) -> u32 {
        self.states
            .get(name)
            .map(|s| s.total_restarts)
            .unwrap_or(0)
    }

    /// Check if an agent is registered with the supervisor.
    pub fn is_supervised(&self, name: &str) -> bool {
        self.states.contains_key(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::AgentRuntime;

    fn test_spec(name: &str) -> AgentSpec {
        AgentSpec {
            name: name.to_string(),
            runtime: AgentRuntime::Pty,
            cli: Some("claude".to_string()),
            model: None,
            cwd: None,
            team: None,
            shadow_of: None,
            shadow_mode: None,
            args: vec![],
            channels: vec!["general".to_string()],
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
        sup.register(
            "w1",
            test_spec("w1"),
            None,
            None,
            RestartPolicy::default(),
        );
        assert!(sup.is_supervised("w1"));

        sup.unregister("w1");
        assert!(!sup.is_supervised("w1"));
    }

    #[test]
    fn unregistered_agent_returns_none_on_exit() {
        let mut sup = Supervisor::new();
        assert!(sup.on_exit("unknown", Some(1), None).is_none());
    }

    #[test]
    fn first_crash_triggers_restart() {
        let mut sup = Supervisor::new();
        sup.register(
            "w1",
            test_spec("w1"),
            Some("lead".into()),
            Some("do stuff".into()),
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
        sup.register("w1", test_spec("w1"), None, None, policy);

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
        assert!(matches!(
            decision,
            RestartDecision::PermanentlyDead { .. }
        ));
    }

    #[test]
    fn consecutive_failures_trigger_permanent_death() {
        let mut sup = Supervisor::new();
        let policy = RestartPolicy {
            max_consecutive_failures: 2,
            max_restarts: 10, // high so this doesn't trigger
            ..Default::default()
        };
        sup.register("w1", test_spec("w1"), None, None, policy);

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
        assert!(matches!(
            decision,
            RestartDecision::PermanentlyDead { .. }
        ));
    }

    #[test]
    fn on_restarted_resets_consecutive_failures() {
        let mut sup = Supervisor::new();
        let policy = RestartPolicy {
            max_consecutive_failures: 2,
            max_restarts: 10,
            ..Default::default()
        };
        sup.register("w1", test_spec("w1"), None, None, policy);

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
        sup.register("w1", test_spec("w1"), None, None, policy);

        let decision = sup.on_exit("w1", Some(1), None).unwrap();
        assert!(matches!(
            decision,
            RestartDecision::PermanentlyDead { .. }
        ));
    }

    #[test]
    fn released_agent_not_restarted() {
        let mut sup = Supervisor::new();
        sup.register(
            "w1",
            test_spec("w1"),
            None,
            None,
            RestartPolicy::default(),
        );
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
            test_spec("w1"),
            Some("lead".into()),
            Some("task".into()),
            policy,
        );

        sup.on_exit("w1", Some(1), None);

        let pending = sup.pending_restarts();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].0, "w1");
        assert_eq!(pending[0].1.spec.name, "w1");
        assert_eq!(pending[0].1.parent.as_deref(), Some("lead"));
        assert_eq!(pending[0].1.initial_task.as_deref(), Some("task"));
        assert_eq!(pending[0].1.restart_count, 1);
    }

    #[test]
    fn pending_restarts_not_returned_during_cooldown() {
        let mut sup = Supervisor::new();
        let policy = RestartPolicy {
            cooldown_ms: 60_000, // 60 seconds
            ..Default::default()
        };
        sup.register("w1", test_spec("w1"), None, None, policy);

        sup.on_exit("w1", Some(1), None);

        // Still in cooldown — should not be pending
        let pending = sup.pending_restarts();
        assert!(pending.is_empty());
    }

    #[test]
    fn restart_count_tracks_total() {
        let mut sup = Supervisor::new();
        sup.register(
            "w1",
            test_spec("w1"),
            None,
            None,
            RestartPolicy::default(),
        );

        assert_eq!(sup.restart_count("w1"), 0);

        sup.on_exit("w1", Some(1), None);
        sup.on_restarted("w1");
        assert_eq!(sup.restart_count("w1"), 1);

        sup.on_exit("w1", Some(1), None);
        sup.on_restarted("w1");
        assert_eq!(sup.restart_count("w1"), 2);
    }

    #[test]
    fn restart_count_returns_zero_for_unknown() {
        let sup = Supervisor::new();
        assert_eq!(sup.restart_count("nope"), 0);
    }
}
