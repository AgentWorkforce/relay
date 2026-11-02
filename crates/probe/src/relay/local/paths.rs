//! Path spellings for the auto-activation exclusion list: `~` expansion and
//! whether a session folder lies under an excluded root.
use std::path::{Component, Path, PathBuf};

pub(super) fn expand_path(value: &str, home: &Path) -> PathBuf {
    value
        .strip_prefix("~/")
        .map(|rest| home.join(rest))
        .unwrap_or_else(|| {
            if value == "~" {
                home.to_path_buf()
            } else {
                PathBuf::from(value)
            }
        })
}

/// A lexical absolute spelling, so a missing path cannot bypass a temporary
/// root merely because `canonicalize` needs it to exist.
fn normalized(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => result.push(prefix.as_os_str()),
            Component::RootDir => result.push(Path::new("/")),
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            Component::Normal(part) => result.push(part),
        }
    }
    result
}

fn path_variants(path: &Path) -> Vec<PathBuf> {
    let lexical = normalized(path);
    let mut paths = vec![lexical.clone()];
    if let Ok(resolved) = std::fs::canonicalize(path) {
        let resolved = normalized(&resolved);
        if resolved != lexical {
            paths.push(resolved);
        }
    }
    paths
}

pub(super) fn is_under(path: &Path, roots: &[PathBuf]) -> bool {
    let paths = path_variants(path);
    let roots: Vec<PathBuf> = roots.iter().flat_map(|root| path_variants(root)).collect();
    paths
        .iter()
        .any(|candidate| roots.iter().any(|root| candidate.starts_with(root)))
}
