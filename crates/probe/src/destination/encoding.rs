//! Request-body compression for delivery batches.
//!
//! The receiver lists the codings it decodes in `limits.contentEncodings`,
//! most preferred first, on `GET /v1/delivery/limits` and on every receipt.
//! A batch is compressed only with a coding the latest of those lists, so an
//! older server, which lists none, keeps receiving the stored bytes as they
//! are. The stored, idempotent body never changes: compression is applied to
//! the bytes on the wire only.
use std::io::Write;

/// zstd's default level. On real delivery batches it compresses 4.5x at about
/// 2 ms of CPU per MiB; higher levels add CPU for a few percent of bytes.
const ZSTD_LEVEL: i32 = 3;

/// A request-body coding this build sends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContentEncoding {
    Zstd,
    Gzip,
}

impl ContentEncoding {
    /// The `Content-Encoding` token.
    pub fn name(self) -> &'static str {
        match self {
            Self::Zstd => "zstd",
            Self::Gzip => "gzip",
        }
    }
    fn parse(token: &str) -> Option<Self> {
        match token {
            "zstd" => Some(Self::Zstd),
            "gzip" => Some(Self::Gzip),
            _ => None,
        }
    }
    /// `body` in this coding, or `None` when that would not be smaller.
    pub fn encode(self, body: &[u8]) -> Option<Vec<u8>> {
        let encoded = match self {
            Self::Zstd => zstd::bulk::compress(body, ZSTD_LEVEL).ok()?,
            Self::Gzip => {
                let mut encoder = flate2::write::GzEncoder::new(
                    Vec::with_capacity(body.len() / 3),
                    flate2::Compression::default(),
                );
                encoder.write_all(body).ok()?;
                encoder.finish().ok()?
            }
        };
        (encoded.len() < body.len()).then_some(encoded)
    }
}

/// The first coding in a published `limits` object's `contentEncodings` that
/// this build sends, in the server's order of preference. `None` when the
/// object lists none of them, or has no such field (an older server).
pub fn published_encoding(limits: &serde_json::Value) -> Option<ContentEncoding> {
    limits
        .get("contentEncodings")?
        .as_array()?
        .iter()
        .find_map(|token| ContentEncoding::parse(token.as_str()?))
}

/// A request body as it goes on the wire.
#[derive(Debug, Clone, Copy)]
pub struct WireBody<'a> {
    pub bytes: &'a [u8],
    /// The coding of `bytes`; `None` for the stored body itself.
    pub encoding: Option<ContentEncoding>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Read;

    #[test]
    fn the_servers_first_supported_coding_is_chosen() {
        let cases = [
            (
                json!({"contentEncodings": ["zstd", "gzip"]}),
                Some(ContentEncoding::Zstd),
            ),
            (
                json!({"contentEncodings": ["gzip", "zstd"]}),
                Some(ContentEncoding::Gzip),
            ),
            (
                json!({"contentEncodings": ["br", "gzip"]}),
                Some(ContentEncoding::Gzip),
            ),
            (json!({"contentEncodings": ["br"]}), None),
            (json!({"contentEncodings": "zstd"}), None),
            (json!({"contentEncodings": []}), None),
            (json!({"maxRecords": 500}), None),
        ];
        for (limits, expected) in cases {
            assert_eq!(published_encoding(&limits), expected, "{limits}");
        }
    }

    #[test]
    fn encoded_bodies_decode_to_the_exact_stored_bytes() {
        let body = serde_json::to_vec(&json!({
            "protocolVersion": 1,
            "batch": {"records": vec![json!({"text": "λ→🦀 repeated tool output"}); 200]},
        }))
        .unwrap();
        let zstd = ContentEncoding::Zstd.encode(&body).unwrap();
        assert_eq!(zstd::bulk::decompress(&zstd, body.len()).unwrap(), body);
        let gzip = ContentEncoding::Gzip.encode(&body).unwrap();
        let mut decoded = Vec::new();
        flate2::read::GzDecoder::new(&gzip[..])
            .read_to_end(&mut decoded)
            .unwrap();
        assert_eq!(decoded, body);
        assert!(zstd.len() < body.len() / 4 && gzip.len() < body.len() / 4);
    }

    #[test]
    fn a_body_compression_would_not_shrink_is_sent_as_stored() {
        assert_eq!(ContentEncoding::Zstd.encode(b"{}"), None);
        assert_eq!(ContentEncoding::Gzip.encode(b"{}"), None);
    }
}
