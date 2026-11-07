//! This computer's resources, sampled for each heartbeat so a requester
//! can judge a node before it names one. Each is `None` when it cannot be
//! read; nothing here decides anything.

use serde_json::{json, Value};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Resources {
    pub cpus: u32,
    /// The 1-minute load average.
    pub load_1m: Option<f64>,
    pub memory_total_bytes: Option<u64>,
    /// Memory available to new work without swapping, as the system
    /// estimates it.
    pub memory_available_bytes: Option<u64>,
}

impl Resources {
    pub fn to_json(&self) -> Value {
        json!({
            "cpus": self.cpus,
            "load_1m": self.load_1m.map(|load| (load * 100.0).round() / 100.0),
            "memory_total_bytes": self.memory_total_bytes,
            "memory_available_bytes": self.memory_available_bytes,
        })
    }
}

pub fn sample() -> Resources {
    let (memory_total_bytes, memory_available_bytes) = memory();
    Resources {
        cpus: std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(1),
        load_1m: load_average(),
        memory_total_bytes,
        memory_available_bytes,
    }
}

#[cfg(unix)]
fn load_average() -> Option<f64> {
    let mut loads = [0f64; 1];
    // SAFETY: `loads` has room for the one sample asked for.
    let read = unsafe { libc::getloadavg(loads.as_mut_ptr(), 1) };
    (read == 1 && loads[0].is_finite() && loads[0] >= 0.0).then_some(loads[0])
}

/// Windows keeps no load average (its processor queue length is a
/// different measure), so none is reported.
#[cfg(windows)]
fn load_average() -> Option<f64> {
    None
}

#[cfg(target_os = "linux")]
fn memory() -> (Option<u64>, Option<u64>) {
    std::fs::read_to_string("/proc/meminfo")
        .map(|text| meminfo(&text))
        .unwrap_or((None, None))
}

/// `MemTotal` and `MemAvailable` from `/proc/meminfo`, in bytes.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn meminfo(text: &str) -> (Option<u64>, Option<u64>) {
    let field = |name: &str| {
        text.lines()
            .find_map(|line| line.strip_prefix(name)?.strip_prefix(':'))
            .and_then(|rest| rest.split_whitespace().next()?.parse::<u64>().ok())
            .map(|kib| kib * 1024)
    };
    (field("MemTotal"), field("MemAvailable"))
}

#[cfg(target_os = "macos")]
fn memory() -> (Option<u64>, Option<u64>) {
    let total = sysctl_u64(c"hw.memsize");
    let page = sysctl_u64(c"hw.pagesize");
    // Free pages and those the system reclaims without swapping:
    // speculative, purgeable and file-backed (Activity Monitor's "Cached
    // Files").
    let pages: Option<u64> = [
        c"vm.page_free_count",
        c"vm.page_speculative_count",
        c"vm.page_purgeable_count",
        c"vm.page_pageable_external_count",
    ]
    .into_iter()
    .map(sysctl_u64)
    .sum();
    (total, pages.zip(page).map(|(pages, page)| pages * page))
}

#[cfg(target_os = "macos")]
fn sysctl_u64(name: &std::ffi::CStr) -> Option<u64> {
    let mut value = [0u8; 8];
    let mut size = value.len();
    // SAFETY: `value` is writable for `size` bytes; no new value is set.
    let status = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            value.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    match (status, size) {
        (0, 8) => Some(u64::from_ne_bytes(value)),
        (0, 4) => Some(u32::from_ne_bytes([value[0], value[1], value[2], value[3]]) as u64),
        _ => None,
    }
}

/// Physical memory and what is available without paging, as Windows
/// reports them (`GlobalMemoryStatusEx`, through sysinfo).
#[cfg(windows)]
fn memory() -> (Option<u64>, Option<u64>) {
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    let total = Some(system.total_memory()).filter(|bytes| *bytes > 0);
    let available = total.map(|total| system.available_memory().min(total));
    (total, available)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn memory() -> (Option<u64>, Option<u64>) {
    (None, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sample_reads_this_computer() {
        let sample = sample();
        assert!(sample.cpus >= 1);
        // Windows keeps no load average.
        assert_eq!(sample.load_1m.is_some(), cfg!(unix));
        let (total, available) = (
            sample.memory_total_bytes.unwrap(),
            sample.memory_available_bytes.unwrap(),
        );
        assert!(total > 0 && available <= total);
    }

    #[test]
    fn linux_memory_is_read_from_meminfo() {
        let text = "MemTotal:       16303772 kB\nMemFree:  1 kB\nMemAvailable:    8151886 kB\n";
        assert_eq!(meminfo(text), (Some(16303772 * 1024), Some(8151886 * 1024)));
        assert_eq!(meminfo(""), (None, None));
    }

    #[test]
    fn the_wire_shape_rounds_the_load() {
        let resources = Resources {
            cpus: 10,
            load_1m: Some(1.23456),
            memory_total_bytes: Some(1),
            memory_available_bytes: None,
        };
        assert_eq!(
            resources.to_json(),
            json!({"cpus": 10, "load_1m": 1.23, "memory_total_bytes": 1,
                "memory_available_bytes": null})
        );
    }
}
