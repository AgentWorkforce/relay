//! Generates the Swift client's contract types from the registry: Codable
//! types for the macOS app. The Linux app reads the registry's own types.
//!
//! The registry's types are read as JSON Schema (`schemars`, which follows
//! every serde attribute): results and events as the core serializes them,
//! parameters as it deserializes them. The generator understands exactly
//! the shapes the contract uses: objects, string enums, internally tagged
//! enums, arrays, string-keyed maps, nullable values and free JSON. Anything
//! else is a defect in the contract, and generation panics naming it.
//!
//! Output is deterministic: definitions sort by name and fields by wire name.

use super::{Availability, CONNECTION_METHODS, EVENTS, METHODS};
use crate::relay::protocol::{ErrorKind, RpcError, Topic, BRIDGE_VERSION, EVENT_METHOD};
use schemars::generate::{SchemaGenerator, SchemaSettings};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write;

/// The command that regenerates the checked-in files.
pub const REGENERATE: &str = "scripts/generate-contract.sh";
/// Where the generated file lives, relative to the repository root.
pub const SWIFT_PATH: &str = "macos/Sources/RelayDesktopCore/CoreContract.swift";

/// A value's type on the wire.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum Ty {
    String,
    Bool,
    /// `wide` for `i64`, which carries timestamps; every other integer is a
    /// count or an id that fits a platform integer.
    Int {
        wide: bool,
    },
    Double,
    /// Free JSON.
    Any,
    Array(Box<Ty>),
    Map(Box<Ty>),
    Named(String),
    Nullable(Box<Ty>),
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Field {
    pub(super) wire: String,
    pub(super) ty: Ty,
    /// Always present on the wire (results) or demanded (parameters).
    pub(super) required: bool,
    default: Option<Value>,
    doc: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Variant {
    pub(super) value: String,
    doc: Option<String>,
    pub(super) fields: Vec<Field>,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) enum Def {
    Struct {
        doc: Option<String>,
        fields: Vec<Field>,
    },
    Enum {
        doc: Option<String>,
        cases: Vec<(String, Option<String>)>,
        fallback: Option<String>,
    },
    Tagged {
        doc: Option<String>,
        tag: String,
        variants: Vec<Variant>,
        fallback: Option<String>,
    },
}

pub(super) struct MethodRef {
    pub(super) name: &'static str,
    availability: Availability,
    params: Ty,
    pub(super) result: Ty,
}

/// The whole contract, as the generators read it.
pub struct Contract {
    pub(super) defs: BTreeMap<String, Def>,
    /// The types a client decodes: everything results and events reach.
    decoded: BTreeSet<String>,
    pub(super) methods: Vec<MethodRef>,
    pub(super) events: Vec<(String, Ty)>,
}

fn generator(serialize: bool) -> SchemaGenerator {
    let settings = SchemaSettings::draft2020_12();
    let settings = if serialize {
        settings.for_serialize()
    } else {
        settings.for_deserialize()
    };
    settings.into_generator()
}

fn topic_name(topic: Topic) -> String {
    match serde_json::to_value(topic) {
        Ok(Value::String(name)) => name,
        _ => unreachable!("a topic is a string"),
    }
}

impl Contract {
    /// Reads every registered method and event.
    pub fn collect() -> Contract {
        let mut results = generator(true);
        let mut params = generator(false);
        let mut methods = Vec::new();
        for spec in METHODS {
            let params_schema = (spec.params)(&mut params);
            let result_schema = (spec.result)(&mut results);
            methods.push(MethodRef {
                name: spec.name,
                availability: spec.availability,
                params: ty(params_schema.as_value()),
                result: ty(result_schema.as_value()),
            });
        }
        let events = EVENTS
            .iter()
            .map(|spec| {
                (
                    topic_name(spec.topic),
                    ty((spec.data)(&mut results).as_value()),
                )
            })
            .collect();
        // Named for clients even where no result carries them.
        results.subschema_for::<ErrorKind>();
        results.subschema_for::<RpcError>();
        results.subschema_for::<Topic>();

        let decoded = results.definitions().keys().cloned().collect();
        let mut defs = BTreeMap::new();
        for (generator, mode) in [(&results, "result"), (&params, "parameter")] {
            for (name, schema) in generator.definitions() {
                assert!(
                    !name.ends_with(|c: char| c.is_ascii_digit()),
                    "two contract types are named {}; rename one",
                    name.trim_end_matches(|c: char| c.is_ascii_digit())
                );
                let def = def(name, schema);
                if let Some(existing) = defs.get(name) {
                    assert_eq!(
                        existing, &def,
                        "{name} reads differently as a {mode} than as a result"
                    );
                }
                defs.insert(name.clone(), def);
            }
        }
        Contract {
            defs,
            decoded,
            methods,
            events,
        }
    }
}

fn text(schema: &Value, key: &str) -> Option<String> {
    schema.get(key).and_then(Value::as_str).map(str::to_string)
}

fn description(schema: &Value) -> Option<String> {
    text(schema, "description").filter(|d| !d.trim().is_empty())
}

fn ty(schema: &Value) -> Ty {
    let unconstrained = |schema: &Map<String, Value>| {
        schema
            .keys()
            .all(|key| matches!(key.as_str(), "description" | "default" | "title"))
    };
    if schema == &Value::Bool(true) || schema.as_object().is_some_and(unconstrained) {
        return Ty::Any;
    }
    if let Some(reference) = text(schema, "$ref") {
        let name = reference
            .strip_prefix("#/$defs/")
            .unwrap_or_else(|| panic!("unexpected reference {reference}"));
        return Ty::Named(name.into());
    }
    if let Some(any_of) = schema.get("anyOf").and_then(Value::as_array) {
        let not_null: Vec<&Value> = any_of
            .iter()
            .filter(|s| s.get("type") != Some(&Value::String("null".into())))
            .collect();
        assert!(
            any_of.len() == 2 && not_null.len() == 1,
            "only `T or null` unions are supported: {schema}"
        );
        return Ty::Nullable(Box::new(ty(not_null[0])));
    }
    match schema.get("type") {
        Some(Value::Array(types)) => {
            let rest: Vec<&Value> = types.iter().filter(|t| *t != "null").collect();
            assert!(
                rest.len() == 1 && types.len() == 2,
                "unsupported type list: {schema}"
            );
            let mut inner = schema.clone();
            inner["type"] = rest[0].clone();
            Ty::Nullable(Box::new(ty(&inner)))
        }
        Some(Value::String(kind)) => match kind.as_str() {
            "string" => Ty::String,
            "boolean" => Ty::Bool,
            "number" => Ty::Double,
            "integer" => Ty::Int {
                wide: text(schema, "format").as_deref() == Some("int64"),
            },
            "array" => Ty::Array(Box::new(ty(schema
                .get("items")
                .unwrap_or_else(|| panic!("an array without items: {schema}"))))),
            "object" => {
                assert!(
                    schema.get("properties").is_none(),
                    "an inline object is not supported; name its type: {schema}"
                );
                match schema.get("additionalProperties") {
                    Some(Value::Bool(false)) | None => Ty::Map(Box::new(Ty::Any)),
                    Some(values) => Ty::Map(Box::new(ty(values))),
                }
            }
            other => panic!("unsupported type {other}: {schema}"),
        },
        _ => panic!("unsupported schema: {schema}"),
    }
}

fn fields(schema: &Value) -> Vec<Field> {
    let required: Vec<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|r| r.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return Vec::new();
    };
    properties
        .iter()
        .map(|(wire, property)| Field {
            wire: wire.clone(),
            ty: ty(property),
            required: required.contains(&wire.as_str()),
            default: property.get("default").cloned(),
            doc: description(property),
        })
        .collect()
}

