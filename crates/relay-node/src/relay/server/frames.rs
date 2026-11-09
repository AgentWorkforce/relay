//! The requests a bridge client sends: one JSON-RPC message per line. Lines
//! may be read ahead of the request being handled, so a connection notices
//! its client hanging up while a call is still in flight.

use std::collections::VecDeque;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};

/// Lines that may be read ahead of the call in flight. A client that sends
/// this many during one call has overflowed the read-ahead.
pub(super) const READ_AHEAD_LINES: usize = 32;

/// One thing read from a client.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Frame {
    /// A request line without its newline; never blank.
    Line(Vec<u8>),
    /// A line over the frame limit. Nothing after it is read.
    TooLarge,
    /// The client closed its side, or reading failed.
    End,
}

/// Why reading ahead during a call ended. Every reason ends the connection.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum HungUp {
    /// The client closed its side, or reading failed.
    Eof,
    /// The read-ahead reached its line or byte cap: the client sent more
    /// than a connection keeps while a call is in flight.
    Overflow,
    /// A line over the frame limit arrived. Nothing after it is read.
    TooLarge,
}

/// A client's lines, in order. Every method is cancel-safe: a read that is
/// dropped part-way keeps what it read for the next one.
pub(super) struct Frames<R> {
    reader: BufReader<R>,
    limit: usize,
    /// The line being read.
    partial: Vec<u8>,
    /// Lines read ahead, oldest first, and their bytes.
    queued: VecDeque<Vec<u8>>,
    queued_bytes: usize,
    /// Whether a frame that ends reading was read.
    finished: bool,
}

impl<R: AsyncRead + Unpin> Frames<R> {
    /// Lines of at most `limit` bytes from `read`.
    pub(super) fn new(read: R, limit: usize) -> Frames<R> {
        Frames {
            reader: BufReader::new(read),
            limit,
            partial: Vec::new(),
            queued: VecDeque::new(),
            queued_bytes: 0,
            finished: false,
        }
    }

    /// The next frame: one read ahead first, else the next from the client.
    pub(super) async fn next(&mut self) -> Frame {
        match self.take_queued() {
            Some(line) => Frame::Line(line),
            None => self.read().await,
        }
    }

    /// The oldest line read ahead, without reading the client.
    pub(super) fn take_queued(&mut self) -> Option<Vec<u8>> {
        let line = self.queued.pop_front()?;
        self.queued_bytes -= line.len() + 1;
        Some(line)
    }

    /// Reads ahead while a call is in flight, keeping each line for
    /// [`Frames::next`] or [`Frames::take_queued`], and returns why reading
    /// cannot go on: the client hung up (an unterminated last line is kept
    /// first), the read-ahead reached [`READ_AHEAD_LINES`] lines or `limit`
    /// bytes, or a line was too large. It never waits on anything but the
    /// client, so it never parks, and what it keeps stays bounded.
    pub(super) async fn hung_up(&mut self) -> HungUp {
        loop {
            if self.finished {
                return HungUp::Eof;
            }
            if self.queued.len() >= READ_AHEAD_LINES || self.queued_bytes >= self.limit {
                return HungUp::Overflow;
            }
            match self.read().await {
                Frame::End => return HungUp::Eof,
                Frame::Line(line) => {
                    self.queued_bytes += line.len() + 1;
                    self.queued.push_back(line);
                }
                Frame::TooLarge => return HungUp::TooLarge,
            }
        }
    }

    /// The next frame from the client, skipping blank lines. The only await
    /// is `fill_buf`, which consumes nothing, so a dropped read loses nothing.
    async fn read(&mut self) -> Frame {
        loop {
            if self.finished {
                return Frame::End;
            }
            let available = match self.reader.fill_buf().await {
                Ok(available) => available,
                Err(_) => {
                    self.finished = true;
                    return Frame::End;
                }
            };
            if available.is_empty() {
                // A last line without its newline is still a request.
                self.finished = true;
                return self.line();
            }
            let newline = available.iter().position(|byte| *byte == b'\n');
            let taken = newline.unwrap_or(available.len());
            if self.partial.len() + taken > self.limit {
                self.finished = true;
                self.partial.clear();
                return Frame::TooLarge;
            }
            self.partial.extend_from_slice(&available[..taken]);
            match newline {
                Some(at) => {
                    self.reader.consume(at + 1);
                    if let Frame::Line(line) = self.line() {
                        return Frame::Line(line);
                    }
                }
                None => self.reader.consume(taken),
            }
        }
    }

