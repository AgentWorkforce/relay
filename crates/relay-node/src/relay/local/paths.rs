//! Path spellings for the auto-activation exclusion list: `~` expansion and
//! whether a session folder lies under an excluded root.
use std::path::{Component, Path, PathBuf};

/// `value` with a leading `~` expanded, or `None` when it is not absolute:
/// a relative root would never match a session folder, which is.
pub(super) fn expand_path(value: &str, home: &Path) -> Option<PathBuf> {
    let path = value
        .strip_prefix("~/")
        .map(|rest| home.join(rest))
        .unwrap_or_else(|| {
            if value == "~" {
                home.to_path_buf()
            } else {
                PathBuf::from(value)
            }
        });
    path.is_absolute().then_some(path)
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
            // `..` above a relative start is kept, never dropped.
            Component::ParentDir => {
                if matches!(result.components().next_back(), Some(Component::Normal(_))) {
                    result.pop();
                } else if !result.has_root() {
                    result.push("..");
                }
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn a_relative_or_home_entry_is_read_as_absolute_or_dropped() {
        let home = Path::new("/home/someone");
        assert_eq!(expand_path("~/tmp", home), Some(home.join("tmp")));
        assert_eq!(
            expand_path("/var/tmp", home),
            Some(PathBuf::from("/var/tmp"))
        );
        assert_eq!(expand_path("tmp", home), None);
        assert_eq!(expand_path("../tmp", home), None);
    }

    #[test]
    fn a_leading_parent_is_kept() {
        assert_eq!(normalized(Path::new("../tmp/x")), PathBuf::from("../tmp/x"));
        assert_eq!(normalized(Path::new("/a/../../b")), PathBuf::from("/b"));
    }

    #[test]
    fn symlinked_and_missing_folders_are_matched() {
        let temp = tempfile::tempdir().unwrap();
        let real = temp.path().join("real");
        std::fs::create_dir_all(real.join("session")).unwrap();
        let link = temp.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        // A root reached through a symlink.
        assert!(is_under(&real.join("session"), std::slice::from_ref(&link)));
        // A session folder reached through a symlink.
        assert!(is_under(&link.join("session"), std::slice::from_ref(&real)));
        // A folder that does not exist (yet) under the root.
        assert!(is_under(
            &real.join("missing/deeper"),
            std::slice::from_ref(&real)
        ));
        assert!(!is_under(&temp.path().join("elsewhere"), &[real]));
    }
}
