//! GitHub Copilot desktop's signed Tauri host and downloaded SDK runtime.
use crate::relay::process::{ProcessInfo, ProcessTable};
use std::path::Path;

/// Desktop 1.4.2 starts `copilot-runtime --server --stdio` directly. Each
/// runtime can hold several native chats; the usual held-inode check still
/// selects the chat, never the process alone.
pub(super) fn runtime(
    table: &dyn ProcessTable,
    process: ProcessInfo,
    exe: &Path,
) -> Option<ProcessInfo> {
    let home = crate::relay::paths::home().ok()?;
    runtime_with_home(table, process, exe, &home)
}

fn runtime_with_home(
    table: &dyn ProcessTable,
    process: ProcessInfo,
    exe: &Path,
    home: &Path,
) -> Option<ProcessInfo> {
    let relative = exe
        .strip_prefix(home.join("Library/Caches/github-copilot-sdk/cli"))
        .ok()?;
    let parts: Vec<_> = relative.iter().collect();
    if parts.len() != 2
        || !parts[0].to_str()?.starts_with("copilot-sdk-runtime-")
        || parts[1] != "copilot-runtime"
        || !table.is_trusted_copilot(process.pid, exe)
    {
        return None;
    }
    let args = table.arguments(process.pid);
    if !args.iter().any(|a| a == "--server")
        || !args.iter().any(|a| a == "--stdio")
        || args.iter().any(|a| a.starts_with("--inspect"))
    {
        return None;
    }
    let host = table.process(process.parent)?;
    let host_exe = table.executable(host.pid)?;
    let bundle = host_exe.parent()?.parent()?.parent()?;
    if host.uid != process.uid
        || table.zombie(host.pid)
        || bundle.file_name()? != "GitHub Copilot.app"
        || host_exe != bundle.join("Contents/MacOS/github")
        || !table.is_trusted_copilot(host.pid, &host_exe)
        || !table.is_trusted_copilot_bundle(bundle)
    {
        return None;
    }
    (table.process(host.pid) == Some(host) && table.process(process.pid) == Some(process))
        .then_some(process)
}

#[cfg(test)]
mod tests {
    use crate::relay::copilot::proof;
    use crate::relay::process::FakeProcesses;

    fn fixture() -> (
        tempfile::TempDir,
        crate::relay::copilot::CopilotConfig,
        FakeProcesses,
    ) {
        let (home, config, table, _) = proof::tests::fixture();
        let user_home = crate::relay::paths::home().unwrap();
        let exe = user_home.join(
            "Library/Caches/github-copilot-sdk/cli/copilot-sdk-runtime-1.0.106/copilot-runtime",
        );
        let bundle = std::path::PathBuf::from("/Applications/GitHub Copilot.app");
        let host = bundle.join("Contents/MacOS/github");
        table
            .trusted_copilot
            .lock()
            .unwrap()
            .extend([exe.clone(), host.clone()]);
        table.trusted_copilot_bundles.lock().unwrap().insert(bundle);
        {
            let mut processes = table.processes.lock().unwrap();
            let runtime = processes.get_mut(&102).unwrap();
            runtime.parent = 100;
            runtime.executable = Some(exe);
            runtime.arguments = vec![
                "copilot-runtime".into(),
                "--server".into(),
                "--stdio".into(),
            ];
            processes.get_mut(&100).unwrap().executable = Some(host);
        }
        (home, config, table)
    }

    #[test]
    fn signed_desktop_runtime_holds_exact_sessions_and_direct_hooks() {
        let (_home, config, table) = fixture();
        let ids = proof::held(&config, &table, 102, 501);
        assert_eq!(ids.len(), 1);
        assert!(proof::hook_holds(&config, &table, 103, 501, &ids[0]));
        assert!(proof::held(&config, &table, 102, 999).is_empty());
    }

    #[test]
    fn unsigned_code_or_an_unsealed_desktop_bundle_is_refused() {
        for runtime in [true, false] {
            let (_home, config, table) = fixture();
            if runtime {
                table.trusted_copilot.lock().unwrap().clear();
            } else {
                table.trusted_copilot_bundles.lock().unwrap().clear();
            }
            assert!(proof::held(&config, &table, 102, 501).is_empty());
        }
    }

    #[test]
    fn a_copied_runtime_or_unrelated_parent_cannot_name_a_chat() {
        for parent in [true, false] {
            let (_home, config, table) = fixture();
            let mut processes = table.processes.lock().unwrap();
            if parent {
                processes.get_mut(&102).unwrap().parent = 101;
            } else {
                let copy = std::path::PathBuf::from("/tmp/copilot-sdk-runtime-1/copilot-runtime");
                table.trusted_copilot.lock().unwrap().insert(copy.clone());
                processes.get_mut(&102).unwrap().executable = Some(copy);
            }
            drop(processes);
            assert!(proof::held(&config, &table, 102, 501).is_empty());
        }
    }

    #[test]
    fn debugged_or_wrong_mode_runtime_is_refused() {
        for args in [
            vec!["--server", "--stdio", "--inspect=9000"],
            vec!["--stdio"],
        ] {
            let (_home, config, table) = fixture();
            table
                .processes
                .lock()
                .unwrap()
                .get_mut(&102)
                .unwrap()
                .arguments = args.into_iter().map(str::to_owned).collect();
            assert!(proof::held(&config, &table, 102, 501).is_empty());
        }
    }
}
