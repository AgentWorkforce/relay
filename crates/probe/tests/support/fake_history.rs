//! A loopback RelayHistory receiver: every request recorded, every batch
//! accepted, or answered with a fixed status while one is set.

#![allow(dead_code)]

use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Clone, Debug)]
pub struct Recorded {
    pub method: String,
    pub path: String,
    pub authorization: Option<String>,
    pub body: String,
}

#[derive(Default)]
pub struct Behaviour {
    /// Answer every request with this status instead of a receipt.
    pub status: Option<u16>,
    /// The `error.code` that status carries, as the receiver types its 409.
    pub error_code: Option<&'static str>,
    /// The batch size receipts publish (`limits.maxRecords`).
    pub max_records: Option<usize>,
    /// How long each batch is held before its receipt.
    pub delay: Duration,
}

pub struct FakeHistory {
    pub base_url: String,
    pub requests: Arc<Mutex<Vec<Recorded>>>,
    pub behaviour: Arc<Mutex<Behaviour>>,
}

impl FakeHistory {
    pub fn start(behaviour: Behaviour) -> FakeHistory {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let requests: Arc<Mutex<Vec<Recorded>>> = Arc::default();
        let behaviour = Arc::new(Mutex::new(behaviour));
        let (seen, shared) = (requests.clone(), behaviour.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { return };
                let (seen, shared) = (seen.clone(), shared.clone());
                std::thread::spawn(move || serve(stream, &seen, &shared));
            }
        });
        FakeHistory {
            base_url,
            requests,
            behaviour,
        }
    }

    pub fn requests(&self) -> Vec<Recorded> {
        self.requests.lock().unwrap().clone()
    }

    /// Batch requests, whatever they were answered.
    pub fn batches(&self) -> Vec<Recorded> {
        self.requests()
            .into_iter()
            .filter(|request| request.path == "/v1/delivery/batches")
            .collect()
    }

    /// Whether any request body carried `marker`.
    pub fn received(&self, marker: &str) -> bool {
        self.requests()
            .iter()
            .any(|request| request.body.contains(marker))
    }
}

fn serve(stream: std::net::TcpStream, seen: &Mutex<Vec<Recorded>>, behaviour: &Mutex<Behaviour>) {
    let mut writer = stream.try_clone().unwrap();
    let mut reader = BufReader::new(stream);
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let mut parts = line.split_whitespace();
        let method = parts.next().unwrap_or_default().to_string();
        let path = parts
            .next()
            .unwrap_or_default()
            .split('?')
            .next()
            .unwrap_or_default()
            .to_string();
        let (mut length, mut authorization) = (0, None);
        loop {
            let mut header = String::new();
            if reader.read_line(&mut header).unwrap_or(0) == 0 {
                return;
            }
            if header == "\r\n" {
                break;
            }
            let (name, value) = header.split_once(':').unwrap_or((&header, ""));
            match name.to_ascii_lowercase().as_str() {
                "content-length" => length = value.trim().parse().unwrap_or(0),
                "authorization" => authorization = Some(value.trim().to_string()),
                _ => {}
            }
        }
        let mut body = vec![0; length];
        if reader.read_exact(&mut body).is_err() {
            return;
        }
        let body = String::from_utf8_lossy(&body).into_owned();
        seen.lock().unwrap().push(Recorded {
            method,
            path: path.clone(),
            authorization,
            body: body.clone(),
        });
        let (status, error_code, max_records, delay) = {
            let behaviour = behaviour.lock().unwrap();
            (
                behaviour.status,
                behaviour.error_code,
                behaviour.max_records,
                behaviour.delay,
            )
        };
        let (status, answer) = match status {
            Some(status) => (
                status,
                match error_code {
                    Some(code) => json!({"error": {"code": code, "message": "fixture"}}),
                    None => json!({"error": "fixture"}),
                },
            ),
            None if path == "/v1/delivery/batches" => {
                std::thread::sleep(delay);
                let request: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                let batch = &request["batch"];
                let accepted: Vec<Value> = batch["records"]
                    .as_array()
                    .map(|records| {
                        records
                            .iter()
                            .map(|record| record["revision_id"].clone())
                            .collect()
                    })
                    .unwrap_or_default();
                let mut receipt = json!({
                    "protocolVersion": 1,
                    "batchId": batch["batch_id"],
                    "acceptedRevisionIds": accepted,
                    "unsupportedRevisionIds": [],
                    "acceptanceLevel": "durable",
                });
                if let Some(records) = max_records {
                    receipt["limits"] = json!({"maxRecords": records});
                }
                (200, receipt)
            }
            None => (200, json!({})),
        };
        let text = answer.to_string();
        if write!(
            writer,
            "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{text}",
            text.len()
        )
        .is_err()
        {
            return;
        }
    }
}
