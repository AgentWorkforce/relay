//! Reads a core's answers and events into the registry's own types, as a
//! Rust client of the bridge (the Linux app) receives them.
//!
//! A core of another version than the client (normal mid-update) can send
//! values this build does not know. They are read the way the generated
//! Swift client reads them, from the same schema
//! ([`Contract`]): a field this build does not know is ignored, and an enum
//! value it does not know reads as the enum's `x-fallback`. A Rust enum has
//! no case for a value it does not know, so a value of an enum without a
//! fallback is dropped at the nearest place that can go without it: an
//! optional field, a list element or a map entry. Only a value that no such
//! place holds leaves the whole answer unreadable.
//!
//! The registry's types stay strict for the core, which reads parameters
//! with them; this leniency applies only to what clients read.

use super::codegen::{Contract, Def, Field, Ty};
use super::{EventData, Method};
use crate::relay::protocol::Topic;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use std::sync::OnceLock;

/// An answer or event that does not fit this build's contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unreadable {
    /// Where reading failed: the method or topic, and serde's account.
    pub detail: String,
}

impl std::fmt::Display for Unreadable {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.detail)
    }
}

impl std::error::Error for Unreadable {}

fn contract() -> &'static Contract {
    static CONTRACT: OnceLock<Contract> = OnceLock::new();
    CONTRACT.get_or_init(Contract::collect)
}

/// Method `M`'s result.
pub fn result<M: Method>(value: Value) -> Result<M::Result, Unreadable> {
    let contract = contract();
    let ty = contract
        .methods
        .iter()
        .find(|method| method.name == M::NAME)
        .map(|method| &method.result)
        .expect("every Method is registered");
    read(contract, ty, value, M::NAME)
}

/// Topic `T::TOPIC`'s payload.
pub fn event<T: EventData>(value: Value) -> Result<T, Unreadable> {
    let contract = contract();
    let name = topic_name(T::TOPIC);
    let ty = contract
        .events
        .iter()
        .find(|(topic, _)| *topic == name)
        .map(|(_, ty)| ty)
        .expect("every EventData is registered");
    read(contract, ty, value, &name)
}

fn topic_name(topic: Topic) -> String {
    match serde_json::to_value(topic) {
        Ok(Value::String(name)) => name,
        _ => unreachable!("a topic is a string"),
    }
}

fn read<T: DeserializeOwned>(
    contract: &Contract,
    ty: &Ty,
    value: Value,
    what: &str,
) -> Result<T, Unreadable> {
    let value = known(contract, ty, value).ok_or_else(|| Unreadable {
        detail: format!("{what}: a value this build does not know has no fallback"),
    })?;
    serde_json::from_value(value).map_err(|error| Unreadable {
        detail: format!("{what}: {error}"),
    })
}

/// `value` with everything this build does not know read as the contract
/// says; `None` when `value` itself cannot be.
fn known(contract: &Contract, ty: &Ty, value: Value) -> Option<Value> {
    match (ty, value) {
        (Ty::Nullable(_), Value::Null) => Some(Value::Null),
        (Ty::Nullable(inner), value) => Some(known(contract, inner, value).unwrap_or(Value::Null)),
        (Ty::Array(inner), Value::Array(items)) => Some(Value::Array(
            items
                .into_iter()
                .filter_map(|item| known(contract, inner, item))
                .collect(),
        )),
        (Ty::Map(inner), Value::Object(entries)) => Some(Value::Object(
            entries
                .into_iter()
                .filter_map(|(key, item)| Some((key, known(contract, inner, item)?)))
                .collect(),
        )),
        (Ty::Named(name), value) => named(contract, name, value),
        // A value of another shape is serde's to refuse, with its account.
        (_, value) => Some(value),
    }
}

fn named(contract: &Contract, name: &str, value: Value) -> Option<Value> {
    match (&contract.defs[name], value) {
        (
            Def::Enum {
                cases, fallback, ..
            },
            Value::String(case),
        ) => {
            if cases.iter().any(|(known, _)| *known == case) {
                Some(Value::String(case))
            } else {
                fallback.clone().map(Value::String)
            }
        }
        (Def::Struct { fields, .. }, Value::Object(object)) => {
            object_of(contract, fields, object, None)
        }
        (
            Def::Tagged {
                tag,
                variants,
                fallback,
                ..
            },
            Value::Object(object),
        ) => {
            let value = object.get(tag).and_then(Value::as_str);
            match variants
                .iter()
                .find(|variant| Some(variant.value.as_str()) == value)
            {
                Some(variant) => object_of(contract, &variant.fields, object, Some(tag)),
                None => {
                    let fallback = fallback.as_ref()?;
                    let mut object = Map::new();
                    object.insert(tag.clone(), Value::String(fallback.clone()));
                    Some(Value::Object(object))
                }
            }
        }
        (_, value) => Some(value),
    }
}