/// The strings a variant schema stands for: `{"const": v}` or `{"enum": [v…]}`.
fn constants(schema: &Value) -> Vec<String> {
    if let Some(value) = text(schema, "const") {
        return vec![value];
    }
    schema
        .get("enum")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .map(|v| {
                    v.as_str()
                        .unwrap_or_else(|| panic!("a non-string enum: {schema}"))
                        .to_string()
                })
                .collect()
        })
        .unwrap_or_default()
}

fn def(name: &str, schema: &Value) -> Def {
    let doc = description(schema);
    let fallback = text(schema, "x-fallback");
    if schema.get("enum").is_some() {
        return Def::Enum {
            doc,
            cases: constants(schema).into_iter().map(|c| (c, None)).collect(),
            fallback,
        };
    }
    if let Some(one_of) = schema.get("oneOf").and_then(Value::as_array) {
        if one_of
            .iter()
            .all(|s| s.get("type") == Some(&Value::String("string".into())))
        {
            let mut cases = Vec::new();
            for variant in one_of {
                let variant_doc = description(variant);
                for value in constants(variant) {
                    cases.push((value, variant_doc.clone()));
                }
            }
            return Def::Enum {
                doc,
                cases,
                fallback,
            };
        }
        let tags: Vec<(String, String)> = one_of
            .iter()
            .map(|variant| {
                variant["properties"]
                    .as_object()
                    .and_then(|properties| {
                        properties
                            .iter()
                            .find_map(|(key, p)| text(p, "const").map(|c| (key.clone(), c)))
                    })
                    .unwrap_or_else(|| panic!("{name}: a variant without a tag: {variant}"))
            })
            .collect();
        let tag = tags[0].0.clone();
        assert!(
            tags.iter().all(|(t, _)| *t == tag),
            "{name}: variants disagree on the tag"
        );
        let variants = one_of
            .iter()
            .zip(tags)
            .map(|(variant, (_, value))| Variant {
                value,
                doc: description(variant),
                fields: fields(variant)
                    .into_iter()
                    .filter(|f| f.wire != tag)
                    .collect(),
            })
            .collect();
        return Def::Tagged {
            doc,
            tag,
            variants,
            fallback,
        };
    }
    assert_eq!(
        schema.get("type"),
        Some(&Value::String("object".into())),
        "{name}: unsupported definition {schema}"
    );
    Def::Struct {
        doc,
        fields: fields(schema),
    }
}

