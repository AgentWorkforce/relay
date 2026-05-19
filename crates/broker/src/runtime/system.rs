use super::*;

/// Get terminal rows from TIOCGWINSZ.
#[cfg(unix)]
pub(crate) fn terminal_rows() -> Option<u16> {
    use nix::libc;
    use nix::pty::Winsize;
    let mut ws = Winsize {
        ws_row: 0,
        ws_col: 0,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    unsafe {
        if libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut ws) == 0 && ws.ws_row > 0 {
            Some(ws.ws_row)
        } else {
            None
        }
    }
}

/// Get terminal cols from TIOCGWINSZ.
#[cfg(unix)]
pub(crate) fn terminal_cols() -> Option<u16> {
    use nix::libc;
    use nix::pty::Winsize;
    let mut ws = Winsize {
        ws_row: 0,
        ws_col: 0,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    unsafe {
        if libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut ws) == 0 && ws.ws_col > 0 {
            Some(ws.ws_col)
        } else {
            None
        }
    }
}

#[cfg(not(unix))]
pub(crate) fn terminal_rows() -> Option<u16> {
    None
}
#[cfg(not(unix))]
pub(crate) fn terminal_cols() -> Option<u16> {
    None
}

#[cfg(target_os = "linux")]
pub(crate) fn memory_bytes_for_pid(pid: u32) -> u64 {
    let statm_path = format!("/proc/{pid}/statm");
    let statm = match std::fs::read_to_string(statm_path) {
        Ok(contents) => contents,
        Err(_) => return 0,
    };

    let rss_pages = match statm
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u64>().ok())
    {
        Some(value) => value,
        None => return 0,
    };

    let page_size = unsafe { nix::libc::sysconf(nix::libc::_SC_PAGESIZE) };
    if page_size <= 0 {
        return 0;
    }

    rss_pages.saturating_mul(page_size as u64)
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn memory_bytes_for_pid(_pid: u32) -> u64 {
    0
}

pub(crate) fn build_agent_metrics(handle: &WorkerHandle) -> AgentMetrics {
    let pid = handle.child.id().unwrap_or_default();
    AgentMetrics {
        name: handle.spec.name.clone(),
        pid,
        memory_bytes: if pid == 0 {
            0
        } else {
            memory_bytes_for_pid(pid)
        },
        uptime_secs: handle.spawned_at.elapsed().as_secs(),
    }
}
