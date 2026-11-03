//! The command-line copy of the probe in `~/.local/bin`, so people who
//! prefer the terminal run the same build the app does.
//!
//! The copy is only ever upgraded: a newer one, from a newer app, may be
//! running this computer's collector. On macOS a copy not signed like this
//! binary is never run to read its version and never replaced: it is not
//! one this app installed.

use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// A probe build's release number.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Release {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    /// Dot-separated prerelease identifiers; empty for a release.
    pub prerelease: Vec<String>,
}

impl Release {
    /// Reads `0.26.2`, `0.27.0-rc.1`, `1.0.0+build.5`, or
    /// `agent-relay-probe 0.26.2` as `--version` prints it. Build metadata
    /// does not order releases.
    pub fn parse(text: &str) -> Option<Release> {
        let word = text.split_whitespace().last()?;
        let version = word.split('+').next()?;
        let (numbers, prerelease) = match version.split_once('-') {
            Some((numbers, pre)) => (numbers, Some(pre)),
            None => (version, None),
        };
        let parts: Vec<u64> = numbers
            .split('.')
            .map(|part| part.parse().ok())
            .collect::<Option<_>>()?;
        let [major, minor, patch] = parts[..] else {
            return None;
        };
        let prerelease: Vec<String> = match prerelease {
            Some(pre) => pre.split('.').map(str::to_string).collect(),
            None => Vec::new(),
        };
        if prerelease.iter().any(String::is_empty) {
            return None;
        }
        Some(Release {
            major,
            minor,
            patch,
            prerelease,
        })
    }
}

impl PartialOrd for Release {
    fn partial_cmp(&self, other: &Release) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Release {
    /// Semver precedence: release numbers, then a prerelease below its
    /// release, then identifiers in turn (numeric below alphanumeric,
    /// numbers by value), then the shorter list first.
    fn cmp(&self, other: &Release) -> Ordering {
        let numbers =
            (self.major, self.minor, self.patch).cmp(&(other.major, other.minor, other.patch));
        if numbers != Ordering::Equal {
            return numbers;
        }
        match (self.prerelease.is_empty(), other.prerelease.is_empty()) {
            (true, true) => return Ordering::Equal,
            (true, false) => return Ordering::Greater,
            (false, true) => return Ordering::Less,
            (false, false) => {}
        }
        for (left, right) in self.prerelease.iter().zip(&other.prerelease) {
            let order = match (left.parse::<u64>(), right.parse::<u64>()) {
                (Ok(left), Ok(right)) => left.cmp(&right),
                (Ok(_), Err(_)) => Ordering::Less,
                (Err(_), Ok(_)) => Ordering::Greater,
                (Err(_), Err(_)) => left.cmp(right),
            };
            if order != Ordering::Equal {
                return order;
            }
        }
        self.prerelease.len().cmp(&other.prerelease.len())
    }
}

/// Whether a copy reporting `installed` is replaced by one reporting
/// `bundled`: when it is missing, unreadable, or older.
pub fn should_replace(installed: Option<&Release>, bundled: Option<&Release>) -> bool {
    match (installed, bundled) {
        (installed, None) => installed.is_none(),
        (None, Some(_)) => true,
        (Some(installed), Some(bundled)) => installed < bundled,
    }
}

/// `~/.local/bin/agent-relay-probe` (`agent-relay-probe.exe` on Windows,
/// which runs only files with a `PATHEXT` extension).
pub fn destination(home: &Path) -> PathBuf {
    let name = if cfg!(windows) {
        "agent-relay-probe.exe"
    } else {
        "agent-relay-probe"
    };
    home.join(".local").join("bin").join(name)
}

fn sha256(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => hasher.update(&buffer[..count]),
            Err(_) => return None,
        }
    }
    Some(format!("{:x}", hasher.finalize()))
}

/// The release an executable reports with `--version`, or `None` when it
/// does not answer with one within five seconds.
pub fn release_of(path: &Path) -> Option<Release> {
    let mut command = Command::new(path);
    crate::platform::process::hide_window(&mut command);
    let mut child = command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) | Err(_) => return None,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    let mut output = String::new();
    child.stdout.take()?.read_to_string(&mut output).ok()?;
    Release::parse(output.trim())
}