fn words(raw: &str) -> Vec<String> {
    raw.split(['_', '-', '.', ' '])
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect()
}

fn camel(raw: &str) -> String {
    let mut out = String::new();
    for (i, word) in words(raw).iter().enumerate() {
        if i == 0 {
            out.push_str(word);
        } else {
            let mut chars = word.chars();
            if let Some(first) = chars.next() {
                out.extend(first.to_uppercase());
                out.push_str(chars.as_str());
            }
        }
    }
    out
}

const SWIFT_KEYWORDS: &[&str] = &[
    "associatedtype",
    "class",
    "deinit",
    "enum",
    "extension",
    "func",
    "import",
    "init",
    "inout",
    "internal",
    "let",
    "operator",
    "private",
    "protocol",
    "public",
    "static",
    "struct",
    "subscript",
    "typealias",
    "var",
    "break",
    "case",
    "continue",
    "default",
    "defer",
    "do",
    "else",
    "fallthrough",
    "for",
    "guard",
    "if",
    "in",
    "repeat",
    "return",
    "switch",
    "where",
    "while",
    "as",
    "catch",
    "false",
    "is",
    "nil",
    "rethrows",
    "super",
    "self",
    "throw",
    "throws",
    "true",
    "try",
];

/// A Swift declaration's name, escaped where it is a keyword.
fn swift_name(raw: &str) -> String {
    let name = camel(raw);
    if SWIFT_KEYWORDS.contains(&name.as_str()) {
        format!("`{name}`")
    } else {
        name
    }
}

/// A Swift member as written after `.` or `self.`, where no keyword needs
/// escaping.
fn swift_member(raw: &str) -> String {
    camel(raw)
}

fn swift_type(ty: &Ty) -> String {
    match ty {
        Ty::String => "String".into(),
        Ty::Bool => "Bool".into(),
        Ty::Int { wide: true } => "Int64".into(),
        Ty::Int { wide: false } => "Int".into(),
        Ty::Double => "Double".into(),
        Ty::Any => "JSONValue".into(),
        Ty::Array(item) => format!("[{}]", swift_type(item)),
        Ty::Map(value) => format!("[String: {}]", swift_type(value)),
        Ty::Named(name) => name.clone(),
        Ty::Nullable(inner) => format!("{}?", swift_type(inner)),
    }
}

/// A field's Swift type, and the default it reads as when absent.
fn swift_field(field: &Field) -> (String, Option<String>) {
    match (&field.ty, field.required, &field.default) {
        (Ty::Nullable(_), _, _) | (_, true, _) => (swift_type(&field.ty), None),
        (_, false, Some(default)) => (swift_type(&field.ty), Some(swift_literal(default))),
        (_, false, None) => (format!("{}?", swift_type(&field.ty)), None),
    }
}

