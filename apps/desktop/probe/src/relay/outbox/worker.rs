//! The background thread that runs a delivery's passes when they come due.
//!
//! A request for a pass sooner than the one already scheduled moves it
//! earlier; a later request never delays it, so a pass asked for while
//! another runs is never lost. Nothing runs until `start`, and nothing runs
//! again after `stop`.

use std::sync::{Arc, Condvar, Mutex, Weak};
use std::thread::{self, JoinHandle, ThreadId};
use std::time::{Duration, Instant};

#[derive(Default)]
struct State {
    started: bool,
    stopped: bool,
    next: Option<Instant>,
}

#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    signal: Condvar,
}

#[derive(Default)]
pub(crate) struct Worker {
    shared: Arc<Shared>,
    thread: Mutex<Option<(ThreadId, JoinHandle<()>)>>,
}

impl Worker {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.shared
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Starts the thread (once) and asks for a pass now. `pass` runs on the
    /// thread for as long as `target` is alive.
    pub(crate) fn start<T: Send + Sync + 'static>(
        &self,
        name: &str,
        target: Weak<T>,
        pass: fn(&T),
    ) {
        {
            let mut state = self.state();
            if state.stopped {
                return;
            }
            if !state.started {
                state.started = true;
                let shared = self.shared.clone();
                let spawned = thread::Builder::new()
                    .name(name.to_string())
                    .spawn(move || run(shared, target, pass));
                match spawned {
                    Ok(handle) => {
                        *self.thread.lock().unwrap_or_else(|p| p.into_inner()) =
                            Some((handle.thread().id(), handle));
                    }
                    Err(_) => {
                        state.started = false;
                        return;
                    }
                }
            }
        }
        self.schedule(Duration::ZERO);
    }

    /// Asks for a pass `after` from now, if the thread is running.
    pub(crate) fn schedule(&self, after: Duration) {
        let mut state = self.state();
        if !state.started || state.stopped {
            return;
        }
        let due = Instant::now() + after;
        state.next = Some(state.next.map_or(due, |next| next.min(due)));
        self.shared.signal.notify_all();
    }

    /// Stops the thread for good, waiting for a pass in progress unless
    /// called from that pass.
    pub(crate) fn stop(&self) {
        {
            let mut state = self.state();
            state.stopped = true;
            state.next = None;
            self.shared.signal.notify_all();
        }
        let joined = self.thread.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some((id, handle)) = joined {
            if id != thread::current().id() {
                let _ = handle.join();
            }
        }
    }

    /// Stops the thread without waiting for it.
    pub(crate) fn release(&self) {
        let mut state = self.state();
        state.stopped = true;
        self.shared.signal.notify_all();
    }
}

fn run<T>(shared: Arc<Shared>, target: Weak<T>, pass: fn(&T)) {
    loop {
        {
            let mut state = shared.state.lock().unwrap_or_else(|p| p.into_inner());
            loop {
                if state.stopped {
                    return;
                }
                let now = Instant::now();
                match state.next {
                    Some(due) if due <= now => {
                        state.next = None;
                        break;
                    }
                    Some(due) => {
                        state = shared
                            .signal
                            .wait_timeout(state, due - now)
                            .unwrap_or_else(|p| p.into_inner())
                            .0;
                    }
                    None => {
                        state = shared.signal.wait(state).unwrap_or_else(|p| p.into_inner());
                    }
                }
            }
        }
        let Some(target) = target.upgrade() else {
            return;
        };
        pass(&target);
    }
}
