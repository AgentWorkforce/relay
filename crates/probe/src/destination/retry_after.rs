//! The receiver's `Retry-After` on a rate limit or an outage, as the
//! absolute retry time `record_failure` takes.

/// The longest wait a `Retry-After` may ask for. A longer one, or a date
/// further out, is held to this: the receiver's own backoff ceiling for a
/// rate limit is an hour, and a typo or a skewed clock must not park
/// uploads for days.
const LONGEST_MS: i64 = 60 * 60 * 1_000;

/// Statuses whose `Retry-After` is the receiver asking for less traffic or
/// time to recover.
pub(super) fn applies(status: u16) -> bool {
    matches!(status, 408 | 425 | 429 | 503)
}

/// The epoch-ms time `header` asks the next attempt to wait for, given the
/// current time `now_ms`: delay-seconds or an HTTP date, capped at
/// [`LONGEST_MS`]. `None` when it is missing, malformed or already past.
pub(super) fn at(header: Option<&str>, now_ms: i64) -> Option<i64> {
    let value = header?.trim();
    let wait_ms = if let Ok(seconds) = value.parse::<u64>() {
        i64::try_from(seconds).ok()?.saturating_mul(1_000)
    } else {
        let date = chrono::DateTime::parse_from_rfc2822(value).ok()?;
        date.timestamp_millis().saturating_sub(now_ms)
    };
    (wait_ms > 0).then(|| now_ms.saturating_add(wait_ms.min(LONGEST_MS)))
}

/// When `response`, a rejection with `status`, asked the next attempt to
/// wait until, in epoch ms.
pub(super) fn of(status: u16, response: &ureq::Response) -> Option<i64> {
    applies(status)
        .then(|| at(response.header("Retry-After"), now_ms()))
        .flatten()
}

/// The current time in epoch ms.
fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_793_000_000_000;

    #[test]
    fn seconds_and_dates_become_an_absolute_capped_retry_time() {
        assert_eq!(at(Some("30"), NOW), Some(NOW + 30_000));
        assert_eq!(at(Some(" 120 "), NOW), Some(NOW + 120_000));
        assert_eq!(at(Some("999999999"), NOW), Some(NOW + LONGEST_MS));
        let later = chrono::DateTime::from_timestamp_millis(NOW + 90_000).unwrap();
        let date = later.format("%a, %d %b %Y %H:%M:%S GMT").to_string();
        assert_eq!(at(Some(&date), NOW), Some(NOW + 90_000));
    }

    #[test]
    fn missing_malformed_or_past_values_ask_for_nothing() {
        assert_eq!(at(None, NOW), None);
        assert_eq!(at(Some(""), NOW), None);
        assert_eq!(at(Some("soon"), NOW), None);
        assert_eq!(at(Some("-5"), NOW), None);
        assert_eq!(at(Some("0"), NOW), None);
        let earlier = chrono::DateTime::from_timestamp_millis(NOW - 1_000).unwrap();
        let date = earlier.format("%a, %d %b %Y %H:%M:%S GMT").to_string();
        assert_eq!(at(Some(&date), NOW), None);
    }

    #[test]
    fn a_rate_limit_carries_the_receivers_retry_after() {
        let before = now_ms();
        let response: ureq::Response = "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 30\r\n\r\n"
            .parse()
            .unwrap();
        let failure = super::super::verdict(&super::super::http_error(
            ureq::Error::Status(429, response),
            "{}",
        ));
        assert_eq!(failure.failure, super::super::DeliveryFailure::RateLimited);
        let at = failure.retry_after_ms.unwrap();
        assert!((before + 30_000..=now_ms() + 30_000).contains(&at));
        let response: ureq::Response = "HTTP/1.1 503 Unavailable\r\nRetry-After: 5\r\n\r\n"
            .parse()
            .unwrap();
        let failure = super::super::verdict(&super::super::http_error(
            ureq::Error::Status(503, response),
            "{}",
        ));
        assert_eq!(failure.failure, super::super::DeliveryFailure::Transient);
        assert!(failure.retry_after_ms.is_some());
        let response: ureq::Response = "HTTP/1.1 500 Error\r\nRetry-After: 5\r\n\r\n"
            .parse()
            .unwrap();
        let failure = super::super::verdict(&super::super::http_error(
            ureq::Error::Status(500, response),
            "{}",
        ));
        assert_eq!(failure.retry_after_ms, None);
    }

    #[test]
    fn only_rate_limits_and_outages_carry_one() {
        assert!([408, 425, 429, 503].into_iter().all(applies));
        assert!(![400, 409, 422, 500, 502].into_iter().any(applies));
    }
}