fn swift_literal(value: &Value) -> String {
    match value {
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => format!("{s:?}"),
        Value::Array(a) if a.is_empty() => "[]".into(),
        Value::Object(o) if o.is_empty() => "[:]".into(),
        other => panic!("unsupported default {other}"),
    }
}

fn swift_doc(out: &mut String, indent: &str, doc: &Option<String>) {
    for line in doc.iter().flat_map(|d| d.lines()) {
        let line = line.trim_end();
        if line.is_empty() {
            writeln!(out, "{indent}///").unwrap();
        } else {
            writeln!(out, "{indent}/// {line}").unwrap();
        }
    }
}

fn swift_coding_keys(out: &mut String, wires: &[&str]) {
    writeln!(out, "    enum CodingKeys: String, CodingKey {{").unwrap();
    for wire in wires {
        let name = swift_name(wire);
        if camel(wire) == *wire {
            writeln!(out, "        case {name}").unwrap();
        } else {
            writeln!(out, "        case {name} = \"{wire}\"").unwrap();
        }
    }
    writeln!(out, "    }}").unwrap();
}

fn swift_decode_expr(field: &Field) -> String {
    let (ty, default) = swift_field(field);
    let key = swift_member(&field.wire);
    match (ty.strip_suffix('?'), default) {
        (Some(base), _) => format!("try c.decodeIfPresent({base}.self, forKey: .{key})"),
        (None, Some(default)) => {
            format!("try c.decodeIfPresent({ty}.self, forKey: .{key}) ?? {default}")
        }
        (None, None) => format!("try c.decode({ty}.self, forKey: .{key})"),
    }
}

fn swift_encode_stmt(field: &Field, value: &str) -> String {
    let key = swift_member(&field.wire);
    let (ty, _) = swift_field(field);
    if !field.required && ty.ends_with('?') {
        format!("try c.encodeIfPresent({value}, forKey: .{key})")
    } else {
        format!("try c.encode({value}, forKey: .{key})")
    }
}

fn swift_struct(out: &mut String, name: &str, doc: &Option<String>, fields: &[Field]) {
    swift_doc(out, "", doc);
    writeln!(
        out,
        "public struct {name}: Codable, Equatable, Hashable, Sendable {{"
    )
    .unwrap();
    for field in fields {
        swift_doc(out, "    ", &field.doc);
        writeln!(
            out,
            "    public let {}: {}",
            swift_name(&field.wire),
            swift_field(field).0
        )
        .unwrap();
    }
    if !fields.is_empty() {
        writeln!(out).unwrap();
    }
    let arguments: Vec<String> = fields
        .iter()
        .map(|field| {
            let (ty, default) = swift_field(field);
            let default = match default {
                Some(default) => format!(" = {default}"),
                None if ty.ends_with('?') => " = nil".into(),
                None => String::new(),
            };
            format!("{}: {ty}{default}", swift_name(&field.wire))
        })
        .collect();
    writeln!(out, "    public init({}) {{", arguments.join(", ")).unwrap();
    for field in fields {
        writeln!(
            out,
            "        self.{} = {}",
            swift_member(&field.wire),
            swift_name(&field.wire)
        )
        .unwrap();
    }
    writeln!(out, "    }}").unwrap();
    if !fields.is_empty() {
        writeln!(out).unwrap();
        let wires: Vec<&str> = fields.iter().map(|f| f.wire.as_str()).collect();
        swift_coding_keys(out, &wires);
        writeln!(out).unwrap();
        writeln!(out, "    public init(from decoder: Decoder) throws {{").unwrap();
        writeln!(
            out,
            "        let c = try decoder.container(keyedBy: CodingKeys.self)"
        )
        .unwrap();
        for field in fields {
            writeln!(
                out,
                "        self.{} = {}",
                swift_member(&field.wire),
                swift_decode_expr(field)
            )
            .unwrap();
        }
        writeln!(out, "    }}\n").unwrap();
        writeln!(out, "    public func encode(to encoder: Encoder) throws {{").unwrap();
        writeln!(
            out,
            "        var c = encoder.container(keyedBy: CodingKeys.self)"
        )
        .unwrap();
        for field in fields {
            let value = format!("self.{}", swift_member(&field.wire));
            writeln!(out, "        {}", swift_encode_stmt(field, &value)).unwrap();
        }
        writeln!(out, "    }}").unwrap();
    }
    writeln!(out, "}}\n").unwrap();
}

