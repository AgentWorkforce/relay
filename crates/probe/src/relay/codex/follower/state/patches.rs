//! The bounded Immer JSON patch subset used by Codex window state v11.
use super::{Error, Value, MAX_STATE};

pub(super) fn apply(original: &Value, value: &Value) -> Result<Value, Error> {
    let patches = value
        .as_array()
        .filter(|p| p.len() <= 512)
        .ok_or(Error::InvalidState)?;
    let mut state = original.clone();
    for patch in patches {
        let path = patch["path"]
            .as_array()
            .filter(|p| p.len() <= 32)
            .ok_or(Error::InvalidState)?;
        edit(&mut state, path, patch)?;
        if serde_json::to_vec(&state)
            .map_err(|_| Error::InvalidState)?
            .len()
            > MAX_STATE
        {
            return Err(Error::InvalidState);
        }
    }
    Ok(state)
}

fn edit(state: &mut Value, path: &[Value], patch: &Value) -> Result<(), Error> {
    let op = patch["op"].as_str().ok_or(Error::InvalidState)?;
    if path.is_empty() {
        if op != "replace" {
            return Err(Error::InvalidState);
        }
        *state = patch.get("value").ok_or(Error::InvalidState)?.clone();
        return Ok(());
    }
    let (last, parents) = path.split_last().ok_or(Error::InvalidState)?;
    let mut target = state;
    for part in parents {
        target = match target {
            Value::Object(map) => map.get_mut(part.as_str().ok_or(Error::InvalidState)?),
            Value::Array(array) => array.get_mut(index(part)?),
            _ => None,
        }
        .ok_or(Error::InvalidState)?;
    }
    match target {
        Value::Object(map) => edit_object(map, last, op, patch),
        Value::Array(array) => edit_array(array, last, op, patch),
        _ => Err(Error::InvalidState),
    }
}
fn edit_object(
    map: &mut serde_json::Map<String, Value>,
    last: &Value,
    op: &str,
    patch: &Value,
) -> Result<(), Error> {
    let key = last.as_str().ok_or(Error::InvalidState)?;
    match op {
        "add" => {
            map.insert(
                key.into(),
                patch.get("value").ok_or(Error::InvalidState)?.clone(),
            );
        }
        "replace" if map.contains_key(key) => {
            map.insert(
                key.into(),
                patch.get("value").ok_or(Error::InvalidState)?.clone(),
            );
        }
        "remove" if map.contains_key(key) => {
            map.remove(key);
        }
        _ => return Err(Error::InvalidState),
    }
    Ok(())
}
fn edit_array(array: &mut Vec<Value>, last: &Value, op: &str, patch: &Value) -> Result<(), Error> {
    let index = index(last)?;
    match op {
        "add" if index <= array.len() => array.insert(
            index,
            patch.get("value").ok_or(Error::InvalidState)?.clone(),
        ),
        "replace" if index < array.len() => {
            array[index] = patch.get("value").ok_or(Error::InvalidState)?.clone()
        }
        "remove" if index < array.len() => {
            array.remove(index);
        }
        _ => return Err(Error::InvalidState),
    }
    Ok(())
}

fn index(value: &Value) -> Result<usize, Error> {
    value
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .ok_or(Error::InvalidState)
}
