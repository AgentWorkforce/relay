/// Case-insensitive comparison for agent names.
///
/// Agent names may have inconsistent casing across registration, WebSocket
/// events, and API responses. Centralising the comparison here prevents
/// recurrences of the case-sensitivity routing bugs that the codebase has
/// hit when each call site rolled its own comparison.
pub(crate) fn agent_name_eq(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// Check whether *any* of the `self_names` match `name` (case-insensitive).
pub(crate) fn is_self_name<'a, I>(self_names: I, name: &str) -> bool
where
    I: IntoIterator<Item = &'a String>,
{
    self_names.into_iter().any(|n| agent_name_eq(n, name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_name_eq_case_insensitive() {
        assert!(agent_name_eq("Alice", "alice"));
        assert!(agent_name_eq("alice", "ALICE"));
        assert!(agent_name_eq("Worker-1", "worker-1"));
        assert!(!agent_name_eq("Alice", "Bob"));
    }

    #[test]
    fn agent_name_eq_empty_strings() {
        assert!(agent_name_eq("", ""));
        assert!(!agent_name_eq("", "Alice"));
    }

    #[test]
    fn is_self_name_matches_any() {
        let names = vec!["Alice".to_string(), "alice-dev".to_string()];
        assert!(is_self_name(&names, "alice"));
        assert!(is_self_name(&names, "ALICE"));
        assert!(is_self_name(&names, "Alice-Dev"));
        assert!(!is_self_name(&names, "Bob"));
    }

    #[test]
    fn is_self_name_empty_list() {
        let names: Vec<String> = vec![];
        assert!(!is_self_name(&names, "Alice"));
    }
}
