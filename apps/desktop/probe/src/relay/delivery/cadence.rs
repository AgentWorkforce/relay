//! When an agent's queue read and REST heartbeat come due.

use super::DeliveryTiming;
use crate::relay::push::PushState;
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// On hosted Relaycast a live push socket keeps the node online, and an
/// agent shows active for five minutes after its last authenticated request.
/// Hosted Relaycast does not acknowledge socket presence, so a REST heartbeat
/// there only renews that five-minute window; every 30 s was 4× the D1
/// writes it needs. Other servers may keep a 60 s presence record that a
/// socket does not renew, so they keep the 30 s cadence until they confirm
/// socket presence.
const LIVE_PUSH_HEARTBEAT_FACTOR: u32 = 4;

/// How long an agent's presence lasts before it needs a REST heartbeat.
pub(super) fn heartbeat_interval(
    base_url: &str,
    state: Option<&PushState>,
    timing: DeliveryTiming,
) -> Duration {
    if state == Some(&PushState::Live) && is_hosted_relaycast(base_url) {
        timing.heartbeat.saturating_mul(LIVE_PUSH_HEARTBEAT_FACTOR)
    } else {
        timing.heartbeat
    }
}

/// Hosted Relaycast, whose five-minute activity window is known.
fn is_hosted_relaycast(base_url: &str) -> bool {
    url::Url::parse(base_url).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("cast.agentrelay.com")
            && url.port().is_none()
    })
}

pub(super) fn queue_poll_interval(
    state: Option<&PushState>,
    timing: DeliveryTiming,
    empty_reads: u32,
) -> Duration {
    if state == Some(&PushState::Live) {
        timing.safety_poll
    } else {
        // Leave headroom below the heartbeat deadline: a successful queue
        // read refreshes presence through Relaycast's presenceRefresh
        // middleware. At production timings this is 3, 6, 12, then 15 s.
        let cap = (timing.heartbeat / 2)
            .min(timing.safety_poll)
            .max(timing.fast_poll);
        timing
            .fast_poll
            .saturating_mul(1 << empty_reads.min(16))
            .min(cap)
    }
}

pub(super) fn claim_due(
    schedule: &mut HashMap<String, Instant>,
    name: &str,
    interval: Duration,
    allowed: bool,
    now: Instant,
) -> bool {
    if !allowed || !is_due(schedule, name, interval, now) {
        return false;
    }
    schedule.insert(name.into(), now);
    true
}

pub(super) fn is_due(
    schedule: &HashMap<String, Instant>,
    name: &str,
    interval: Duration,
    now: Instant,
) -> bool {
    schedule
        .get(name)
        .is_none_or(|at| now.duration_since(*at) >= interval)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_live_push_socket_stretches_the_rest_heartbeat_only_on_hosted_relaycast() {
        let timing = DeliveryTiming::default();
        let hosted = "https://cast.agentrelay.com";
        let live = Some(&PushState::Live);
        assert_eq!(
            heartbeat_interval(hosted, None, timing),
            Duration::from_secs(30)
        );
        assert_eq!(
            heartbeat_interval(hosted, Some(&PushState::Connecting), timing),
            Duration::from_secs(30)
        );
        assert_eq!(
            heartbeat_interval(hosted, live, timing),
            Duration::from_secs(120)
        );
        assert_eq!(
            heartbeat_interval("https://cast.agentrelay.com/", live, timing),
            Duration::from_secs(120)
        );
        // A self-hosted server may keep a 60 s presence record a socket does
        // not renew.
        for other in [
            "https://relay.example.com",
            "http://cast.agentrelay.com",
            "https://cast.agentrelay.com:8443",
            "https://cast.agentrelay.com.example.com",
            "http://127.0.0.1:4000",
        ] {
            assert_eq!(
                heartbeat_interval(other, live, timing),
                Duration::from_secs(30),
                "{other}"
            );
        }
    }
}