/// The case a decoded enum without a named fallback reads an unknown value
/// as, keeping the value: a core of another version than the app (normal
/// mid-update) can send one, and the rest of its answer must still decode.
const UNKNOWN: &str = "unknown";

fn swift_enum(
    out: &mut String,
    name: &str,
    doc: &Option<String>,
    cases: &[(String, Option<String>)],
    fallback: &Option<String>,
    open: bool,
) {
    if open {
        return swift_open_enum(out, name, doc, cases);
    }
    swift_doc(out, "", doc);
    writeln!(
        out,
        "public enum {name}: String, Codable, CaseIterable, Hashable, Sendable {{"
    )
    .unwrap();
    for (value, case_doc) in cases {
        swift_doc(out, "    ", case_doc);
        let case = swift_name(value);
        if camel(value) == *value {
            writeln!(out, "    case {case}").unwrap();
        } else {
            writeln!(out, "    case {case} = \"{value}\"").unwrap();
        }
    }
    if let Some(fallback) = fallback {
        assert!(
            cases.iter().any(|(value, _)| value == fallback),
            "{name}: the fallback {fallback} is not a case"
        );
        writeln!(out).unwrap();
        writeln!(
            out,
            "    /// A value this build does not know reads as `{fallback}`."
        )
        .unwrap();
        writeln!(out, "    public init(from decoder: Decoder) throws {{").unwrap();
        writeln!(
            out,
            "        self = {name}(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .{}",
            swift_member(fallback)
        )
        .unwrap();
        writeln!(out, "    }}").unwrap();
    }
    writeln!(out, "}}\n").unwrap();
}

/// A string enum whose unknown values read as `unknown(value)`.
fn swift_open_enum(
    out: &mut String,
    name: &str,
    doc: &Option<String>,
    cases: &[(String, Option<String>)],
) {
    assert!(
        cases
            .iter()
            .all(|(value, _)| swift_member(value) != UNKNOWN),
        "{name}: a case named {UNKNOWN} must be its x-fallback"
    );
    swift_doc(out, "", doc);
    writeln!(
        out,
        "public enum {name}: RawRepresentable, Codable, CaseIterable, Hashable, Sendable {{"
    )
    .unwrap();
    for (value, case_doc) in cases {
        swift_doc(out, "    ", case_doc);
        writeln!(out, "    case {}", swift_name(value)).unwrap();
    }
    writeln!(
        out,
        "    /// A value this build does not know, as the core sent it."
    )
    .unwrap();
    writeln!(out, "    case {UNKNOWN}(String)\n").unwrap();
    let all: Vec<String> = cases
        .iter()
        .map(|(value, _)| format!(".{}", swift_member(value)))
        .collect();
    writeln!(
        out,
        "    public static let allCases: [{name}] = [{}]\n",
        all.join(", ")
    )
    .unwrap();
    writeln!(out, "    public init(rawValue: String) {{").unwrap();
    writeln!(out, "        switch rawValue {{").unwrap();
    for (value, _) in cases {
        writeln!(
            out,
            "        case \"{value}\": self = .{}",
            swift_member(value)
        )
        .unwrap();
    }
    writeln!(out, "        default: self = .{UNKNOWN}(rawValue)").unwrap();
    writeln!(out, "        }}").unwrap();
    writeln!(out, "    }}\n").unwrap();
    writeln!(out, "    public var rawValue: String {{").unwrap();
    writeln!(out, "        switch self {{").unwrap();
    for (value, _) in cases {
        writeln!(
            out,
            "        case .{}: return \"{value}\"",
            swift_member(value)
        )
        .unwrap();
    }
    writeln!(out, "        case .{UNKNOWN}(let value): return value").unwrap();
    writeln!(out, "        }}").unwrap();
    writeln!(out, "    }}\n").unwrap();
    writeln!(out, "    public init(from decoder: Decoder) throws {{").unwrap();
    writeln!(
        out,
        "        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))"
    )
    .unwrap();
    writeln!(out, "    }}\n").unwrap();
    writeln!(out, "    public func encode(to encoder: Encoder) throws {{").unwrap();
    writeln!(out, "        var c = encoder.singleValueContainer()").unwrap();
    writeln!(out, "        try c.encode(rawValue)").unwrap();
    writeln!(out, "    }}").unwrap();
    writeln!(out, "}}\n").unwrap();
}

