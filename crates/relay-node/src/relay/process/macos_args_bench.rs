//! Explicit, ignored performance fixture. Its child has a controlled synthetic
//! environment; only aggregate counts and CPU/wall durations are emitted.
#[cfg(test)]
mod tests {
    use crate::relay::process::{macos, macos_args, ProcessTable, SystemProcesses};
    use std::hint::black_box;
    use std::time::Instant;

    fn cpu_seconds() -> f64 {
        // SAFETY: getrusage writes one initialized plain-data structure.
        let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
        assert_eq!(unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) }, 0);
        usage.ru_utime.tv_sec as f64
            + usage.ru_utime.tv_usec as f64 / 1_000_000.
            + usage.ru_stime.tv_sec as f64
            + usage.ru_stime.tv_usec as f64 / 1_000_000.
    }

    fn measure(iterations: usize, mut work: impl FnMut()) -> (f64, f64) {
        let wall = Instant::now();
        let cpu = cpu_seconds();
        for _ in 0..iterations {
            work();
        }
        (cpu_seconds() - cpu, wall.elapsed().as_secs_f64())
    }

    fn fixture(entries: usize, width: usize) -> Vec<u8> {
        let mut buffer = 4i32.to_ne_bytes().to_vec();
        buffer.extend_from_slice(
            b"/fixture/node\0\0node\0/fixture/claude\0--resume\0fixture-thread\0",
        );
        for i in 0..entries {
            buffer.extend_from_slice(format!("FIXTURE_{i}={}\0", "x".repeat(width)).as_bytes());
        }
        buffer
    }

    fn report(
        stage: &str,
        pair: usize,
        mode: &str,
        iterations: usize,
        bytes: usize,
        result: (f64, f64),
    ) {
        println!("{{\"stage\":\"{stage}\",\"pair\":{pair},\"mode\":\"{mode}\",\"iterations\":{iterations},\"bytes_per_buffer\":{bytes},\"cpu_s\":{:.9},\"wall_s\":{:.9}}}", result.0, result.1);
    }

    fn controlled_child(name: &str, ignored: bool) -> bool {
        if std::env::var_os("RELAY_ARGV_BENCH_CHILD").is_some() {
            return true;
        }
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", name, "--nocapture", "--test-threads=1"])
            .env_clear()
            .env("RELAY_ARGV_BENCH_CHILD", "1");
        if ignored {
            command.arg("--ignored");
        }
        if let Some(iterations) = std::env::var_os("RELAY_ARGV_BENCH_ITERS") {
            command.env("RELAY_ARGV_BENCH_ITERS", iterations);
        }
        for i in 0..1024 {
            command.env(format!("FIXTURE_{i}"), "x".repeat(128));
        }
        let output = command.output().unwrap();
        print!("{}", String::from_utf8_lossy(&output.stdout));
        assert!(
            output.status.success(),
            "controlled child failed: {}\n{}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
        false
    }

    #[test]
    fn actual_arguments_and_environment_use_only_the_requested_materialization() {
        if !controlled_child("relay::process::macos_args_bench::tests::actual_arguments_and_environment_use_only_the_requested_materialization", false) { return; }
        let pid = std::process::id() as i32;
        let raw = macos::procargs(pid).expect("controlled process is readable");
        let expected_argv = macos_args::decode(&raw, true).0;
        let processes = SystemProcesses::default();
        macos_args::reset_materialized();
        let argv = processes.arguments(pid);
        assert_eq!(argv, expected_argv);
        assert_eq!(
            macos_args::materialized(),
            argv.len(),
            "actual arguments must not decode environment entries"
        );
        macos_args::reset_materialized();
        assert!(processes.environment_readable(pid));
        assert_eq!(
            macos_args::materialized(),
            argv.len(),
            "readability needs argv only"
        );
        macos_args::reset_materialized();
        assert_eq!(
            processes.environment_var(pid, "FIXTURE_0"),
            Some("x".repeat(128))
        );
        assert!(
            macos_args::materialized() >= argv.len() + 1024,
            "requested environment lookup retains the full path"
        );
        assert!(processes.arguments(-1).is_empty());
        assert!(!processes.environment_readable(-1));
        assert!(processes.environment_var(-1, "FIXTURE_0").is_none());
    }

    #[test]
    #[ignore = "requires an explicitly granted quiet timing window"]
    fn matched_kernel_read_and_decode_cpu() {
        if !controlled_child(
            "relay::process::macos_args_bench::tests::matched_kernel_read_and_decode_cpu",
            true,
        ) {
            return;
        }
        let iterations = std::env::var("RELAY_ARGV_BENCH_ITERS")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(5000);
        let pid = std::process::id() as i32;
        let raw = macos::procargs(pid).expect("controlled process is readable");
        let full = macos_args::decode(&raw, true);
        let processes = SystemProcesses::default();
        assert_eq!(processes.arguments(pid), full.0);
        assert!(processes.environment_readable(pid));
        assert_eq!(
            processes.environment_var(pid, "FIXTURE_0"),
            Some("x".repeat(128))
        );
        assert!(processes.arguments(-1).is_empty());
        assert!(!processes.environment_readable(-1));
        assert!(processes.environment_var(-1, "FIXTURE_0").is_none());
        assert_eq!(macos_args::decode(&raw, false).0, full.0);
        println!("{{\"stage\":\"controlled_kernel_shape\",\"argc\":{},\"environment_entries\":{},\"bytes\":{},\"sysctl_reads_per_iteration\":2}}", full.0.len(), full.1.len(), raw.len());
        report(
            "kernel_read_only",
            0,
            "shared",
            iterations,
            raw.len(),
            measure(iterations, || {
                black_box(macos::procargs(pid).expect("controlled process stays readable"));
            }),
        );
        for (name, entries, width) in [
            ("small", 32, 32),
            ("medium", 256, 128),
            ("large", 1024, 128),
        ] {
            let buffer = fixture(entries, width);
            assert_eq!(
                macos_args::decode(&buffer, true).0,
                macos_args::decode(&buffer, false).0
            );
            for pair in 0..3 {
                for mode in if pair == 1 {
                    [false, true]
                } else {
                    [true, false]
                } {
                    let result = measure(iterations, || {
                        black_box(macos_args::decode(black_box(&buffer), mode).0);
                    });
                    report(
                        name,
                        pair,
                        if mode { "old_full" } else { "new_argv" },
                        iterations,
                        buffer.len(),
                        result,
                    );
                }
            }
        }
        for pair in 0..3 {
            for mode in if pair == 1 {
                [false, true]
            } else {
                [true, false]
            } {
                let result = measure(iterations, || {
                    let bytes = macos::procargs(pid).expect("controlled process stays readable");
                    black_box(macos_args::decode(black_box(&bytes), mode).0);
                });
                report(
                    "kernel_read_plus_decode",
                    pair,
                    if mode { "old_full" } else { "new_argv" },
                    iterations,
                    raw.len(),
                    result,
                );
            }
        }
    }
}
