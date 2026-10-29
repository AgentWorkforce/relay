//! Whether a pid is a Muse process, by executable name or — only when a
//! self-update deleted the binary out from under the session and the kernel
//! reports no path — by `argv[0]`.

use crate::relay::process::ProcessTable;
use std::ffi::OsStr;
use std::path::Path;

fn is_muse_name(name: &OsStr) -> bool {
    name.to_str().is_some_and(|name| name == "muse" || name.starts_with("muse-"))
}

pub(crate) fn is_muse_process(table: &dyn ProcessTable, pid: i32) -> bool {
    match table.executable(pid) {
        Some(executable) => executable.file_name().is_some_and(is_muse_name),
        None => table.arguments(pid).first().is_some_and(|argv0| {
            Path::new(argv0).file_name().is_some_and(is_muse_name)
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::process::{FakeProcess, FakeProcesses};

    // A binary deleted by a self-update leaves no kernel path: argv[0]
    // still identifies the session. A kernel path naming another program
    // stays decisive, whatever argv says.
    #[test]
    fn deleted_muse_binaries_are_found_but_spoofed_argv_is_not() {
        let table = FakeProcesses::default();
        table.insert(100, FakeProcess {
            executable: None,
            arguments: vec!["/home/me/.local/bin/muse-bin-1.4.6-R6000.1".into()],
            ..FakeProcess::default()
        });
        table.insert(200, FakeProcess {
            executable: None,
            arguments: vec!["/usr/bin/sleep".into()],
            ..FakeProcess::default()
        });
        table.insert(300, FakeProcess {
            executable: Some("/usr/bin/sleep".into()),
            arguments: vec!["/home/me/.local/bin/muse-bin-1.4.7".into()],
            ..FakeProcess::default()
        });
        assert!(is_muse_process(&table, 100));
        assert!(!is_muse_process(&table, 200));
        assert!(!is_muse_process(&table, 300));
    }
}
