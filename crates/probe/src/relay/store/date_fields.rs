//! Compatibility decoders for older persisted date and string fields.

use super::iso8601_from_seconds;
use serde::{Deserialize, Deserializer};
use serde_json::Value;

/// A string field older writers left out or wrote as `null`.
pub(super) fn null_as_default<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<String, D::Error> {
    Ok(Option::<String>::deserialize(deserializer)?.unwrap_or_default())
}

/// `registeredAt` as ISO-8601: the string macOS wrote, or the Unix seconds
/// the Linux app wrote.
pub(super) fn timestamp<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    match Value::deserialize(deserializer)? {
        Value::String(text) => Ok(text),
        Value::Number(number) => Ok(iso8601_from_seconds(number.as_f64().unwrap_or(0.0))),
        Value::Null => Ok(iso8601_from_seconds(0.0)),
        _ => Err(serde::de::Error::custom("registeredAt is not a date")),
    }
}

pub(super) fn optional_timestamp<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    match Value::deserialize(deserializer)? {
        Value::String(text) => Ok(Some(text)),
        Value::Number(number) => Ok(Some(iso8601_from_seconds(number.as_f64().unwrap_or(0.0)))),
        Value::Null => Ok(None),
        _ => Err(serde::de::Error::custom("timestamp is not a date")),
    }
}

pub(super) fn optional_timestamps<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<String>>, D::Error> {
    Option::<Vec<Value>>::deserialize(deserializer)?
        .map(|items| {
            items
                .into_iter()
                .map(|item| match item {
                    Value::String(text) => Ok(text),
                    Value::Number(number) => {
                        Ok(iso8601_from_seconds(number.as_f64().unwrap_or(0.0)))
                    }
                    _ => Err(serde::de::Error::custom("timestamp is not a date")),
                })
                .collect()
        })
        .transpose()
}
