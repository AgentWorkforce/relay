/// Stamp local builds with one development identifier and one Git revision.
pub fn development_version(release: &str, revision: &str) -> String {
    // Changelog headings may name a release candidate or include build metadata.
    // Keep only the release core so local builds remain `dev`, compare below an
    // RC, and can replace other Git revisions without ordering hashes.
    let core = release.trim().split(['-', '+']).next().unwrap();
    format!("{core}-dev+{revision}")
}
