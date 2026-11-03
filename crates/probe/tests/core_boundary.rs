//! The core builds without the app: nothing in the core names the `gtk/`
//! crate, and its manifest does not depend on it.

use std::fs;
use std::path::{Path, PathBuf};

fn rust_files(directory: &Path, found: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, found);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            found.push(path);
        }
    }
}

#[test]
fn the_core_does_not_reach_into_the_app() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = vec![root.join("build.rs"), root.join("build_version.rs")];
    rust_files(&root.join("src"), &mut files);
    rust_files(&root.join("examples"), &mut files);
    let reaching: Vec<_> = files
        .iter()
        .filter(|file| {
            let text = fs::read_to_string(file).unwrap();
            text.contains("linux_app")
                || text.contains("agent_relay_app")
                || text.contains("../gtk")
        })
        .collect();
    assert!(reaching.is_empty(), "{reaching:#?}");
    let manifest = fs::read_to_string(root.join("Cargo.toml")).unwrap();
    assert!(!manifest.contains("agent-relay-app"));
}