/// The fields this build knows, each read as its type says; `tag` is kept
/// as is.
fn object_of(
    contract: &Contract,
    fields: &[Field],
    mut object: Map<String, Value>,
    tag: Option<&String>,
) -> Option<Value> {
    let mut out = Map::new();
    if let Some(tag) = tag {
        out.insert(tag.clone(), object.remove(tag)?);
    }
    for field in fields {
        let Some(value) = object.remove(&field.wire) else {
            continue;
        };
        match known(contract, &field.ty, value) {
            Some(value) => {
                out.insert(field.wire.clone(), value);
            }
            None if field.required => return None,
            None => {}
        }
    }
    Some(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::contract::{connection, method};
    use crate::relay::protocol::ErrorKind;
    use serde_json::json;

    #[test]
    fn unknown_topics_and_methods_in_a_handshake_are_left_out() {
        let hello = result::<method::Hello>(json!({
            "bridge_version": 2, "daemon_version": "9.9.9", "pid": 7,
            "methods": ["hello", "telepathy.read"],
            "topics": ["status", "telepathy.changed"],
            "added_later": true,
        }))
        .unwrap();
        assert_eq!(hello.methods, ["hello", "telepathy.read"]);
        assert_eq!(hello.topics, [Topic::Status]);
    }

    #[test]
    fn an_unknown_value_reads_as_its_fallback_or_leaves_its_optional_field() {
        let mut value = json!({
            "revision": 1,
            "daemon": {"version": "0.0.0", "bridge_version": 2, "pid": 1,
                       "started_at_ms": 0, "socket": ""},
            "machine": {"host_name": "test.local", "machine_prefix": "test"},
            "workspace": {"state": "missing", "verification": "pending"},
            "push": {"a": {"state": "live"}, "b": {"state": "orbiting"}},
            "agents": {},
            "account": {"state": "signed_in"},
        });
        value["account"]["state"] = json!("hibernating");
        value["account"]["action"] = json!("reinstall_the_core");
        value["workspace"]["verification"] = json!("pondering");
        let status = result::<method::StatusGet>(value).unwrap();
        assert_eq!(
            status.account.state,
            crate::relay::state::SignInState::Error
        );
        assert_eq!(status.account.action, None);
        assert_eq!(
            status.workspace.verification,
            crate::relay::state::Verification::Pending
        );
        assert_eq!(status.push["b"], crate::relay::push::PushState::Connecting);
    }

    #[test]
    fn an_event_without_a_fallback_for_a_required_value_is_unreadable() {
        let invalidated = event::<connection::Invalidation>(json!({"what": "agents"})).unwrap();
        assert_eq!(invalidated.what, crate::relay::state::Listing::Agents);
        let unknown = event::<connection::Invalidation>(json!({"what": "telepathy"}));
        assert!(unknown.is_err());
    }

    #[test]
    fn an_unknown_tagged_variant_reads_as_its_fallback() {
        let kind: ErrorKind = serde_json::from_value(json!("internal")).unwrap();
        assert_eq!(kind, ErrorKind::Internal);
        let contract = contract();
        let value = known(
            contract,
            &Ty::Named("PushState".into()),
            json!({"state": "orbiting", "altitude": 3}),
        );
        assert_eq!(value, Some(json!({"state": "connecting"})));
        let waiting = known(
            contract,
            &Ty::Named("PushState".into()),
            json!({"state": "waiting", "retry_in_ms": 5, "extra": 1}),
        );
        assert_eq!(waiting, Some(json!({"state": "waiting", "retry_in_ms": 5})));
    }

    /// The fallback a tagged enum reads an unknown variant as carries no
    /// field, so a bare tag is a whole value.
    #[test]
    fn every_tagged_fallback_needs_no_fields() {
        for (name, def) in &contract().defs {
            if let Def::Tagged {
                variants,
                fallback: Some(fallback),
                ..
            } = def
            {
                let variant = variants.iter().find(|v| v.value == *fallback).unwrap();
                assert!(
                    variant.fields.iter().all(|field| !field.required),
                    "{name}: the fallback {fallback} needs fields"
                );
            }
        }
    }
}
