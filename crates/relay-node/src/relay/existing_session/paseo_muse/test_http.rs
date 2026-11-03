//! Test-only HTTP request draining: replying while the POST body remains
//! unread can reset the connection and hide the fixture's intended status.
use std::io::{Error, ErrorKind, Read, Result};

const REQUEST_LIMIT: usize = 64 * 1024;

pub(super) fn read_request(reader: &mut impl Read) -> Result<Vec<u8>> {
    let mut request = Vec::new();
    let mut buffer = [0u8; 2048];
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        if std::time::Instant::now() >= deadline {
            return Err(Error::new(ErrorKind::TimedOut, "test POST drain timed out"));
        }
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            return Err(Error::new(ErrorKind::UnexpectedEof, "incomplete test POST"));
        }
        request.extend_from_slice(&buffer[..count]);
        if request.len() > REQUEST_LIMIT {
            return Err(Error::new(ErrorKind::InvalidData, "test POST is too large"));
        }
        if let Some(total) = request_size(&request)? {
            if request.len() >= total {
                request.truncate(total);
                return Ok(request);
            }
        }
    }
}

fn request_size(request: &[u8]) -> Result<Option<usize>> {
    let Some(end) = request.windows(4).position(|window| window == b"\r\n\r\n") else {
        return Ok(None);
    };
    let headers = String::from_utf8_lossy(&request[..end]);
    let length = headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().ok())
            .flatten()
    });
    let total = length
        .and_then(|length| (end + 4).checked_add(length))
        .filter(|total| *total <= REQUEST_LIMIT)
        .ok_or_else(|| Error::new(ErrorKind::InvalidData, "invalid test POST length"))?;
    Ok(Some(total))
}

#[test]
fn a_fragmented_post_is_drained_through_its_complete_body() {
    struct Fragmented(std::io::Cursor<Vec<u8>>);
    impl Read for Fragmented {
        fn read(&mut self, buffer: &mut [u8]) -> Result<usize> {
            let count = buffer.len().min(3);
            self.0.read(&mut buffer[..count])
        }
    }
    let request = b"POST /mcp/agents HTTP/1.1\r\nContent-Length: 11\r\n\r\nhello world";
    let mut reader = Fragmented(std::io::Cursor::new(request.to_vec()));
    assert_eq!(read_request(&mut reader).unwrap(), request);
}

#[test]
fn incomplete_or_oversized_fixture_posts_fail_within_the_read_bound() {
    let mut incomplete = &b"POST / HTTP/1.1\r\nContent-Length: 5\r\n\r\nabc"[..];
    assert_eq!(
        read_request(&mut incomplete).unwrap_err().kind(),
        ErrorKind::UnexpectedEof
    );
    let mut oversized = &b"POST / HTTP/1.1\r\nContent-Length: 65537\r\n\r\n"[..];
    assert_eq!(
        read_request(&mut oversized).unwrap_err().kind(),
        ErrorKind::InvalidData
    );
}
