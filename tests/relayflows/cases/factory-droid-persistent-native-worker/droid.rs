// Disposable startup sentinel. It runs no model, tools or network requests.
fn main() {
    let path = std::env::var_os("RELAY_FACTORY_FIXTURE_EVENTS").expect("sentinel path");
    std::fs::write(path, "provider unexpectedly started").unwrap();
    std::process::exit(1);
}
