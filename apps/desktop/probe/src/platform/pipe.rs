//! Writing to a child's pipe with a deadline on Windows, whose anonymous
//! pipes have no non-blocking mode to poll (Unix writes non-blocking with
//! `poll`, as `codex::runner::write_by` does).

use std::io::{self, ErrorKind, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::Instant;

/// A writer with deadlines: a thread of its own does each write, and the
/// caller waits for it until the deadline. A write still blocked then is
/// left to that thread (it fails once the reader goes away) and the next
/// write first waits for it, so bytes never interleave. How much of the
/// write in hand went in is counted, so a caller can tell a write that sent
/// nothing from one cut short.
pub struct DeadlineWriter {
    requests: mpsc::Sender<Vec<u8>>,
    results: Receiver<io::Result<()>>,
    /// Bytes of the write in hand that are in.
    written: Arc<AtomicUsize>,
    /// A write was handed over and its result not yet taken.
    pending: bool,
}

/// A failed write.
#[derive(Debug)]
pub struct Shortfall {
    /// How many of its bytes are known to have gone in.
    pub written: usize,
    /// The write is still with the writer's thread, past its deadline: the
    /// rest of it, or all of it, may go in yet.
    pub in_doubt: bool,
    pub error: io::Error,
}

impl DeadlineWriter {
    pub fn new(mut target: impl Write + Send + 'static) -> DeadlineWriter {
        let (requests, work) = mpsc::channel::<Vec<u8>>();
        let (done, results) = mpsc::channel();
        let written = Arc::new(AtomicUsize::new(0));
        let progress = written.clone();
        std::thread::spawn(move || {
            for bytes in work {
                progress.store(0, Ordering::SeqCst);
                let mut result = Ok(());
                let mut at = 0;
                while at < bytes.len() {
                    match target.write(&bytes[at..]) {
                        Ok(0) => {
                            result = Err(io::Error::new(ErrorKind::WriteZero, "input closed"));
                            break;
                        }
                        Ok(count) => {
                            at += count;
                            progress.store(at, Ordering::SeqCst);
                        }
                        Err(error) if error.kind() == ErrorKind::Interrupted => {}
                        Err(error) => {
                            result = Err(error);
                            break;
                        }
                    }
                }
                let result = result.and_then(|()| target.flush());
                if done.send(result).is_err() {
                    break;
                }
            }
        });
        DeadlineWriter {
            requests,
            results,
            written,
            pending: false,
        }
    }

    fn wait(&mut self, deadline: Instant) -> io::Result<()> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        match self.results.recv_timeout(remaining) {
            Ok(result) => {
                self.pending = false;
                result
            }
            Err(RecvTimeoutError::Timeout) => Err(io::Error::new(
                ErrorKind::TimedOut,
                "the reader stopped reading",
            )),
            Err(RecvTimeoutError::Disconnected) => {
                self.pending = false;
                Err(io::Error::new(ErrorKind::BrokenPipe, "input closed"))
            }
        }
    }

    /// Writes all of `bytes` by `deadline`, as `write_by` does on Unix.
    pub fn write_all(&mut self, bytes: &[u8], deadline: Instant) -> io::Result<()> {
        self.write_counted(bytes, deadline, deadline)
            .map_err(|shortfall| shortfall.error)
    }

    /// Writes all of `bytes`: nothing is begun after `start` (a write
    /// still in hand from before is waited for until then), and one begun
    /// but cut short is waited for until `finish`. A failure says how many
    /// of `bytes` went in, and whether the rest may still go in.
    ///
    /// A write that times out is not cancelled: std writes a child's pipe
    /// in a way `CancelSynchronousIo` does not reliably abort, and a count
    /// after an abort would not be trustworthy. So a write handed to the
    /// thread and not finished by its deadline is `in_doubt` even when none
    /// of it is in yet: the reader may take it whole later, and a caller
    /// must not write it again. Only bytes never handed over are surely
    /// unwritten.
    pub fn write_counted(
        &mut self,
        bytes: &[u8],
        start: Instant,
        finish: Instant,
    ) -> Result<(), Shortfall> {
        let unsent = |error| Shortfall {
            written: 0,
            in_doubt: false,
            error,
        };
        if self.pending {
            self.wait(start).map_err(unsent)?;
        }
        self.written.store(0, Ordering::SeqCst);
        self.requests
            .send(bytes.to_vec())
            .map_err(|_| unsent(io::Error::new(ErrorKind::BrokenPipe, "input closed")))?;
        self.pending = true;
        let result = match self.wait(start) {
            Err(error) if error.kind() == ErrorKind::TimedOut && self.progress() > 0 => {
                self.wait(finish.max(start))
            }
            other => other,
        };
        result.map_err(|error| Shortfall {
            written: self.progress(),
            in_doubt: self.pending,
            error,
        })
    }

    fn progress(&self) -> usize {
        self.written.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Condvar, Mutex};
    use std::time::Duration;

    /// A reader that takes `take` bytes and then nothing until released,
    /// keeping what it took.
    struct Stuck {
        take: usize,
        gate: Arc<(Mutex<bool>, Condvar)>,
        got: Arc<Mutex<Vec<u8>>>,
    }

    impl Write for Stuck {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            if self.take == 0 {
                let (released, changed) = &*self.gate;
                let mut released = released.lock().unwrap();
                while !*released {
                    released = changed.wait(released).unwrap();
                }
            }
            let count = if self.take > 0 {
                buffer.len().min(self.take)
            } else {
                buffer.len()
            };
            self.take -= count.min(self.take);
            self.got.lock().unwrap().extend_from_slice(&buffer[..count]);
            Ok(count)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn stuck(
        take: usize,
    ) -> (
        DeadlineWriter,
        Arc<(Mutex<bool>, Condvar)>,
        Arc<Mutex<Vec<u8>>>,
    ) {
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let got = Arc::new(Mutex::new(Vec::new()));
        let writer = DeadlineWriter::new(Stuck {
            take,
            gate: gate.clone(),
            got: got.clone(),
        });
        (writer, gate, got)
    }

    fn release(gate: &Arc<(Mutex<bool>, Condvar)>) {
        *gate.0.lock().unwrap() = true;
        gate.1.notify_all();
    }

    /// Review: a timed-out write may still arrive whole, so it is never
    /// reported as unwritten, which a caller would write again.
    #[test]
    fn a_write_nobody_takes_by_its_deadline_is_in_doubt_and_may_still_arrive() {
        let (mut writer, gate, got) = stuck(0);
        let started = Instant::now();
        let deadline = started + Duration::from_millis(100);
        let shortfall = writer
            .write_counted(b"task\n", deadline, deadline + Duration::from_secs(60))
            .unwrap_err();
        assert_eq!(shortfall.error.kind(), ErrorKind::TimedOut);
        assert_eq!((shortfall.written, shortfall.in_doubt), (0, true));
        assert!(started.elapsed() < Duration::from_secs(2));
        // The next write waits for that one and is never handed over: it
        // surely went nowhere.
        let shortfall = writer
            .write_counted(b"next\n", Instant::now(), Instant::now())
            .unwrap_err();
        assert_eq!((shortfall.written, shortfall.in_doubt), (0, false));
        // The reader takes its input again: the first write goes in, once.
        release(&gate);
        writer
            .write_all(b"last\n", Instant::now() + Duration::from_secs(10))
            .unwrap();
        assert_eq!(got.lock().unwrap().as_slice(), b"task\nlast\n");
    }

    #[test]
    fn a_write_cut_short_is_waited_for_until_it_must_finish_and_says_so() {
        let (mut writer, gate, _) = stuck(5);
        let started = Instant::now();
        let shortfall = writer
            .write_counted(
                &[0u8; 16],
                started + Duration::from_millis(50),
                started + Duration::from_millis(300),
            )
            .unwrap_err();
        assert_eq!(shortfall.error.kind(), ErrorKind::TimedOut);
        assert_eq!((shortfall.written, shortfall.in_doubt), (5, true));
        assert!(started.elapsed() >= Duration::from_millis(300));
        release(&gate);
    }
}
