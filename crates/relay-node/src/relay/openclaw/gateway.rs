//! The OpenClaw Gateway connection: this core's Ed25519 device identity
//! and the operator handshake over loopback (protocol 3 or 4).
use super::*;
// ---------------------------------------------------------------------------
// Device identity

/// This core's Ed25519 device key, and the token the Gateway issued it.
#[derive(Serialize, Deserialize)]
pub(super) struct StoredDevice {
    pub(super) version: u32,
    /// PKCS#8 v2, base64.
    pub(super) key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) device_token: Option<String>,
}

pub(super) struct Device {
    pub(super) pair: ring::signature::Ed25519KeyPair,
    pub(super) stored: StoredDevice,
}

impl Device {
    pub(super) fn load_or_create(path: &Path) -> Result<Device, String> {
        use ring::signature::Ed25519KeyPair;
        if let Ok(bytes) = std::fs::read(path) {
            let stored: StoredDevice =
                serde_json::from_slice(&bytes).map_err(|_| "OpenClaw device key is unreadable.")?;
            let pkcs8 = STANDARD
                .decode(&stored.key)
                .map_err(|_| "OpenClaw device key is unreadable.")?;
            let pair = Ed25519KeyPair::from_pkcs8(&pkcs8)
                .map_err(|_| "OpenClaw device key is unreadable.")?;
            return Ok(Device { pair, stored });
        }
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng)
            .map_err(|_| "Could not create an OpenClaw device key.")?;
        let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref())
            .map_err(|_| "Could not create an OpenClaw device key.")?;
        let stored = StoredDevice {
            version: 1,
            key: STANDARD.encode(pkcs8.as_ref()),
            device_token: None,
        };
        let device = Device { pair, stored };
        device.save(path)?;
        Ok(device)
    }

    pub(super) fn save(&self, path: &Path) -> Result<(), String> {
        let bytes = serde_json::to_vec(&self.stored).map_err(|e| e.to_string())?;
        crate::relay::mailbox::write_private(path, &bytes)
    }

    pub(super) fn public_key(&self) -> &[u8] {
        use ring::signature::KeyPair;
        self.pair.public_key().as_ref()
    }

    /// `sha256(raw public key)`, hex: the fingerprint the Gateway derives.
    pub(super) fn id(&self) -> String {
        hex(&Sha256::digest(self.public_key()))
    }

    pub(super) fn sign(&self, payload: &str) -> String {
        URL_SAFE_NO_PAD.encode(self.pair.sign(payload.as_bytes()).as_ref())
    }
}

pub(super) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub(super) fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// The v3 device-auth payload (`buildDeviceAuthPayloadV3`): the Gateway
/// compares it byte for byte.
pub(super) fn device_payload(device_id: &str, signed_at: u64, token: &str, nonce: &str) -> String {
    [
        "v3",
        device_id,
        CLIENT_ID,
        CLIENT_MODE,
        ROLE,
        &SCOPES.join(","),
        &signed_at.to_string(),
        token,
        nonce,
        platform(),
        "",
    ]
    .join("|")
}

// ---------------------------------------------------------------------------
// The Gateway connection

/// One failed exchange.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GatewayError {
    /// Nothing listens on the port, or the connection broke before the
    /// request was written: it certainly did not arrive.
    Unreachable,
    /// The Gateway is finishing startup or asked for a retry.
    Busy,
    /// The Gateway rejected the connect or the request.
    Rejected { code: String, message: String },
    /// The request was written but no response came: it may have arrived.
    NoResponse,
}

type Socket = tungstenite::WebSocket<TcpStream>;

pub struct Connection {
    pub(super) socket: Socket,
    pub(super) next: u64,
    /// What the Gateway offered in its `hello-ok`.
    pub features: Features,
}

pub(super) fn rejected(error: &Value) -> GatewayError {
    let code = error["details"]["code"]
        .as_str()
        .or(error["code"].as_str())
        .unwrap_or("ERROR")
        .to_string();
    if error["code"].as_str() == Some("UNAVAILABLE") || error["retryable"].as_bool() == Some(true) {
        return GatewayError::Busy;
    }
    let message: String = error["message"]
        .as_str()
        .unwrap_or_default()
        .chars()
        .take(200)
        .collect();
    GatewayError::Rejected { code, message }
}