fn swift_tagged(
    out: &mut String,
    name: &str,
    doc: &Option<String>,
    tag: &str,
    variants: &[Variant],
    fallback: &Option<String>,
    open: bool,
) {
    assert!(
        !open || variants.iter().all(|v| swift_member(&v.value) != UNKNOWN),
        "{name}: a variant named {UNKNOWN} must be its x-fallback"
    );
    swift_doc(out, "", doc);
    writeln!(out, "public enum {name}: Codable, Hashable, Sendable {{").unwrap();
    for variant in variants {
        swift_doc(out, "    ", &variant.doc);
        let case = swift_name(&variant.value);
        if variant.fields.is_empty() {
            writeln!(out, "    case {case}").unwrap();
        } else {
            let values: Vec<String> = variant
                .fields
                .iter()
                .map(|f| format!("{}: {}", swift_member(&f.wire), swift_field(f).0))
                .collect();
            writeln!(out, "    case {case}({})", values.join(", ")).unwrap();
        }
    }
    if open {
        writeln!(
            out,
            "    /// A variant this build does not know, by the `{tag}` the core sent."
        )
        .unwrap();
        writeln!(out, "    case {UNKNOWN}(String)").unwrap();
    }
    writeln!(out).unwrap();
    let mut wires: Vec<&str> = vec![tag];
    for variant in variants {
        for field in &variant.fields {
            if !wires.contains(&field.wire.as_str()) {
                wires.push(&field.wire);
            }
        }
    }
    wires.sort();
    swift_coding_keys(out, &wires);
    writeln!(out).unwrap();
    let tag_key = swift_member(tag);
    writeln!(out, "    public init(from decoder: Decoder) throws {{").unwrap();
    writeln!(
        out,
        "        let c = try decoder.container(keyedBy: CodingKeys.self)"
    )
    .unwrap();
    writeln!(
        out,
        "        switch try c.decode(String.self, forKey: .{tag_key}) {{"
    )
    .unwrap();
    for variant in variants {
        let case = swift_member(&variant.value);
        if variant.fields.is_empty() {
            writeln!(out, "        case \"{}\": self = .{case}", variant.value).unwrap();
        } else {
            let values: Vec<String> = variant
                .fields
                .iter()
                .map(|f| format!("{}: {}", swift_member(&f.wire), swift_decode_expr(f)))
                .collect();
            writeln!(
                out,
                "        case \"{}\": self = .{case}({})",
                variant.value,
                values.join(", ")
            )
            .unwrap();
        }
    }
    match fallback {
        Some(fallback) => {
            assert!(
                variants
                    .iter()
                    .any(|v| v.value == *fallback && v.fields.is_empty()),
                "{name}: the fallback {fallback} is not a variant without fields"
            );
            writeln!(out, "        default: self = .{}", swift_member(fallback)).unwrap();
        }
        None if open => writeln!(out, "        case let other: self = .{UNKNOWN}(other)").unwrap(),
        None => writeln!(
            out,
            "        case let other: throw DecodingError.dataCorruptedError(forKey: .{tag_key}, in: c, debugDescription: \"Unknown {name} \\(other).\")"
        )
        .unwrap(),
    }
    writeln!(out, "        }}").unwrap();
    writeln!(out, "    }}\n").unwrap();
    writeln!(out, "    public func encode(to encoder: Encoder) throws {{").unwrap();
    writeln!(
        out,
        "        var c = encoder.container(keyedBy: CodingKeys.self)"
    )
    .unwrap();
    writeln!(out, "        switch self {{").unwrap();
    for variant in variants {
        let case = swift_member(&variant.value);
        if variant.fields.is_empty() {
            writeln!(
                out,
                "        case .{case}: try c.encode(\"{}\", forKey: .{tag_key})",
                variant.value
            )
            .unwrap();
        } else {
            let names: Vec<String> = variant
                .fields
                .iter()
                .map(|f| format!("let {}", swift_name(&f.wire)))
                .collect();
            writeln!(out, "        case .{case}({}):", names.join(", ")).unwrap();
            writeln!(
                out,
                "            try c.encode(\"{}\", forKey: .{tag_key})",
                variant.value
            )
            .unwrap();
            for field in &variant.fields {
                writeln!(
                    out,
                    "            {}",
                    swift_encode_stmt(field, &swift_name(&field.wire))
                )
                .unwrap();
            }
        }
    }
    if open {
        writeln!(
            out,
            "        case .{UNKNOWN}(let value): try c.encode(value, forKey: .{tag_key})"
        )
        .unwrap();
    }
    writeln!(out, "        }}").unwrap();
    writeln!(out, "    }}").unwrap();
    writeln!(out, "}}\n").unwrap();
}

