//! What a relayfile-cloud error status means to the person subscribing.
//!
//! relayfile answers 429 for two different things: a short-lived request
//! limit, which sends `Retry-After`, and a workspace's webhook subscription
//! cap (`subscription_limit_exceeded`), which only clears when subscriptions
//! are removed or the plan changes. Reporting both as "relayfile returned
//! HTTP 429." made a full workspace look like a rate limit, so callers kept
//! retrying a request that could not succeed.
use crate::relay::protocol::{ErrorKind, RpcError};
use serde_json::Value;

/// The error for a relayfile response with `status` (not 404), its
/// `Retry-After` header and its body. Only relayfile's own short
/// identifiers and counters are repeated, never its free-text message.
pub(super) fn relayfile_status_error(
    status: u16,
    retry_after: Option<&str>,
    body: &str,
) -> RpcError {
    let body: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let error = body.get("error").filter(|e| e.is_object()).unwrap_or(&body);
    let code = identifier(&error["code"]);
    let correlation =
        identifier(&error["correlationId"]).or_else(|| identifier(&body["correlationId"]));
    let reference = correlation
        .map(|id| format!(" (correlation id {id})"))
        .unwrap_or_default();
    if status == 429 && code == Some("subscription_limit_exceeded") {
        let cap = match (error["limit"].as_u64(), identifier(&error["plan"])) {
            (Some(limit), Some(plan)) => format!(" ({limit} on the {plan} plan)"),
            (Some(limit), None) => format!(" ({limit})"),
            _ => String::new(),
        };
        return RpcError::new(
            ErrorKind::PlanLimitExceeded,
            format!(
                "This workspace has reached relayfile's webhook subscription limit{cap}. \
                 Unsubscribe integrations it no longer needs, or raise the workspace's plan, \
                 then subscribe again{reference}."
            ),
        );
    }
    let retry_after_secs =
        retry_after.and_then(|value| retry_after_seconds(value, chrono::Utc::now()));
    let kind = match status {
        429 => ErrorKind::RateLimited,
        400..=499 => ErrorKind::CloudRefused,
        _ => ErrorKind::CloudFailed,
    };
    let what = code.map(|code| format!(": {code}")).unwrap_or_default();
    let wait = match (status, retry_after_secs) {
        (429, Some(secs)) => format!(" Retry after {secs}s."),
        _ => String::new(),
    };
    let mut error = RpcError::new(
        kind,
        format!("relayfile returned HTTP {status}{what}{reference}.{wait}"),
    );
    error.retry_after_secs = retry_after_secs.filter(|_| status == 429 || status == 503);
    error
}

/// `Retry-After` as seconds from `now`: either delay-seconds or an
/// HTTP-date (RFC 9110 §10.2.3). A date already past means retry now; an
/// unreadable value is dropped.
pub(crate) fn retry_after_seconds(value: &str, now: chrono::DateTime<chrono::Utc>) -> Option<u64> {
    let value = value.trim();
    if let Ok(secs) = value.parse::<u64>() {
        return Some(secs);
    }
    // IMF-fixdate ("Sun, 06 Nov 1994 08:49:37 GMT") is RFC 2822 shaped.
    let at = chrono::DateTime::parse_from_rfc2822(value).ok()?;
    let wait = at.with_timezone(&chrono::Utc) - now;
    let millis = u64::try_from(wait.num_milliseconds()).unwrap_or(0);
    Some(millis.div_ceil(1000))
}

/// A short machine identifier from relayfile (an error code, a plan, a
/// correlation id); anything else is dropped rather than echoed.
fn identifier(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| {
        !text.is_empty()
            && text.len() <= 96
            && text
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':'))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_full_workspace_is_a_plan_limit_not_a_rate_limit() {
        let error = relayfile_status_error(
            429,
            None,
            r#"{"code":"subscription_limit_exceeded","message":"webhook subscription limit exceeded (32 for plan free)","correlationId":"corr-1","limit":32,"plan":"free"}"#,
        );
        assert_eq!(error.data.kind, ErrorKind::PlanLimitExceeded);
        assert!(!error.data.retryable);
        assert_eq!(error.retry_after_secs, None);
        assert!(error
            .message
            .contains("webhook subscription limit (32 on the free plan)"));
        assert!(error.message.contains("correlation id corr-1"));
    }

    #[test]
    fn a_rate_limit_keeps_its_retry_after() {
        let error = relayfile_status_error(
            429,
            Some(" 42 "),
            r#"{"error":{"code":"rate_limited","message":"slow down"}}"#,
        );
        assert_eq!(error.data.kind, ErrorKind::RateLimited);
        assert!(error.data.retryable);
        assert_eq!(error.retry_after_secs, Some(42));
        assert_eq!(
            error.message,
            "relayfile returned HTTP 429: rate_limited. Retry after 42s."
        );
    }

    #[test]
    fn retry_after_accepts_an_http_date() {
        let now = chrono::DateTime::parse_from_rfc2822("Sun, 06 Nov 1994 08:49:00 GMT")
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert_eq!(
            retry_after_seconds("Sun, 06 Nov 1994 08:49:37 GMT", now),
            Some(37)
        );
        assert_eq!(
            retry_after_seconds(" Sun, 06 Nov 1994 08:48:00 GMT ", now),
            Some(0),
            "a date already past means retry now"
        );
        assert_eq!(retry_after_seconds("12", now), Some(12));
        assert_eq!(retry_after_seconds("soon", now), None);

        let later = (chrono::Utc::now() + chrono::Duration::seconds(90))
            .format("%a, %d %b %Y %H:%M:%S GMT")
            .to_string();
        let error = relayfile_status_error(429, Some(&later), "{}");
        assert_eq!(error.data.kind, ErrorKind::RateLimited);
        let secs = error.retry_after_secs.expect("date form kept");
        assert!((85..=90).contains(&secs), "{secs}");
        assert!(error.message.ends_with(&format!("Retry after {secs}s.")));
    }

    #[test]
    fn other_statuses_keep_their_kind_and_never_echo_free_text() {
        let refused = relayfile_status_error(
            400,
            Some("5"),
            r#"{"code":"bad_request","message":"secret rk_live_x","correlationId":"has space"}"#,
        );
        assert_eq!(refused.data.kind, ErrorKind::CloudRefused);
        assert_eq!(refused.retry_after_secs, None);
        assert_eq!(refused.message, "relayfile returned HTTP 400: bad_request.");

        let failed = relayfile_status_error(503, Some("7"), "not json");
        assert_eq!(failed.data.kind, ErrorKind::CloudFailed);
        assert_eq!(failed.retry_after_secs, Some(7));
        assert_eq!(failed.message, "relayfile returned HTTP 503.");
    }
}