/// Whether `candidate` is signed to `reference`'s designated requirement:
/// the same program from the same developer. Linux has no code signing,
/// and every copy counts as this app's.
pub fn signed_like(candidate: &Path, reference: &Path) -> bool {
    if cfg!(not(target_os = "macos")) {
        return true;
    }
    let Ok(requirement) = Command::new("/usr/bin/codesign")
        .args(["--display", "--requirements", "-"])
        .arg(reference)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    else {
        return false;
    };
    let text = String::from_utf8_lossy(&requirement.stdout);
    let Some(designated) = text
        .lines()
        .find_map(|line| line.trim().strip_prefix("designated => "))
    else {
        return false;
    };
    Command::new("/usr/bin/codesign")
        .args([
            "--verify",
            "--all-architectures",
            &format!("-R={designated}"),
        ])
        .arg(candidate)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// The DLLs a PE image imports by name (its import directory), as written
/// in it; empty for anything that is not a PE image.
fn pe_imports(image: &[u8]) -> Vec<String> {
    let u16_at = |at: usize| {
        image
            .get(at..at.checked_add(2)?)
            .map(|b| u16::from_le_bytes([b[0], b[1]]) as usize)
    };
    let u32_at = |at: usize| {
        image
            .get(at..at.checked_add(4)?)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize)
    };
    let read = || -> Option<Vec<String>> {
        if image.get(..2)? != b"MZ" {
            return None;
        }
        let pe = u32_at(0x3c)?;
        if image.get(pe..pe + 4)? != b"PE\0\0" {
            return None;
        }
        let coff = pe + 4;
        let sections = u16_at(coff + 2)?;
        let optional = coff + 20;
        let optional_size = u16_at(coff + 16)?;
        // The data directories follow PE32's 96 or PE32+'s 112 bytes.
        let directories = optional
            + match u16_at(optional)? {
                0x10b => 96,
                0x20b => 112,
                _ => return None,
            };
        let imports = u32_at(directories + 8)?;
        if imports == 0 {
            return Some(Vec::new());
        }
        let table = optional + optional_size;
        let offset_of = |rva: usize| -> Option<usize> {
            (0..sections).find_map(|index| {
                let header = table + index * 40;
                let size = u32_at(header + 8)?.max(u32_at(header + 16)?);
                let address = u32_at(header + 12)?;
                (rva >= address && rva < address + size)
                    .then(|| rva - address + u32_at(header + 20).unwrap_or(0))
            })
        };
        let mut names = Vec::new();
        let mut descriptor = offset_of(imports)?;
        // At most a few hundred imports; a malformed table stops here.
        for _ in 0..1024 {
            let entry = image.get(descriptor..descriptor + 20)?;
            if entry.iter().all(|byte| *byte == 0) {
                break;
            }
            let name = offset_of(u32_at(descriptor + 12)?)?;
            let end = image.get(name..)?.iter().position(|byte| *byte == 0)?;
            names.push(String::from_utf8_lossy(&image[name..name + end]).into_owned());
            descriptor += 20;
        }
        Some(names)
    };
    read().unwrap_or_default()
}

/// The DLLs beside `executable` that it loads, directly or through another
/// of them: the libraries a gnullvm build needs (`libunwind.dll` and the
/// like), not the rest of the folder (the app's GTK runtime). System DLLs
/// are not beside it and are never taken.
fn libraries_beside(executable: &Path) -> Vec<PathBuf> {
    let Some(directory) = executable.parent() else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = Vec::new();
    let mut pending = vec![executable.to_path_buf()];
    while let Some(image) = pending.pop() {
        let Ok(bytes) = fs::read(&image) else {
            continue;
        };
        for name in pe_imports(&bytes) {
            let path = directory.join(&name);
            let seen = found.iter().any(|known| {
                known
                    .file_name()
                    .is_some_and(|known| known.eq_ignore_ascii_case(name.as_str()))
            });
            if !seen && path.is_file() {
                found.push(path.clone());
                pending.push(path);
            }
        }
    }
    found.sort();
    found
}

/// The DLLs the command-line copy needs beside it: on Windows those
/// `libraries_beside` the source (the copy fails to start without them
/// outside an MSYS2 shell); none elsewhere.
fn libraries(source: &Path) -> Vec<PathBuf> {
    if cfg!(windows) {
        libraries_beside(source)
    } else {
        Vec::new()
    }
}

/// Beside the copy: the DLL names this app last copied there, one a line,
/// so one a later build no longer needs is removed and no other is.
const LIBRARIES_LIST: &str = ".agent-relay-probe.dlls";

