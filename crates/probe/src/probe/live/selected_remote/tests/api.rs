use super::*;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::AtomicUsize;

pub(super) const DEVIN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
pub(super) const CLAUDE: &str = "session_01selected";

pub(super) struct Api {
    address: std::net::SocketAddr,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    pub version: Arc<AtomicUsize>,
    pub fail: Arc<AtomicBool>,
    pub held: Arc<AtomicBool>,
    pub entered: Arc<AtomicUsize>,
    lines: Arc<Mutex<Vec<String>>>,
}
impl Api {
    pub fn start(claude: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let version = Arc::new(AtomicUsize::new(1));
        let fail = Arc::new(AtomicBool::new(false));
        let held = Arc::new(AtomicBool::new(false));
        let entered = Arc::new(AtomicUsize::new(0));
        let lines = Arc::new(Mutex::new(Vec::new()));
        let (halt, revision, failing, holding, arrivals, logged) = (
            stop.clone(),
            version.clone(),
            fail.clone(),
            held.clone(),
            entered.clone(),
            lines.clone(),
        );
        let thread = std::thread::spawn(move || {
            while !halt.load(Ordering::Relaxed) {
                let (mut stream, _) = match listener.accept() {
                    Ok(v) => v,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(_) => break,
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut buf = [0; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);
                let line = request.lines().next().unwrap_or("").to_owned();
                if line.is_empty() {
                    continue;
                }
                logged.lock().unwrap().push(line.clone());
                let download = line.contains("/messages") || line.contains("teleport-events");
                let profile = line.contains("/api/oauth/profile");
                if !download && !profile {
                    arrivals.fetch_add(1, Ordering::SeqCst);
                    while holding.load(Ordering::SeqCst) && !halt.load(Ordering::Relaxed) {
                        std::thread::sleep(Duration::from_millis(2));
                    }
                }
                let ver = revision.load(Ordering::SeqCst);
                let status = if failing.load(Ordering::SeqCst) && !download && !profile {
                    500
                } else {
                    200
                };
                let body = if status == 500 {
                    "{}".to_owned()
                } else if profile {
                    json!({"organization":{"uuid":"org-test"}}).to_string()
                } else if claude {
                    if download {
                        let id = if line.contains("session_02unselected") {
                            "session_02unselected"
                        } else {
                            CLAUDE
                        };
                        json!({"data":[{"payload":{"sessionId":id,"uuid":"u1","type":"user","timestamp":1,"message":{"role":"user","content":format!("version-{ver}")}}},{"payload":{"sessionId":id,"uuid":"a1","type":"assistant","timestamp":2,"message":{"role":"assistant","content":[{"type":"text","text":format!("answer-{ver}")}]}}}],"next_cursor":null}).to_string()
                    } else {
                        let at =
                            chrono::DateTime::from_timestamp(1_700_000_000 + ver as i64 * 60, 0)
                                .unwrap()
                                .to_rfc3339();
                        json!({"data":[{"id":CLAUDE,"title":format!("selected-{ver}"),"created_at":"2023-11-14T22:13:20Z","last_event_at":at,"environment_kind":"cloud"},{"id":"session_02unselected","title":"unselected","created_at":"2023-11-14T22:13:20Z","last_event_at":at,"environment_kind":"cloud"}],"next_cursor":null}).to_string()
                    }
                } else if download {
                    json!({"items":[{"event_id":"e1","source":"user","message":format!("version-{ver}"),"created_at":1700000000},{"event_id":"e2","source":"devin","message":format!("answer-{ver}"),"created_at":1700000060}],"end_cursor":null,"has_next_page":false}).to_string()
                } else {
                    json!({"items":[{"session_id":DEVIN,"created_at":1700000000,"updated_at":1_700_000_000+ver*60,"title":format!("selected-{ver}"),"status":"active"},{"session_id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","created_at":1700000000,"updated_at":1_700_000_000+ver*60,"title":"unselected","status":"active"}],"end_cursor":null,"has_next_page":false}).to_string()
                };
                let _=write!(stream,"HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
            }
        });
        Self {
            address,
            stop,
            thread: Some(thread),
            version,
            fail,
            held,
            entered,
            lines,
        }
    }
    pub fn url(&self) -> String {
        format!("http://{}", self.address)
    }
    pub fn lines(&self) -> Vec<String> {
        self.lines.lock().unwrap().clone()
    }
    pub fn fetches(&self) -> usize {
        self.lines()
            .iter()
            .filter(|l| l.contains("/messages") || l.contains("teleport-events"))
            .count()
    }
    pub fn lists(&self) -> usize {
        self.entered.load(Ordering::SeqCst)
    }
}
impl Drop for Api {
    fn drop(&mut self) {
        self.held.store(false, Ordering::SeqCst);
        self.stop.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect(self.address);
        if let Some(t) = self.thread.take() {
            t.join().unwrap();
        }
    }
}
