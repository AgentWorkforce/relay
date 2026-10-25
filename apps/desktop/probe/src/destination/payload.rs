//! PostgreSQL-safe evidence payloads and bounded repairs of persisted bodies.
use super::{fail, hash, DeliveryFailure, MAX_BODY_BYTES};
use anyhow::Result;

fn hex_unit(bytes: &[u8]) -> Option<u16> {
    (bytes.len() == 4).then_some(())?;
    bytes.iter().try_fold(0u16, |value, byte| {
        let digit = match byte {
            b'0'..=b'9' => u16::from(byte - b'0'),
            b'a'..=b'f' => u16::from(byte - b'a') + 10,
            b'A'..=b'F' => u16::from(byte - b'A') + 10,
            _ => return None,
        };
        Some(value * 16 + digit)
    })
}

/// Width of one escape and whether it is an unpaired UTF-16 surrogate.
/// Ordinary or malformed escapes consume their leading pair, keeping
/// literal backslash-u text opaque to the string scanner.
fn escape_width(bytes: &[u8]) -> (usize, bool) {
    let Some(unit) = escaped_unit(bytes) else {
        return (2, false);
    };
    if (0xD800..=0xDBFF).contains(&unit)
        && escaped_unit(&bytes[6..]).is_some_and(|low| (0xDC00..=0xDFFF).contains(&low))
    {
        return (12, false);
    }
    (6, (0xD800..=0xDFFF).contains(&unit))
}

fn escaped_unit(bytes: &[u8]) -> Option<u16> {
    hex_unit(bytes.strip_prefix(br"\u")?.get(..4)?)
}

/// Interpret escapes only while inside a JSON string. Consuming each ordinary
/// escape as a pair keeps literal backslash-u text opaque.
fn safe_escapes(text: &str) -> (String, bool) {
    let bytes = text.as_bytes();
    let mut output = String::with_capacity(text.len());
    let mut copied = 0;
    let mut index = 0;
    let mut in_string = false;
    let mut changed = false;
    while index < bytes.len() {
        match bytes[index] {
            b'"' => {
                in_string = !in_string;
                index += 1;
            }
            b'\\' if in_string => {
                let (width, replace) = escape_width(&bytes[index..]);
                if replace {
                    output.push_str(&text[copied..index]);
                    output.push_str("\\ufffd");
                    copied = index + 6;
                    changed = true;
                }
                index += width;
            }
            _ => index += 1,
        }
    }
    if !changed {
        return (text.to_owned(), false);
    }
    output.push_str(&text[copied..]);
    (output, true)
}

fn scrub(text: &str) -> Option<String> {
    text.contains('\0').then(|| text.replace('\0', "\u{FFFD}"))
}

/// Returns whether any direct NUL was replaced, including in object keys.
fn walk_nul(value: &mut serde_json::Value) -> bool {
    match value {
        serde_json::Value::String(text) => match scrub(text) {
            Some(clean) => {
                *text = clean;
                true
            }
            None => false,
        },
        serde_json::Value::Array(items) => items
            .iter_mut()
            .fold(false, |changed, item| walk_nul(item) | changed),
        serde_json::Value::Object(map) => {
            let mut changed = false;
            let mut renamed = Vec::new();
            for (key, mut item) in std::mem::take(map) {
                changed |= walk_nul(&mut item);
                match scrub(&key) {
                    Some(clean) => renamed.push((clean, item)),
                    None => {
                        map.insert(key, item);
                    }
                }
            }
            for (clean, item) in renamed {
                changed = true;
                let mut key = clean.clone();
                let mut n = 1u32;
                while map.contains_key(&key) {
                    key = format!("{clean}\u{FFFD}{n}");
                    n += 1;
                }
                map.insert(key, item);
            }
            changed
        }
        _ => false,
    }
}

#[derive(Default)]
pub(crate) struct PayloadSanitization {
    pub(crate) changed: bool,
    pub(crate) altered_json_fields: usize,
    /// Field name and cleaned source before malformed JSON was made opaque.
    malformed: Vec<(String, String)>,
}

