//! Isolated native acceptance fixture (Unix); never an installed service.
#[cfg(unix)]
#[path = "native_visibility_host/host.rs"]
mod host;
#[cfg(unix)]
fn main() {
    host::run();
}
#[cfg(not(unix))]
fn main() {
    eprintln!("native_visibility_host is a Unix-only acceptance helper");
    std::process::exit(2);
}