/// Copies `path` to `target` through a temporary file beside it, so a
/// reader never sees half of it.
fn copy_into(path: &Path, target: &Path, mode: u32) -> std::io::Result<()> {
    let directory = target.parent().unwrap_or(Path::new("."));
    let temporary = directory.join(format!(".agent-relay-probe.{}.tmp", std::process::id()));
    let result = (|| {
        let _ = fs::remove_file(&temporary);
        fs::copy(path, &temporary)?;
        crate::platform::fs::set_mode(&temporary, mode)?;
        fs::rename(&temporary, target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// Puts `libraries` beside `destination`, each one missing or different,
/// and removes those this app copied before that are no longer among them.
/// Returns whether anything changed.
fn install_libraries(libraries: &[PathBuf], destination: &Path) -> std::io::Result<bool> {
    let Some(directory) = destination.parent() else {
        return Ok(false);
    };
    let list = directory.join(LIBRARIES_LIST);
    let previous = fs::read_to_string(&list).unwrap_or_default();
    let names: Vec<String> = libraries
        .iter()
        .filter_map(|path| Some(path.file_name()?.to_string_lossy().into_owned()))
        .collect();
    if libraries.is_empty() && previous.is_empty() {
        return Ok(false);
    }
    fs::create_dir_all(directory)?;
    let mut changed = false;
    for (library, name) in libraries.iter().zip(&names) {
        let target = directory.join(name);
        if sha256(&target).is_some_and(|hash| Some(hash) == sha256(library)) {
            continue;
        }
        copy_into(library, &target, 0o755)?;
        changed = true;
    }
    for stale in previous.lines().map(str::trim).filter(|line| {
        !line.is_empty()
            && !line.contains(['/', '\\'])
            && !names.iter().any(|name| name.eq_ignore_ascii_case(line))
    }) {
        if fs::remove_file(directory.join(stale)).is_ok() {
            changed = true;
        }
    }
    let listed: String = names.iter().map(|name| format!("{name}\n")).collect();
    if listed != previous {
        if listed.is_empty() {
            let _ = fs::remove_file(&list);
        } else {
            fs::write(&list, listed)?;
        }
    }
    Ok(changed)
}

/// Copies `source` to `destination` when that copy is missing, unreadable
/// or older, and is one this app installed (`trusts`), with the DLLs it
/// needs on Windows. Returns whether a copy was made. Blocking.
pub fn install_if_needed(
    source: &Path,
    destination: &Path,
    trusts: impl Fn(&Path, &Path) -> bool,
) -> bool {
    if !source.is_file() {
        return false;
    }
    let libraries = libraries(source);
    if destination.exists() {
        if sha256(destination).is_some_and(|hash| Some(hash) == sha256(source)) {
            // The same build: only its DLLs may be missing (a copy made
            // before they were copied too) or out of date.
            return install_libraries(&libraries, destination).unwrap_or(false);
        }
        if !trusts(destination, source) {
            return false;
        }
        if !should_replace(
            release_of(destination).as_ref(),
            release_of(source).as_ref(),
        ) {
            return false;
        }
    }
    let Some(directory) = destination.parent() else {
        return false;
    };
    // The DLLs first, so the new copy never starts without them.
    let result = fs::create_dir_all(directory)
        .and_then(|()| install_libraries(&libraries, destination))
        .and_then(|_| copy_into(source, destination, 0o755));
    result.is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `#!/bin/sh` stand-in that prints `version`, which Windows cannot run.
    #[cfg(unix)]
    fn fake(dir: &Path, name: &str, version: &str, marker: Option<&Path>) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        let touch = marker
            .map(|m| format!("touch '{}'\n", m.display()))
            .unwrap_or_default();
        fs::write(
            &path,
            format!("#!/bin/sh\n{touch}echo 'agent-relay-probe {version}'\n"),
        )
        .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn release(text: &str) -> Release {
        Release::parse(text).unwrap()
    }

    #[test]
    fn reads_version_output_and_orders_by_release() {
        assert_eq!(release("agent-relay-probe 0.26.2"), release("0.26.2"));
        assert_eq!(release("1.2.3+build.5"), release("1.2.3"));
        assert_eq!(release("1.2.3-beta.1").prerelease, ["beta", "1"]);
        for bad in ["1.2.3-", "unknown", "1.2", "1.2.x"] {
            assert!(Release::parse(bad).is_none(), "{bad}");
        }
        assert!(release("0.26.0") < release("0.26.2"));
        assert!(release("0.9.9") < release("0.26.0"));
    }

    #[test]
    fn a_prerelease_precedes_its_release_in_semver_order() {
        let ordered = [
            "0.26.2",
            "1.0.0-alpha",
            "1.0.0-alpha.1",
            "1.0.0-alpha.beta",
            "1.0.0-beta",
            "1.0.0-beta.2",
            "1.0.0-beta.11",
            "1.0.0-rc.1",
            "1.0.0",
        ]
        .map(release);
        for pair in ordered.windows(2) {
            assert!(pair[0] < pair[1], "{:?} < {:?}", pair[0], pair[1]);
            assert!(pair[1] >= pair[0]);
        }
        assert!(should_replace(
            Some(&release("1.0.0-rc.1")),
            Some(&release("1.0.0"))
        ));
        assert!(!should_replace(
            Some(&release("1.0.0")),
            Some(&release("1.0.0-rc.1"))
        ));
    }

    #[test]
    fn only_an_older_or_unreadable_copy_is_replaced() {
        let (older, newer) = (release("0.26.0"), release("0.26.2"));
        assert!(should_replace(Some(&older), Some(&newer)));
        assert!(should_replace(None, Some(&newer)));
        assert!(!should_replace(Some(&newer), Some(&older)));
        assert!(!should_replace(Some(&newer), Some(&newer)));
        assert!(!should_replace(Some(&newer), None));
        assert!(should_replace(None, None));
    }

    #[test]
    #[cfg(unix)]
    fn a_copy_this_app_did_not_install_is_left_unrun() {
        let dir = tempfile::tempdir().unwrap();
        let bundled = fake(dir.path(), "bundled", "0.26.2", None);
        let marker = dir.path().join("ran");
        let installed = fake(dir.path(), "installed", "0.26.0", Some(&marker));
        assert!(!install_if_needed(&bundled, &installed, |_, _| false));
        assert!(!marker.exists());
    }

    #[test]
    #[cfg(unix)]
    fn the_command_line_copy_is_never_downgraded() {
        let dir = tempfile::tempdir().unwrap();
        let bundled = fake(dir.path(), "bundled", "0.26.0", None);
        let installed = fake(dir.path(), "installed", "0.26.2", None);
        assert!(!install_if_needed(&bundled, &installed, |_, _| true));
        assert_eq!(release_of(&installed), Some(release("0.26.2")));
    }

    #[test]
    #[cfg(unix)]
    fn a_missing_or_older_copy_is_replaced_and_an_identical_one_kept() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let bundled = fake(dir.path(), "bundled", "0.26.2", None);
        let destination = dir.path().join("bin/agent-relay-probe");
        assert!(install_if_needed(&bundled, &destination, |_, _| true));
        assert_eq!(release_of(&destination), Some(release("0.26.2")));
        assert_eq!(
            fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
            0o755
        );
        assert!(!install_if_needed(&bundled, &destination, |_, _| panic!(
            "identical copies are not checked"
        )));
        let older = fake(dir.path(), "older", "0.25.0", None);
        fs::copy(&older, &destination).unwrap();
        assert!(install_if_needed(&bundled, &destination, |_, _| true));
        assert_eq!(release_of(&destination), Some(release("0.26.2")));
    }

    /// A minimal PE32+ image importing `imports`, with `tag` in it so
    /// builds differ.
    fn fake_pe(imports: &[&str], tag: &str) -> Vec<u8> {
        let mut image = vec![0u8; 0x200];
        image[..2].copy_from_slice(b"MZ");
        image[0x3c..0x40].copy_from_slice(&0x40u32.to_le_bytes());
        image[0x40..0x44].copy_from_slice(b"PE\0\0");
        let coff = 0x44;
        image[coff + 2..coff + 4].copy_from_slice(&1u16.to_le_bytes());
        image[coff + 16..coff + 18].copy_from_slice(&0xf0u16.to_le_bytes());
        let optional = coff + 20;
        image[optional..optional + 2].copy_from_slice(&0x20bu16.to_le_bytes());
        // One section: RVA 0x1000 at file offset 0x200.
        let mut section = Vec::new();
        let descriptors = (imports.len() + 1) * 20;
        let mut names = Vec::new();
        for import in imports {
            let rva = 0x1000 + descriptors + names.len();
            let mut descriptor = [0u8; 20];
            descriptor[12..16].copy_from_slice(&(rva as u32).to_le_bytes());
            section.extend_from_slice(&descriptor);
            names.extend_from_slice(import.as_bytes());
            names.push(0);
        }
        section.extend_from_slice(&[0u8; 20]);
        section.extend_from_slice(&names);
        section.extend_from_slice(tag.as_bytes());
        let directory = optional + 112 + 8;
        image[directory..directory + 4].copy_from_slice(&0x1000u32.to_le_bytes());
        image[directory + 4..directory + 8].copy_from_slice(&(descriptors as u32).to_le_bytes());
        let header = optional + 0xf0;
        let size = (section.len() as u32).to_le_bytes();
        image[header + 8..header + 12].copy_from_slice(&size);
        image[header + 12..header + 16].copy_from_slice(&0x1000u32.to_le_bytes());
        image[header + 16..header + 20].copy_from_slice(&size);
        image[header + 20..header + 24].copy_from_slice(&0x200u32.to_le_bytes());
        image.extend_from_slice(&section);
        image
    }

    #[test]
    fn the_libraries_an_executable_loads_are_read_from_its_imports() {
        assert_eq!(
            pe_imports(&fake_pe(&["libunwind.dll", "KERNEL32.dll"], "")),
            ["libunwind.dll", "KERNEL32.dll"]
        );
        assert!(pe_imports(b"#!/bin/sh\n").is_empty());
        assert!(pe_imports(&fake_pe(&[], "")).is_empty());

        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        fs::create_dir_all(&bin).unwrap();
        let probe = bin.join("agent-relay-probe.exe");
        fs::write(&probe, fake_pe(&["libunwind.dll", "KERNEL32.dll"], "")).unwrap();
        fs::write(bin.join("libunwind.dll"), fake_pe(&["libc++.dll"], "")).unwrap();
        fs::write(bin.join("libc++.dll"), fake_pe(&["libunwind.dll"], "")).unwrap();
        // The app's GTK runtime beside it is not the probe's.
        fs::write(bin.join("libgtk-4-1.dll"), fake_pe(&[], "")).unwrap();
        assert_eq!(
            libraries_beside(&probe),
            [bin.join("libc++.dll"), bin.join("libunwind.dll")]
        );
    }

    /// On Windows the copy takes the DLLs it loads, fills in those an
    /// earlier copy of the same build lacks, and removes one a later build
    /// no longer needs.
    #[test]
    #[cfg(windows)]
    fn the_windows_copy_takes_the_libraries_it_needs() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("app/bin");
        fs::create_dir_all(&bin).unwrap();
        let probe = bin.join("agent-relay-probe.exe");
        fs::write(&probe, fake_pe(&["libunwind.dll", "KERNEL32.dll"], "1")).unwrap();
        fs::write(bin.join("libunwind.dll"), fake_pe(&[], "1")).unwrap();
        fs::write(bin.join("libgtk-4-1.dll"), fake_pe(&[], "")).unwrap();
        let destination = destination(&dir.path().join("home"));
        let local = destination.parent().unwrap().to_path_buf();

        assert!(install_if_needed(&probe, &destination, |_, _| true));
        assert_eq!(fs::read(&destination).unwrap(), fs::read(&probe).unwrap());
        assert!(local.join("libunwind.dll").is_file());
        assert!(!local.join("libgtk-4-1.dll").exists());

        // A copy made before the DLLs were copied gets them.
        fs::remove_file(local.join("libunwind.dll")).unwrap();
        assert!(install_if_needed(&probe, &destination, |_, _| panic!(
            "identical copies are not checked"
        )));
        assert!(local.join("libunwind.dll").is_file());
        assert!(!install_if_needed(&probe, &destination, |_, _| true));

        // A changed DLL of the same build is replaced; one the build no
        // longer loads is removed, and one this app never copied is kept.
        fs::write(bin.join("libunwind.dll"), fake_pe(&[], "2")).unwrap();
        fs::write(local.join("theirs.dll"), "x").unwrap();
        assert!(install_if_needed(&probe, &destination, |_, _| true));
        assert_eq!(
            fs::read(local.join("libunwind.dll")).unwrap(),
            fs::read(bin.join("libunwind.dll")).unwrap()
        );
        fs::write(&probe, fake_pe(&["KERNEL32.dll"], "1")).unwrap();
        fs::copy(&probe, &destination).unwrap();
        assert!(install_if_needed(&probe, &destination, |_, _| true));
        assert!(!local.join("libunwind.dll").exists());
        assert!(local.join("theirs.dll").is_file());
    }

    #[test]
    fn nothing_is_installed_without_a_source() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!install_if_needed(
            &dir.path().join("none"),
            &dir.path().join("dest"),
            |_, _| true
        ));
    }
}
