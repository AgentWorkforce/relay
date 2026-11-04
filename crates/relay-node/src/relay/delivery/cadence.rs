//! When an agent's queue read and REST heartbeat come due.

use super::DeliveryTiming;
use crate::relay::push::PushState;
use std::collections::HashMap;
use std::time::{Duration, Instant};

impl super::DeliveryState {
    pub(super) fn presence_confirmed(&mut self, name: &str, sent_at: Instant) {
        self.last_heartbeat
            .entry(name.into())
            .and_modify(|last| *last = (*last).max(sent_at))
            .or_insert(sent_at);
    }

    pub(super) fn queue_read_succeeded(
        &mut self,
        name: &str,
        pending: bool,
        started: Instant,
        finished: Instant,
    ) {
        self.last_queue_poll.insert(name.into(), finished);
        // Presence middleware runs before the queue handler. A slow response
        // must neither pretend presence was refreshed at completion nor
        // overwrite a newer heartbeat sent while that read was in flight.
        self.presence_confirmed(name, started);
        let empty_reads = self.empty_queue_reads.entry(name.into()).or_default();
        *empty_reads = if pending {
            0
        } else {
            empty_reads.saturating_add(1)
        };
    }
}

impl super::Core {
    /// A presence request can start after the pass did. A fixed pass interval
    /// can then wake just before presence is due and skip a whole heartbeat.
    pub(super) fn poll_deadline(&self, started: Instant, now: Instant) -> Instant {
        let regular = started + self.poll_interval();
        let status = self.status();
        let registrations = self.store.read(|store| {
            let current = store.current_names();
            store
                .credentials()
                .into_iter()
                .map(|(registration, _)| registration)
                .filter(|registration| current.contains(&registration.name))
                .collect::<Vec<_>>()
        });
        let Ok(state) = self.delivery.lock() else {
            return regular.max(now);
        };
        registrations
            .iter()
            .filter_map(|registration| {
                let last = state.last_heartbeat.get(&registration.name)?;
                Some(
                    *last
                        + heartbeat_interval(
                            &registration.base_url,
                            status.push.get(&registration.name),
                            self.config.delivery_timing,
                        ),
                )
            })
            // Catch a deadline crossed during this pass once. If that write
            // remains blocked next pass, its old deadline keeps normal cadence.
            .filter(|deadline| *deadline > started)
            .fold(regular, Instant::min)
            .max(now)
    }
}

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
    fn a_later_presence_claim_keeps_its_own_deadline_without_spinning_when_overdue() {
        use crate::relay::daemon::{Config, Core};
        use crate::relay::paths::CorePaths;
        use crate::relay::push::PushTiming;
        use crate::relay::store::Registration;
        use crate::relay::workspace::Secret;

        let temp = tempfile::tempdir().unwrap();
        let heartbeat = Duration::from_millis(300);
        let config = Config {
            paths: CorePaths::for_socket(temp.path().join("core.sock")).unwrap(),
            home: temp.path().into(),
            app_data_dir: temp.path().join("app-data"),
            env: Default::default(),
            version: "0.0.0-test".into(),
            host_name: "Test Desk.local".into(),
            rediscover_every: Duration::from_secs(3600),
            push_timing: PushTiming::default(),
            delivery_timing: DeliveryTiming {
                heartbeat,
                safety_poll: Duration::from_secs(3),
                fast_poll: Duration::from_millis(30),
                ..DeliveryTiming::default()
            },
        };
        let (core, _) = Core::new(config);
        let registration: Registration = serde_json::from_value(serde_json::json!({
            "name":"quiet", "agentID":"quiet-id", "target":{"kind":"codex","id":"session"},
            "baseURL":"http://relay.example.test", "registeredAt":1790683200.0
        }))
        .unwrap();
        core.store
            .update(|store| {
                store.registrations.push(registration);
                store
                    .tokens
                    .insert("quiet".into(), Secret::new("fake-token"));
            })
            .unwrap();
        core.hub.update(|status| {
            status.push.insert("quiet".into(), PushState::Live);
        });
        let first_pass = Instant::now();
        let claim = first_pass + Duration::from_millis(5);
        core.delivery
            .lock()
            .unwrap()
            .presence_confirmed("quiet", claim);
        let early_pass = first_pass + heartbeat;
        let now = early_pass + Duration::from_millis(2);
        assert_eq!(
            core.poll_deadline(early_pass, now),
            claim + heartbeat,
            "A heartbeat 5 ms after pass start must wake at 305 ms, not wait until 600 ms"
        );
        let finished = early_pass + Duration::from_millis(6);
        assert_eq!(
            core.poll_deadline(early_pass, finished),
            finished,
            "A deadline crossed during this pass needs one immediate catch-up"
        );
        assert_eq!(
            core.poll_deadline(finished, finished),
            finished + heartbeat,
            "If that catch-up cannot write, the unchanged old deadline must not spin"
        );
        core.delivery
            .lock()
            .unwrap()
            .presence_confirmed("quiet", claim + heartbeat);
        let next_pass = claim + heartbeat;
        assert_eq!(
            core.poll_deadline(next_pass, next_pass),
            next_pass + heartbeat
        );
        // A denied write leaves its previous claim overdue; scheduling must
        // not claim a pacing lease or spin on that already-passed deadline.
        let overdue_pass = next_pass + heartbeat + Duration::from_millis(1);
        assert_eq!(
            core.poll_deadline(overdue_pass, overdue_pass),
            overdue_pass + heartbeat
        );
    }

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