const SWIFT_JSON_VALUE: &str = r#"/// Free JSON, where the contract carries a value it does not shape.
public enum JSONValue: Codable, Hashable, Sendable {
    case null
    case bool(Bool)
    /// A number written without a fraction or exponent, kept exact.
    case integer(Int64)
    /// An integer above `Int64.max`, kept exact.
    case unsigned(UInt64)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let value = try? c.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? c.decode(Int64.self) {
            self = .integer(value)
        } else if let value = try? c.decode(UInt64.self) {
            self = .unsigned(value)
        } else if let value = try? c.decode(Double.self) {
            self = .number(value)
        } else if let value = try? c.decode(String.self) {
            self = .string(value)
        } else if let value = try? c.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try c.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let value): try c.encode(value)
        case .integer(let value): try c.encode(value)
        case .unsigned(let value): try c.encode(value)
        case .number(let value): try c.encode(value)
        case .string(let value): try c.encode(value)
        case .array(let value): try c.encode(value)
        case .object(let value): try c.encode(value)
        }
    }
}
"#;

impl Contract {
    /// Whether `name` is an enum the client decodes without a named
    /// fallback, so an unknown value reads as `unknown(value)`.
    fn open(&self, name: &str) -> bool {
        self.decoded.contains(name)
            && match self.defs.get(name) {
                Some(Def::Enum { fallback, .. } | Def::Tagged { fallback, .. }) => {
                    fallback.is_none()
                }
                _ => false,
            }
    }

