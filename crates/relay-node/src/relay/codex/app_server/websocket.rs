//! RFC 6455 framing for the app-server client: the upgrade request, masked
//! client frames, and the decoder for what the proxy sends back.

/// Frames larger than this are refused.
pub(super) const MAX_FRAME: u64 = 16 * 1024 * 1024;

pub fn upgrade_request(key: &[u8; 16]) -> Vec<u8> {
    use base64::Engine;
    let key = base64::engine::general_purpose::STANDARD.encode(key);
    format!(
        "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: {key}\r\n\r\n"
    )
    .into_bytes()
}

/// One RFC 6455 client text frame; client frames are always masked.
pub fn frame(payload: &[u8], mask: [u8; 4]) -> Vec<u8> {
    control_frame(0x01, payload, mask)
}

pub(super) fn control_frame(opcode: u8, payload: &[u8], mask: [u8; 4]) -> Vec<u8> {
    let mut frame = vec![0x80 | opcode];
    let length = payload.len() as u64;
    if length < 126 {
        frame.push(length as u8 | 0x80);
    } else if length <= u64::from(u16::MAX) {
        frame.push(126 | 0x80);
        frame.extend_from_slice(&(length as u16).to_be_bytes());
    } else {
        frame.push(127 | 0x80);
        frame.extend_from_slice(&length.to_be_bytes());
    }
    frame.extend_from_slice(&mask);
    frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
    frame
}

/// The HTTP upgrade answer followed by WebSocket frames, decoded as bytes
/// arrive. Partial input stays buffered.
#[derive(Default)]
pub struct Decoder {
    buffer: Vec<u8>,
    upgraded: bool,
    closed: bool,
    pings: Vec<Vec<u8>>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Malformed;

impl Decoder {
    pub fn is_upgraded(&self) -> bool {
        self.upgraded
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }

    pub fn buffered(&self) -> &[u8] {
        &self.buffer
    }

    /// Takes the HTTP upgrade answer once it has fully arrived: whether
    /// the connection is upgraded, or an error for a refused upgrade.
    pub(super) fn upgrade(&mut self) -> Result<bool, Malformed> {
        if self.upgraded {
            return Ok(true);
        }
        let Some(end) = self.buffer.windows(4).position(|w| w == b"\r\n\r\n") else {
            return Ok(false);
        };
        let header = String::from_utf8_lossy(&self.buffer[..end]).to_lowercase();
        if !header.starts_with("http/1.1 101 ") || !header.contains("\r\nupgrade: websocket") {
            return Err(Malformed);
        }
        self.buffer.drain(..end + 4);
        self.upgraded = true;
        Ok(true)
    }

    pub(super) fn take_pings(&mut self) -> Vec<Vec<u8>> {
        std::mem::take(&mut self.pings)
    }

    /// Appends `data` and returns the text payloads it completed; an error
    /// for a refused upgrade or a frame this client does not accept
    /// (fragmented, or over 16 MiB).
    pub fn consume(&mut self, data: &[u8]) -> Result<Vec<Vec<u8>>, Malformed> {
        self.buffer.extend_from_slice(data);
        if !self.upgrade()? {
            return Ok(Vec::new());
        }
        let mut payloads = Vec::new();
        while !self.closed {
            let Some((opcode, payload)) = self.next_frame()? else {
                break;
            };
            match opcode {
                0x01 => payloads.push(payload),
                0x09 => self.pings.push(payload),
                0x08 => self.closed = true,
                _ => {}
            }
        }
        Ok(payloads)
    }

    fn next_frame(&mut self) -> Result<Option<(u8, Vec<u8>)>, Malformed> {
        let Some(header) = FrameHeader::read(&self.buffer)? else {
            return Ok(None);
        };
        let mut payload = self.buffer[header.offset..header.end].to_vec();
        if header.masked {
            let key = &self.buffer[header.offset - 4..header.offset];
            payload
                .iter_mut()
                .enumerate()
                .for_each(|(i, b)| *b ^= key[i % 4]);
        }
        self.buffer.drain(..header.end);
        Ok(Some((header.opcode, payload)))
    }
}

/// A complete frame's bounds. Incomplete headers and payloads stay buffered.
struct FrameHeader {
    opcode: u8,
    masked: bool,
    offset: usize,
    end: usize,
}

impl FrameHeader {
    fn read(buffer: &[u8]) -> Result<Option<Self>, Malformed> {
        let [first, second, ..] = buffer else {
            return Ok(None);
        };
        if first & 0x80 == 0 {
            return Err(Malformed);
        }
        let (length, mut offset) = match second & 0x7f {
            126 => {
                let Some(bytes) = buffer.get(2..4) else {
                    return Ok(None);
                };
                (u64::from(u16::from_be_bytes([bytes[0], bytes[1]])), 4)
            }
            127 => {
                let Some(bytes) = buffer.get(2..10) else {
                    return Ok(None);
                };
                let bytes = bytes.try_into().map_err(|_| Malformed)?;
                (u64::from_be_bytes(bytes), 10)
            }
            length => (u64::from(length), 2),
        };
        if length > MAX_FRAME || (matches!(first & 0x0f, 0x08 | 0x09 | 0x0a) && length > 125) {
            return Err(Malformed);
        }
        let masked = second & 0x80 != 0;
        if masked {
            offset += 4;
        }
        let end = offset + length as usize;
        if buffer.len() < end {
            return Ok(None);
        }
        Ok(Some(Self {
            opcode: first & 0x0f,
            masked,
            offset,
            end,
        }))
    }
}
