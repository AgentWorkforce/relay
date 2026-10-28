//! Bounded, deadline-limited project lookups shared by every session list.

use super::{file_name, name};
use futures_util::future::{join_all, BoxFuture, FutureExt, Shared};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{oneshot, Semaphore};
use tokio::time::Instant;

type Lookup = Shared<BoxFuture<'static, Option<String>>>;
type Resolver = Arc<dyn Fn(&str, &Path) -> Option<String> + Send + Sync>;

const DEADLINE: Duration = Duration::from_millis(250);
const TTL: Duration = Duration::from_secs(5 * 60);
const CAPACITY: usize = 32_768;
const WORKERS: usize = 4;

/// Positive, absent and timed-out results all expire. Pending lookups are
/// shared too, so overlapping refreshes do not repeat filesystem work.
pub(crate) struct Names {
    relay_home: PathBuf,
    cache: Mutex<Cache>,
    workers: Arc<Semaphore>,
    resolver: Resolver,
    deadline: Duration,
    ttl: Duration,
    capacity: usize,
}

#[derive(Default)]
struct Cache {
    entries: HashMap<String, Lookup>,
    order: VecDeque<(String, Instant)>,
}

impl Names {
    pub(crate) fn new(relay_home: PathBuf) -> Self {
        Self {
            relay_home,
            cache: Mutex::new(Cache::default()),
            workers: Arc::new(Semaphore::new(WORKERS)),
            resolver: Arc::new(|directory, home| name(Some(directory), home)),
            deadline: DEADLINE,
            ttl: TTL,
            capacity: CAPACITY,
        }
    }

    /// Resolve a whole list concurrently: its budget is one deadline, not
    /// the number of distinct directories multiplied by that deadline.
    pub(crate) async fn list<'a>(
        &self,
        directories: impl Iterator<Item = &'a str>,
    ) -> HashMap<String, Option<String>> {
        join_all(
            directories
                .map(|directory| async move { (directory.to_owned(), self.get(directory).await) }),
        )
        .await
        .into_iter()
        .collect()
    }

    async fn get(&self, directory: &str) -> Option<String> {
        let directory = directory.trim();
        if directory.is_empty() {
            return None;
        }
        let lookup = {
            let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();
            while cache
                .order
                .front()
                .is_some_and(|(_, expiry)| *expiry <= now)
            {
                if let Some((key, _)) = cache.order.pop_front() {
                    cache.entries.remove(&key);
                }
            }
            if let Some(lookup) = cache.entries.get(directory) {
                lookup.clone()
            } else {
                if cache.entries.len() >= self.capacity {
                    if let Some((key, _)) = cache.order.pop_front() {
                        cache.entries.remove(&key);
                    }
                }
                let lookup = self.lookup(directory.to_owned(), now + self.deadline);
                cache.entries.insert(directory.to_owned(), lookup.clone());
                cache
                    .order
                    .push_back((directory.to_owned(), now + self.ttl));
                lookup
            }
        };
        lookup.await
    }

    fn lookup(&self, directory: String, deadline: Instant) -> Lookup {
        let workers = self.workers.clone();
        let resolver = self.resolver.clone();
        let relay_home = self.relay_home.clone();
        async move {
            let fallback = file_name(Path::new(&directory));
            let work = async move {
                let permit = workers.acquire_owned().await.ok()?;
                // A dropped/cancelled RPC may leave a shared lookup unpolled
                // past its deadline. Never start stale filesystem work.
                if Instant::now() >= deadline {
                    return None;
                }
                let (send, receive) = oneshot::channel();
                std::thread::Builder::new()
                    .name("relay-project".into())
                    .spawn(move || {
                        // Keep the slot until the syscall actually returns,
                        // even after its caller times out. Detached dedicated
                        // threads cannot block Tokio's pool or its shutdown.
                        let _permit = permit;
                        let _ = send.send(resolver(&directory, &relay_home));
                    })
                    .ok()?;
                receive.await.ok()
            };
            // Its own task, so the runtime drives it to the deadline even
            // when every caller is cancelled: an unpolled shared lookup would
            // keep its place in the semaphore queue and take the next free
            // worker slot from everyone else.
            tokio::spawn(tokio::time::timeout_at(deadline, work))
                .await
                .ok()
                .and_then(Result::ok)
                .flatten()
                // timeout_at polls ready work before checking its timer. A
                // shared lookup resumed after cancellation may already have
                // a reply, but its original deadline still applies.
                .filter(|_| Instant::now() < deadline)
                .unwrap_or(fallback)
        }
        .boxed()
        .shared()
    }
}

#[cfg(test)]
mod tests;
