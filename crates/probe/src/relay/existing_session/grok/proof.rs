//! Kernel and socket proof shared by native delivery and title metadata.
use super::*;

/// Reuse delivery's full kernel/peer proof before a native metadata mutation.
pub(crate) fn verify_title_binding(processes: &dyn ProcessTable, binding: &Binding) -> bool {
    if binding.credential_reference == existing_reference(binding) {
        processes.environment_readable(binding.leader_pid)
            && leader_proves(processes, binding, true, |marker| marker.is_none())
    } else {
        leader_proves(processes, binding, false, |marker| {
            marker
                .map(|value| credential_reference(binding, &value))
                .as_deref()
                == Some(binding.credential_reference.as_str())
        })
    }
}

/// `default_socket` lets a leader whose argv names no `--leader-socket`
/// prove the binding of its home's `leader.sock`: the leader a `grok --leader`
/// TUI spawns for itself. The managed route never allows it, since every
/// leader it launches names its private socket.
pub(super) fn leader_proves(
    processes: &dyn ProcessTable,
    binding: &Binding,
    default_socket: bool,
    marker_matches: impl FnOnce(Option<String>) -> bool,
) -> bool {
    if binding.owner_uid != current_uid() {
        return false;
    }
    let Some(process) = processes.process(binding.leader_pid) else {
        return false;
    };
    if process.uid != binding.owner_uid || process.start != binding.leader_start {
        return false;
    }
    if !marker_matches(processes.environment_var(binding.leader_pid, MANAGED_MARKER)) {
        return false;
    }
    let executable = processes.executable(binding.leader_pid);
    let trusted_executable = executable
        .as_deref()
        .and_then(|path| fs::canonicalize(path).ok())
        == fs::canonicalize(&binding.executable).ok()
        && fs::metadata(&binding.executable).is_ok_and(|metadata| {
            (metadata.uid() == 0 || metadata.uid() == binding.owner_uid)
                && metadata.mode() & 0o022 == 0
        });
    if !trusted_executable {
        return false;
    }
    let arguments = processes.arguments(binding.leader_pid);
    let default = default_socket
        .then(|| default_leader_socket(processes, binding.leader_pid))
        .flatten();
    if !leader_arguments_match(&arguments, &binding.socket_path, default.as_deref()) {
        return false;
    }
    let socket = fs::symlink_metadata(&binding.socket_path);
    let cwd = fs::symlink_metadata(&binding.cwd);
    socket.is_ok_and(|metadata| {
        metadata.file_type().is_socket()
            && metadata.uid() == binding.owner_uid
            && metadata.dev() == binding.socket_device
            && metadata.ino() == binding.socket_inode
    }) && cwd.is_ok_and(|metadata| metadata.is_dir() && metadata.uid() == binding.owner_uid)
        && socket_peer_matches(binding)
        && processes.process(binding.leader_pid) == Some(process)
}