/// Normalize only direct `*_json` columns in an evidence-row payload. This is
/// run before delivery batching so size accounting sees the final encoding.
pub(crate) fn sanitize_payload(payload: &mut serde_json::Value) -> Result<PayloadSanitization> {
    let mut result = PayloadSanitization::default();
    let Some(columns) = payload.as_object_mut() else {
        result.changed = walk_nul(payload);
        return Ok(result);
    };
    for (name, column) in columns.iter_mut() {
        let serde_json::Value::String(text) = column else {
            continue;
        };
        if !name.ends_with("_json") {
            continue;
        }
        let mut changed = false;
        if let Some(clean) = scrub(text) {
            *text = clean;
            changed = true;
        }
        let (clean, escapes_changed) = safe_escapes(text);
        if escapes_changed {
            *text = clean;
            changed = true;
        }
        match serde_json::from_str::<serde_json::Value>(text) {
            Ok(mut document) => {
                if walk_nul(&mut document) || escapes_changed {
                    *text = serde_json::to_string(&document)?;
                    changed = true;
                }
            }
            Err(_) => {
                let source = text.clone();
                *text = serde_json::to_string(text)?;
                result.malformed.push((name.clone(), source));
                changed = true;
            }
        }
        if changed {
            result.altered_json_fields += 1;
            result.changed = true;
        }
    }
    result.changed |= walk_nul(payload);
    Ok(result)
}

fn json_text_mut<'a>(
    value: &'a mut serde_json::Value,
    record_index: usize,
    name: &str,
) -> Option<&'a mut String> {
    match value
        .get_mut("batch")?
        .get_mut("records")?
        .as_array_mut()?
        .get_mut(record_index)?
        .get_mut("payload")?
        .as_object_mut()?
        .get_mut(name)?
    {
        serde_json::Value::String(text) => Some(text),
        _ => None,
    }
}

fn mark_payload_truncated(value: &mut serde_json::Value, record_index: usize) {
    let Some(payload) = value
        .get_mut("batch")
        .and_then(|batch| batch.get_mut("records"))
        .and_then(serde_json::Value::as_array_mut)
        .and_then(|records| records.get_mut(record_index))
        .and_then(|record| record.get_mut("payload"))
        .and_then(serde_json::Value::as_object_mut)
    else {
        return;
    };
    if let Some(flag) = payload.get_mut("payload_truncated") {
        *flag = if flag.is_boolean() {
            true.into()
        } else {
            1.into()
        };
    }
}

pub(super) const JSON_TEXT_TRUNCATION_MARKER: &str =
    " [truncated by Agent Relay to fit the upload limit]";

/// Make every string the receiver stores acceptable to PostgreSQL. Clean
/// bodies are returned byte-for-byte; malformed JSON text is preserved as a
/// JSON string. This also repairs bodies persisted by older probe builds.
pub(super) fn storable_body(body: String) -> Result<String> {
    let mut value: serde_json::Value =
        serde_json::from_str(&body).map_err(|_| fail(DeliveryFailure::InvalidPayload))?;
    let batch_ref = value
        .pointer("/batch/batch_id")
        .and_then(serde_json::Value::as_str)
        .map(|batch_id| hash(batch_id.as_bytes()));
    let mut changed = false;
    let mut altered_json_fields = 0usize;
    let mut malformed_json_fields = Vec::new();
    // JSON text is a property of row columns, not of arbitrary nested user
    // objects. Restrict decoding to direct fields of each record payload.
    if let Some(records) = value
        .get_mut("batch")
        .and_then(|batch| batch.get_mut("records"))
        .and_then(serde_json::Value::as_array_mut)
    {
        for (record_index, record) in records.iter_mut().enumerate() {
            let Some(payload) = record.get_mut("payload") else {
                continue;
            };
            let result = sanitize_payload(payload)?;
            changed |= result.changed;
            altered_json_fields += result.altered_json_fields;
            for (name, source) in result.malformed {
                malformed_json_fields.push((record_index, name, source));
            }
        }
    }
    // PostgreSQL text cannot store a direct U+0000 either. This is the
    // existing outer-body protection and deliberately does not interpret
    // backslash-u text in ordinary strings.
    changed |= walk_nul(&mut value);
    if !changed {
        return Ok(body);
    }
    let mut serialized = serde_json::to_string(&value)?;
    let mut truncated_json_fields = 0usize;
    // Legacy prepared bodies were sized before JSON-text normalization. If
    // quoting malformed text expands one past the wire cap, retain the longest
    // prefix that fits. New batches take this path before `push_record`, where
    // the ordinary record-shortening logic also marks payload_truncated.
    for (record_index, name, source) in malformed_json_fields {
        if serialized.len() <= MAX_BODY_BYTES {
            break;
        }
        serialized = truncate_json_text(&mut value, record_index, &name, &source)?;
        truncated_json_fields += 1;
    }
    if altered_json_fields > 0 {
        eprintln!(
            "receiver payload sanitized batch_ref={} json_text_fields={altered_json_fields} truncated_json_text_fields={truncated_json_fields}",
            batch_ref.as_deref().unwrap_or("unknown")
        );
    }
    Ok(serialized)
}

