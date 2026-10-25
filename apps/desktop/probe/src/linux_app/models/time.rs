//! Times as the app shows them. Every function takes the current time and
//! the time zone it formats in, so the same input always reads the same.

use chrono::{DateTime, TimeZone};
use std::fmt::Display;

/// What a time that never happened reads as.
pub const NO_TIME: &str = "—";

/// Milliseconds since the epoch as a time in `zone`; zero, negative and
/// missing mean never.
fn moment<Tz: TimeZone>(milliseconds: Option<i64>, zone: &Tz) -> Option<DateTime<Tz>> {
    let milliseconds = milliseconds.filter(|value| *value > 0)?;
    zone.timestamp_millis_opt(milliseconds).single()
}

/// `5 minutes ago`, `in 2 hours`: the Mac's full-style relative time, in
/// the largest whole unit that fits (`Just now` below one minute); [`NO_TIME`]
/// for a time that never happened.
pub fn relative_ms(moment_ms: Option<i64>, now_ms: i64) -> String {
    let Some(moment_ms) = moment_ms.filter(|value| *value > 0) else {
        return NO_TIME.to_string();
    };
    if (now_ms - moment_ms).unsigned_abs() < 60_000 {
        return "Just now".into();
    }
    let past = moment_ms < now_ms;
    let seconds = (now_ms - moment_ms).unsigned_abs() / 1000;
    const UNITS: [(&str, u64); 7] = [
        ("year", 365 * 86_400),
        ("month", 30 * 86_400),
        ("week", 7 * 86_400),
        ("day", 86_400),
        ("hour", 3_600),
        ("minute", 60),
        ("second", 1),
    ];
    let (unit, count) = UNITS
        .iter()
        .find(|(_, size)| seconds >= *size)
        .map(|(unit, size)| (*unit, seconds / size))
        .unwrap_or(("second", 0));
    let plural = if count == 1 { "" } else { "s" };
    if past {
        format!("{count} {unit}{plural} ago")
    } else {
        format!("in {count} {unit}{plural}")
    }
}

/// Exact timestamp shared by the Created and Updated hover text.
pub fn exact_ms(moment_ms: Option<i64>) -> String {
    moment(moment_ms, &chrono::Utc)
        .map(|time| time.format("%b %-d, %Y, %-I:%M:%S %p UTC").to_string())
        .unwrap_or_else(|| NO_TIME.to_string())
}

/// `Oct 3, 18:45` in `zone`, or [`NO_TIME`].
pub fn clock_ms<Tz: TimeZone>(moment_ms: Option<i64>, zone: &Tz) -> String
where
    Tz::Offset: Display,
{
    moment(moment_ms, zone)
        .map(|time| time.format("%b %-d, %H:%M").to_string())
        .unwrap_or_else(|| NO_TIME.to_string())
}

/// `09:05` on the same day as `now_ms` in `zone`, else `Oct 3, 18:45`;
/// `None` for a time that never happened.
pub fn clock_since<Tz: TimeZone>(moment_ms: Option<i64>, now_ms: i64, zone: &Tz) -> Option<String>
where
    Tz::Offset: Display,
{
    let seen = moment(moment_ms, zone)?;
    let today = zone
        .timestamp_millis_opt(now_ms)
        .single()
        .is_some_and(|now| now.date_naive() == seen.date_naive());
    let pattern = if today { "%H:%M" } else { "%b %-d, %H:%M" };
    Some(seen.format(pattern).to_string())
}

/// `Oct 3 2026, 18:45` in `zone`, for diagnostics; `None` for a time that
/// never happened.
pub(super) fn dated_clock<Tz: TimeZone>(moment_ms: Option<i64>, zone: &Tz) -> Option<String>
where
    Tz::Offset: Display,
{
    moment(moment_ms, zone).map(|time| time.format("%b %-d %Y, %H:%M").to_string())
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use chrono::{FixedOffset, NaiveDate};

    /// A zone no test machine is assumed to be in.
    pub fn zone() -> FixedOffset {
        FixedOffset::east_opt(2 * 3_600).unwrap()
    }

    /// Milliseconds of a wall-clock time in [`zone`].
    pub fn local_ms(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> i64 {
        let naive = NaiveDate::from_ymd_opt(year, month, day)
            .unwrap()
            .and_hms_opt(hour, minute, 0)
            .unwrap();
        zone()
            .from_local_datetime(&naive)
            .single()
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn relative_times() {
        let now = 10_000_000;
        assert_eq!(relative_ms(None, now), "—");
        assert_eq!(relative_ms(Some(0), now), "—");
        assert_eq!(relative_ms(Some(now - 5_000), now), "Just now");
        assert_eq!(relative_ms(Some(now - 60_000), now), "1 minute ago");
        assert_eq!(relative_ms(Some(now - 120_000), now), "2 minutes ago");
        assert_eq!(relative_ms(Some(now - 7_200_000), now), "2 hours ago");
        assert_eq!(relative_ms(Some(now + 3_600_000), now), "in 1 hour");
        let day = 86_400_000;
        assert_eq!(relative_ms(Some(1), 1 + 9 * day), "1 week ago");
        assert_eq!(relative_ms(Some(1), 1 + 400 * day), "1 year ago");
    }

    #[test]
    fn exact_timestamps_include_seconds_year_and_zone() {
        assert_eq!(exact_ms(None), "—");
        assert_eq!(
            exact_ms(Some(1_700_000_000_000)),
            "Nov 14, 2023, 10:13:20 PM UTC"
        );
        assert_eq!(
            relative_ms(Some(1_700_000_000_000), 1_700_000_030_000),
            "Just now"
        );
    }

    #[test]
    fn clock_times_are_in_the_given_zone() {
        assert_eq!(clock_ms(None, &zone()), "—");
        assert_eq!(
            clock_ms(Some(local_ms(2026, 10, 3, 18, 45)), &zone()),
            "Oct 3, 18:45"
        );
        let utc = FixedOffset::east_opt(0).unwrap();
        assert_eq!(
            clock_ms(Some(local_ms(2026, 10, 3, 18, 45)), &utc),
            "Oct 3, 16:45"
        );
        assert_eq!(
            dated_clock(Some(local_ms(2026, 10, 3, 9, 5)), &zone()).as_deref(),
            Some("Oct 3 2026, 09:05")
        );
    }
}