    /// `CoreContract.swift`.
    pub fn swift(&self) -> String {
        let mut out = String::new();
        writeln!(
            out,
            "// The relay core's bridge contract for the macOS app.\n//\n\
             // Generated from the Rust contract registry (probe/src/relay/contract).\n\
             // Do not edit; regenerate with `{REGENERATE}`.\n"
        )
        .unwrap();
        out.push_str("import Foundation\n\n");
        writeln!(out, "/// The bridge contract version this app speaks.").unwrap();
        writeln!(out, "public enum CoreBridgeVersion {{").unwrap();
        writeln!(out, "    public static let current = {BRIDGE_VERSION}").unwrap();
        writeln!(out, "}}\n").unwrap();
        writeln!(out, "/// Every bridge method's wire name.").unwrap();
        writeln!(out, "public enum CoreMethod {{").unwrap();
        writeln!(
            out,
            "    /// The JSON-RPC notification every event travels under."
        )
        .unwrap();
        writeln!(out, "    public static let event = \"{EVENT_METHOD}\"").unwrap();
        for method in &self.methods {
            writeln!(
                out,
                "    public static let {} = \"{}\"",
                swift_name(method.name),
                method.name
            )
            .unwrap();
        }
        writeln!(out, "}}\n").unwrap();
        out.push_str(SWIFT_JSON_VALUE);
        out.push('\n');
        for (name, def) in &self.defs {
            match def {
                Def::Struct { doc, fields } => swift_struct(&mut out, name, doc, fields),
                Def::Enum {
                    doc,
                    cases,
                    fallback,
                } => swift_enum(&mut out, name, doc, cases, fallback, self.open(name)),
                Def::Tagged {
                    doc,
                    tag,
                    variants,
                    fallback,
                } => swift_tagged(
                    &mut out,
                    name,
                    doc,
                    tag,
                    variants,
                    fallback,
                    self.open(name),
                ),
            }
        }
        writeln!(out, "/// One event the core published, by topic.").unwrap();
        writeln!(out, "public enum CoreEvent: Sendable {{").unwrap();
        for (topic, data) in &self.events {
            writeln!(out, "    case {}({})", swift_name(topic), swift_type(data)).unwrap();
        }
        writeln!(out).unwrap();
        writeln!(
            out,
            "    /// The event `topic` carries, or nil for a topic or payload this build\n    /// does not read."
        )
        .unwrap();
        writeln!(
            out,
            "    public static func decode(topic: String, data: Data) -> CoreEvent? {{"
        )
        .unwrap();
        writeln!(out, "        let decoder = JSONDecoder()").unwrap();
        writeln!(out, "        switch Topic(rawValue: topic) {{").unwrap();
        for (topic, data) in &self.events {
            let case = swift_member(topic);
            writeln!(
                out,
                "        case .{case}: return (try? decoder.decode({}.self, from: data)).map(CoreEvent.{case})",
                swift_type(data)
            )
            .unwrap();
        }
        let unread = if self.open("Topic") {
            format!("case .{UNKNOWN}")
        } else {
            "case nil".to_string()
        };
        writeln!(out, "        {unread}: return nil").unwrap();
        writeln!(out, "        }}").unwrap();
        writeln!(out, "    }}").unwrap();
        writeln!(out, "}}\n").unwrap();
        writeln!(
            out,
            "/// One typed call per method a pooled connection answers."
        )
        .unwrap();
        writeln!(out, "extension CoreClient {{").unwrap();
        let calls: Vec<String> = self
            .methods
            .iter()
            .filter(|method| !CONNECTION_METHODS.contains(&method.name))
            .map(|method| {
                let availability = match method.availability {
                    Availability::Always => "",
                    Availability::Account => "; only a core built with an account answers it",
                };
                let name = swift_name(method.name);
                let result = swift_type(&method.result);
                let (signature, params) = match &method.params {
                    Ty::Named(n) if n == "NoParams" => (String::new(), "NoParams()".to_string()),
                    params => (
                        format!("_ params: {}", swift_type(params)),
                        "params".to_string(),
                    ),
                };
                format!(
                    "    /// `{}`{availability}.\n    \
                     @discardableResult\n    \
                     public func {name}({signature}) async throws -> {result} {{\n        \
                     try await call(CoreMethod.{name}, {params})\n    }}\n",
                    method.name
                )
            })
            .collect();
        out.push_str(&calls.join("\n"));
        writeln!(out, "}}").unwrap();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn repository() -> &'static Path {
        Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap()
    }

    #[test]
    fn the_checked_in_client_matches_the_registry() {
        let generated = Contract::collect().swift();
        // A Windows checkout may hold the file with CRLF line endings.
        let checked_in = std::fs::read_to_string(repository().join(SWIFT_PATH))
            .unwrap()
            .replace("\r\n", "\n");
        assert!(
            checked_in == generated,
            "{SWIFT_PATH} is stale; run {REGENERATE}"
        );
    }

    /// A core of another version than the app can send a value the app's
    /// build does not know; every enum a client decodes must still read it.
    #[test]
    fn every_enum_a_client_decodes_reads_unknown_values() {
        let contract = Contract::collect();
        for name in &contract.decoded {
            let mut out = String::new();
            match &contract.defs[name] {
                Def::Enum {
                    doc,
                    cases,
                    fallback,
                } => swift_enum(&mut out, name, doc, cases, fallback, contract.open(name)),
                Def::Tagged {
                    doc,
                    tag,
                    variants,
                    fallback,
                } => swift_tagged(
                    &mut out,
                    name,
                    doc,
                    tag,
                    variants,
                    fallback,
                    contract.open(name),
                ),
                Def::Struct { .. } => continue,
            }
            assert!(
                out.contains("public init(from decoder: Decoder)") && !out.contains("throw "),
                "{name} rejects a value it does not know:\n{out}"
            );
        }
        assert!(contract.open("Topic") && contract.open("AccountAction"));
    }

    #[test]
    fn generation_is_deterministic() {
        let (a, b) = (Contract::collect(), Contract::collect());
        assert_eq!(a.swift(), b.swift());
    }

    #[test]
    fn names_map_to_swift() {
        assert_eq!(camel("account.sign_in.cancel"), "accountSignInCancel");
        assert_eq!(camel("claude-terminal"), "claudeTerminal");
        assert_eq!(swift_name("where"), "`where`");
    }
}