/// Retain the longest Unicode prefix of one malformed JSON-text column
/// that fits the full wire body, including its truncation marker.
fn truncate_json_text(
    value: &mut serde_json::Value,
    record_index: usize,
    name: &str,
    source: &str,
) -> Result<String> {
    let boundaries: Vec<usize> = std::iter::once(0)
        .chain(source.char_indices().map(|(index, _)| index).skip(1))
        .chain(std::iter::once(source.len()))
        .collect();
    mark_payload_truncated(value, record_index);
    *json_text_mut(value, record_index, name)
        .ok_or_else(|| fail(DeliveryFailure::InvalidPayload))? =
        serde_json::to_string(JSON_TEXT_TRUNCATION_MARKER)?;
    let empty_body = serde_json::to_string(value)?;
    if empty_body.len() > MAX_BODY_BYTES {
        return Ok(empty_body);
    }
    let mut low = 0usize;
    let mut high = boundaries.len() - 1;
    let mut best_body = empty_body;
    let mut best_text = serde_json::to_string(JSON_TEXT_TRUNCATION_MARKER)?;
    while low <= high {
        let middle = low + (high - low) / 2;
        let shortened = format!(
            "{}{}",
            &source[..boundaries[middle]],
            JSON_TEXT_TRUNCATION_MARKER
        );
        let encoded = serde_json::to_string(&shortened)?;
        let field = json_text_mut(value, record_index, name)
            .ok_or_else(|| fail(DeliveryFailure::InvalidPayload))?;
        *field = encoded.clone();
        let candidate = serde_json::to_string(value)?;
        if candidate.len() <= MAX_BODY_BYTES {
            best_body = candidate;
            best_text = encoded;
            low = middle + 1;
        } else if middle == 0 {
            break;
        } else {
            high = middle - 1;
        }
    }
    let field = json_text_mut(value, record_index, name)
        .ok_or_else(|| fail(DeliveryFailure::InvalidPayload))?;
    *field = best_text;
    Ok(best_body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn surrogate_repairs_preserve_pairs_literals_and_incomplete_escapes() {
        for text in [
            r#""\ud83d\ude00""#,
            r#""\\ud800""#,
            r#""\u0041""#,
            r#""\u12""#,
            r#""\uxxxx""#,
            r#""unterminated\"#,
            r#"\ud800"#,
        ] {
            assert_eq!(safe_escapes(text), (text.to_owned(), false), "{text}");
        }
        for (text, expected) in [
            (r#""\ud800""#, r#""\ufffd""#),
            (r#""\udfff""#, r#""\ufffd""#),
            (r#""\ud800\u0041""#, r#""\ufffd\u0041""#),
            (r#""\ud800\ud800\udc00""#, r#""\ufffd\ud800\udc00""#),
            (r#""🙂\ud800尾""#, r#""🙂\ufffd尾""#),
        ] {
            assert_eq!(safe_escapes(text), (expected.to_owned(), true), "{text}");
        }
    }
}