impl Connection {
    /// Connects to the Gateway on loopback `port` and completes the
    /// operator handshake.
    pub fn open(config: &OpenClawConfig, gateway: &Gateway) -> Result<Connection, GatewayError> {
        let deadline = Instant::now() + TIMEOUT;
        let address = SocketAddr::from(([127, 0, 0, 1], gateway.port));
        let stream = TcpStream::connect_timeout(&address, Duration::from_secs(3))
            .map_err(|_| GatewayError::Unreachable)?;
        stream.set_read_timeout(Some(TIMEOUT)).ok();
        stream.set_write_timeout(Some(TIMEOUT)).ok();
        stream.set_nodelay(true).ok();
        let url = format!("ws://127.0.0.1:{}/", gateway.port);
        let (socket, _) = tungstenite::client::client(url.as_str(), stream)
            .map_err(|_| GatewayError::Unreachable)?;
        let mut connection = Connection {
            socket,
            next: 0,
            features: Features::from_hello(&Value::Null),
        };
        let challenge = connection.until(deadline, |frame| {
            (frame["type"] == "event" && frame["event"] == "connect.challenge")
                .then(|| frame["payload"].clone())
        })?;
        let (Some(nonce), Some(ts)) = (challenge["nonce"].as_str(), challenge["ts"].as_u64())
        else {
            return Err(GatewayError::Rejected {
                code: "CHALLENGE".into(),
                message: "The Gateway sent a malformed challenge.".into(),
            });
        };
        let mut device = Device::load_or_create(&config.device_path()).map_err(|message| {
            GatewayError::Rejected {
                code: "DEVICE".into(),
                message,
            }
        })?;
        let token = gateway
            .secret
            .as_ref()
            .map(Secret::token)
            .unwrap_or_default();
        let auth = match &gateway.secret {
            Some(Secret::Token(token)) => json!({ "token": token }),
            Some(Secret::Password(password)) => json!({ "password": password }),
            None => json!({}),
        };
        let device_id = device.id();
        let params = json!({
            "minProtocol": MIN_PROTOCOL,
            "maxProtocol": MAX_PROTOCOL,
            "client": {
                "id": CLIENT_ID,
                "displayName": "Agent Relay",
                "version": env!("CARGO_PKG_VERSION"),
                "platform": platform(),
                "mode": CLIENT_MODE,
            },
            "role": ROLE,
            "scopes": SCOPES,
            "caps": ["hello-health-on-demand"],
            "auth": auth,
            "userAgent": concat!("agent-relay-desktop/", env!("CARGO_PKG_VERSION")),
            "device": {
                "id": device_id,
                "publicKey": URL_SAFE_NO_PAD.encode(device.public_key()),
                "signature": device.sign(&device_payload(&device_id, ts, token, nonce)),
                "signedAt": ts,
                "nonce": nonce,
            },
        });
        let hello = connection.call_until("connect", params, deadline)?;
        connection.features = Features::from_hello(&hello);
        config.seen.record(&connection.features);
        if let Some(issued) = hello["auth"]["deviceToken"].as_str() {
            if device.stored.device_token.as_deref() != Some(issued) {
                device.stored.device_token = Some(issued.to_string());
                let _ = device.save(&config.device_path());
            }
        }
        Ok(connection)
    }

    /// Calls `method` and waits for its response.
    pub fn call(&mut self, method: &str, params: Value) -> Result<Value, GatewayError> {
        self.call_until(method, params, Instant::now() + TIMEOUT)
    }

    pub(super) fn call_until(
        &mut self,
        method: &str,
        params: Value,
        deadline: Instant,
    ) -> Result<Value, GatewayError> {
        self.next += 1;
        let id = format!("relay-{}", self.next);
        let frame = json!({ "type": "req", "id": id, "method": method, "params": params });
        self.socket
            .send(tungstenite::Message::Text(frame.to_string()))
            .map_err(|_| GatewayError::Unreachable)?;
        let response = self
            .until(deadline, |frame| {
                (frame["type"] == "res" && frame["id"] == id.as_str()).then(|| frame.clone())
            })
            .map_err(|error| match error {
                GatewayError::Unreachable => GatewayError::NoResponse,
                other => other,
            })?;
        if response["ok"].as_bool() == Some(true) {
            Ok(response["payload"].clone())
        } else {
            Err(rejected(&response["error"]))
        }
    }

    /// Reads frames until `pick` takes one, skipping events it ignores.
    pub(super) fn until<T>(
        &mut self,
        deadline: Instant,
        mut pick: impl FnMut(&Value) -> Option<T>,
    ) -> Result<T, GatewayError> {
        loop {
            if Instant::now() >= deadline {
                return Err(GatewayError::NoResponse);
            }
            let message = self.socket.read().map_err(|_| GatewayError::Unreachable)?;
            let text = match message {
                tungstenite::Message::Text(text) => text,
                tungstenite::Message::Close(_) => return Err(GatewayError::Unreachable),
                _ => continue,
            };
            let Ok(frame) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if let Some(found) = pick(&frame) {
                return Ok(found);
            }
        }
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        let _ = self.socket.close(None);
        let _ = self.socket.flush();
    }
}
