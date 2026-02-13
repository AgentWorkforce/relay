//! Stress tests for reconnection logic.
//! Run with: cargo test --test stress_reconnect -- --ignored

use std::time::Duration;

use relay_broker::relaycast_ws::reconnect_delay;

#[test]
#[ignore]
fn backoff_bounds_100_attempts() {
    let min_delay = Duration::from_millis(1000);
    let max_delay = Duration::from_millis(30_250); // 30s + 250ms max jitter

    for attempt in 0..100 {
        let delay = reconnect_delay(attempt);
        assert!(
            delay >= min_delay,
            "attempt {}: delay {:?} below minimum {:?}",
            attempt,
            delay,
            min_delay
        );
        assert!(
            delay <= max_delay,
            "attempt {}: delay {:?} above maximum {:?}",
            attempt,
            delay,
            max_delay
        );
    }

    // Verify that delay increases (at least for first few attempts)
    let d0 = reconnect_delay(0);
    let d5 = reconnect_delay(5);
    // d5 base should be 2^5 = 32s, capped at 30s, so d5 >= d0
    // (with jitter, not strictly monotonic, but base is)
    assert!(
        d5 >= d0,
        "delay should generally increase: d0={:?}, d5={:?}",
        d0,
        d5
    );
}

#[test]
#[ignore]
fn backoff_reaches_cap() {
    // After enough attempts, the base delay should hit the 30s cap
    let delay = reconnect_delay(20);
    // Base = min(30, 1 * 2^20) = 30s, plus up to 250ms jitter
    assert!(delay >= Duration::from_secs(30));
    assert!(delay <= Duration::from_millis(30_250));
}