    /// The line read so far, or `End` when it is blank.
    fn line(&mut self) -> Frame {
        let line = std::mem::take(&mut self.partial);
        if line.iter().all(u8::is_ascii_whitespace) {
            Frame::End
        } else {
            Frame::Line(line)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::AsyncWriteExt;

    fn line(text: &str) -> Frame {
        Frame::Line(text.as_bytes().to_vec())
    }

    #[tokio::test]
    async fn lines_come_in_order_without_blanks_and_a_last_line_needs_no_newline() {
        let mut frames = Frames::new(&b"one\n\n  \ntwo\r\nthree"[..], 16);
        assert_eq!(frames.next().await, line("one"));
        assert_eq!(frames.next().await, line("two\r"));
        assert_eq!(frames.next().await, line("three"));
        assert_eq!(frames.next().await, Frame::End);
        assert_eq!(frames.next().await, Frame::End);
    }

    #[tokio::test]
    async fn a_line_over_the_limit_ends_reading() {
        let mut frames = Frames::new(&b"1234\n12345\nlater\n"[..], 4);
        assert_eq!(frames.next().await, line("1234"));
        assert_eq!(frames.next().await, Frame::TooLarge);
        assert_eq!(frames.next().await, Frame::End);

        let mut unterminated = Frames::new(&b"12345"[..], 4);
        assert_eq!(unterminated.next().await, Frame::TooLarge);
    }

    #[tokio::test]
    async fn reading_ahead_queues_lines_until_the_client_hangs_up() {
        let (client, server) = tokio::io::duplex(64);
        let mut frames = Frames::new(server, 1024);
        let mut client = client;
        client.write_all(b"first\nsec").await.unwrap();
        // Nothing has hung up: a read-ahead that is dropped keeps what it read.
        assert!(
            tokio::time::timeout(Duration::from_millis(50), frames.hung_up())
                .await
                .is_err()
        );
        client.write_all(b"ond\n").await.unwrap();
        drop(client);
        let reason = tokio::time::timeout(Duration::from_secs(1), frames.hung_up())
            .await
            .expect("the hang-up is seen while lines are queued");
        assert_eq!(reason, HungUp::Eof);
        assert_eq!(frames.next().await, line("first"));
        assert_eq!(frames.next().await, line("second"));
        assert_eq!(frames.next().await, Frame::End);
    }

    #[tokio::test]
    async fn a_full_read_ahead_reports_overflow_instead_of_parking() {
        // The line cap, with the client still connected and silent.
        let (mut client, server) = tokio::io::duplex(4096);
        for _ in 0..READ_AHEAD_LINES {
            client.write_all(b"x\n").await.unwrap();
        }
        let mut frames = Frames::new(server, 1024);
        let reason = tokio::time::timeout(Duration::from_secs(1), frames.hung_up())
            .await
            .expect("a full read-ahead does not park");
        assert_eq!(reason, HungUp::Overflow);
        assert_eq!(frames.queued.len(), READ_AHEAD_LINES);
        for _ in 0..READ_AHEAD_LINES {
            assert_eq!(frames.next().await, line("x"));
        }
        assert_eq!(frames.queued_bytes, 0);
        drop(client);
        assert_eq!(frames.next().await, Frame::End);

        // The byte cap, well within the line cap.
        let (mut client, server) = tokio::io::duplex(4096);
        client.write_all(b"12345\n12345\n").await.unwrap();
        let mut frames = Frames::new(server, 8);
        let reason = tokio::time::timeout(Duration::from_secs(1), frames.hung_up())
            .await
            .expect("a read-ahead over its byte cap does not park");
        assert_eq!(reason, HungUp::Overflow);
        assert_eq!(frames.queued.len(), 2);
        assert!(frames.queued_bytes >= 8);
        drop(client);
    }

    #[tokio::test]
    async fn a_too_large_line_read_ahead_is_reported() {
        let (mut client, server) = tokio::io::duplex(4096);
        client.write_all(b"ok\n123456789\n").await.unwrap();
        let mut frames = Frames::new(server, 8);
        let reason = tokio::time::timeout(Duration::from_secs(1), frames.hung_up())
            .await
            .expect("a too-large line does not park");
        assert_eq!(reason, HungUp::TooLarge);
        assert_eq!(frames.queued.len(), 1);
        drop(client);
    }

    #[tokio::test]
    async fn an_unterminated_last_line_is_queued_and_the_hang_up_reported() {
        let (mut client, server) = tokio::io::duplex(64);
        client.write_all(b"first\nlast").await.unwrap();
        drop(client);
        let mut frames = Frames::new(server, 1024);
        let reason = tokio::time::timeout(Duration::from_secs(1), frames.hung_up())
            .await
            .expect("an unterminated last line does not park the read-ahead");
        assert_eq!(reason, HungUp::Eof);
        assert_eq!(frames.take_queued(), Some(b"first".to_vec()));
        assert_eq!(frames.take_queued(), Some(b"last".to_vec()));
        assert_eq!(frames.take_queued(), None);
        assert_eq!(frames.queued_bytes, 0);
        assert_eq!(frames.next().await, Frame::End);
    }

    #[tokio::test]
    async fn a_hang_up_is_reported_as_eof() {
        let mut frames = Frames::new(&b"one\n"[..], 16);
        assert_eq!(frames.hung_up().await, HungUp::Eof);
        assert_eq!(frames.next().await, line("one"));
        assert_eq!(frames.next().await, Frame::End);
    }
}
