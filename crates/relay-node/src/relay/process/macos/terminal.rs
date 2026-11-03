use super::*;

pub(super) fn path(pid: i32) -> Option<PathBuf> {
    // A terminal stdin is a character device whose kernel path is a
    // tty. `proc_pidfdinfo` asks about exactly fd 0 without opening
    // or disturbing the other process.
    let mut info: VnodeFdInfoWithPath = unsafe { zeroed() };
    let expected = size_of::<VnodeFdInfoWithPath>() as c_int;
    let read = unsafe {
        libc::proc_pidfdinfo(
            pid,
            0,
            PROC_PIDFDVNODEPATHINFO,
            (&mut info as *mut VnodeFdInfoWithPath).cast(),
            expected,
        )
    };
    if read != expected {
        return None;
    }
    path_of(&info.pvip).filter(|path| terminal_device(path))
}
