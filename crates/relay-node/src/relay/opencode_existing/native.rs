//! Owner turns use OpenCode's native user-message API without Relay prose.
//! The private index records the choice before any provider I/O. It survives
//! busy/refused preflight and prevents a later retry becoming a peer turn.
use super::*;
use crate::relay::delivery::policy::MessageRef;

const INDEX_LIMIT: u64 = 4096;

pub(super) fn may_submit(request: &Request<'_>, admit: Option<&dyn Fn() -> bool>) -> bool {
    !request.cancelled.load(Ordering::SeqCst)
        && admit.is_none_or(|check| check())
        && !request.cancelled.load(Ordering::SeqCst)
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
struct NativeTurn {
    binding: String,
    delivery_id: String,
    message_ref: String,
    user_id: String,
    request_hash: String,
}

pub(super) fn valid_reference(value: &str) -> bool {
    value.len() == 12 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn binding_key(binding: &Binding) -> Option<String> {
    serde_json::to_string(binding)
        .ok()
        .map(|value| Journal::digest(&[&value]))
}

fn read_private(path: &Path) -> std::io::Result<Vec<u8>> {
    let file = Journal::private_file(path, false)?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != platform::getuid()
        || metadata.mode() & 0o077 != 0
        || metadata.len() > INDEX_LIMIT
    {
        return Err(std::io::Error::new(
            ErrorKind::PermissionDenied,
            "Invalid OpenCode native receipt",
        ));
    }
    let mut bytes = Vec::new();
    file.take(INDEX_LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() > INDEX_LIMIT as usize {
        return Err(std::io::Error::new(
            ErrorKind::InvalidData,
            "Oversized OpenCode native receipt",
        ));
    }
    Ok(bytes)
}

impl Journal {
    fn native_choice_path(&self, delivery_id: &str) -> PathBuf {
        self.directory
            .join(format!("native-{}.choice", Self::digest(&[delivery_id])))
    }

    pub(super) fn previous_native(&self, request: &Request<'_>) -> Option<Outcome> {
        let path = self.native_choice_path(request.delivery_id);
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == ErrorKind::NotFound => return None,
            _ => {}
        }
        Some(
            self.native_receipt(request, &path)
                .unwrap_or(Outcome::InDoubt(Failure::PriorAttemptUncertain)),
        )
    }

    /// The saved native choice for exactly this binding, delivery and message.
    fn native_turn(&self, request: &Request<'_>, path: &Path) -> Option<NativeTurn> {
        let turn: NativeTurn = serde_json::from_slice(&read_private(path).ok()?).ok()?;
        (turn.binding == binding_key(request.binding)?
            && turn.delivery_id == request.delivery_id
            && turn.message_ref == MessageRef::of(request.message_id))
        .then_some(turn)
    }

    fn native_receipt(&self, request: &Request<'_>, path: &Path) -> Option<Outcome> {
        let turn = self.native_turn(request, path)?;
        let bytes = match read_private(&self.path(request.delivery_id)) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                return Some(Outcome::Refused(Failure::SessionMismatch));
            }
            Err(_) => return None,
        };
        let value = String::from_utf8(bytes).ok()?;
        let mut lines = value.lines();
        if lines.next() == Some("completed")
            && lines.next() == Some(&turn.request_hash)
            && lines.next() == Some(format!("opencode:{}", turn.user_id).as_str())
        {
            Some(Outcome::Completed {
                receipt_id: format!("opencode:{}", turn.user_id),
            })
        } else {
            None
        }
    }

    fn native_reply_path(&self, binding: &str, reference: &str) -> PathBuf {
        self.directory.join(format!(
            "native-{}.reply",
            Self::digest(&[binding, reference])
        ))
    }

    fn write_native_index(&self, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        let temp = self
            .directory
            .join(format!(".native-{}.tmp", random_hex(32)));
        let result = (|| {
            let mut file = Self::private_file(&temp, true)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            // Publish complete bytes exclusively: never replace a different
            // payload, binding, or colliding short message reference.
            match fs::hard_link(&temp, path) {
                Ok(()) => self.sync_dir(),
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                    if read_private(path)? == bytes {
                        Ok(())
                    } else {
                        Err(std::io::Error::new(
                            ErrorKind::AlreadyExists,
                            "OpenCode native receipt mismatch",
                        ))
                    }
                }
                Err(error) => Err(error),
            }
        })();
        let _ = fs::remove_file(temp);
        result
    }

    fn prepare_native(&self, request: &Request<'_>) -> std::io::Result<()> {
        let binding = binding_key(request.binding).ok_or_else(|| {
            std::io::Error::new(ErrorKind::InvalidData, "Invalid OpenCode binding")
        })?;
        let turn = NativeTurn {
            binding,
            delivery_id: request.delivery_id.into(),
            message_ref: MessageRef::of(request.message_id),
            user_id: OpenCodeInjector::message_id(request),
            request_hash: Self::request_hash(request),
        };
        let bytes = serde_json::to_vec(&turn)?;
        self.write_native_index(&self.native_choice_path(request.delivery_id), &bytes)?;
        self.write_native_index(
            &self.native_reply_path(&turn.binding, &turn.message_ref),
            &bytes,
        )
    }
}

impl OpenCodeInjector {
    /// A native turn keeps its route after opt-out. A pending or accepted
    /// receipt settles only when OpenCode shows the exact original user
    /// message; it is never posted again or resent as peer input.
    pub(super) fn previous_native(&self, request: &Request<'_>) -> Option<Outcome> {
        let outcome = self.journal.previous_native(request)?;
        if outcome != Outcome::InDoubt(Failure::PriorAttemptUncertain) {
            return Some(outcome);
        }
        Some(self.observe_native(request).unwrap_or(outcome))
    }

    // The retry may carry other text (peer framing after opt-out), so the
    // original is recovered from the session and proven by the saved hash.
    fn observe_native(&self, request: &Request<'_>) -> Option<Outcome> {
        let path = self.journal.native_choice_path(request.delivery_id);
        let turn = self.journal.native_turn(request, &path)?;
        let receipt = read_private(&self.journal.path(request.delivery_id)).ok()?;
        let mut lines = std::str::from_utf8(&receipt).ok()?.lines();
        if !matches!(lines.next(), Some("pending" | "accepted"))
            || lines.next() != Some(turn.request_hash.as_str())
        {
            return None;
        }
        let messages = self.answer_messages(request.binding)?;
        let message = messages.iter().find(|message| {
            message["info"]["id"] == turn.user_id
                && message["info"]["sessionID"] == request.binding.session_id
                && message["info"]["role"] == "user"
        })?;
        message["parts"]
            .as_array()?
            .iter()
            .filter_map(|part| {
                (part["type"] == "text")
                    .then(|| part["text"].as_str())
                    .flatten()
            })
            .map(|text| Request { text, ..*request })
            .find(|original| {
                Journal::request_hash(original) == turn.request_hash
                    && Self::message_id(original) == turn.user_id
            })
            .map(|original| self.complete(&original, &turn.user_id))
    }

    /// Durable route choice only: temporary discovery loss must not turn a
    /// pending native delivery into peer text. This grants no submission.
    pub fn has_native_choice(&self, delivery_id: &str) -> bool {
        match fs::symlink_metadata(self.journal.native_choice_path(delivery_id)) {
            Ok(_) => true,
            Err(error) => error.kind() != ErrorKind::NotFound,
        }
    }

    // A delivery may already have been sent with peer framing before opt-in.
    // Its immutable receipt wins over the new route choice. Reconstruct only
    // text proven by that receipt in the authenticated session; never POST.
    fn previous_peer(&self, request: &Request<'_>) -> Option<Outcome> {
        match fs::symlink_metadata(self.journal.native_choice_path(request.delivery_id)) {
            Ok(_) => return None,
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(_) => return Some(Outcome::InDoubt(Failure::JournalUnavailable)),
        }
        let bytes = match read_private(&self.journal.path(request.delivery_id)) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == ErrorKind::NotFound => return None,
            Err(_) => return Some(Outcome::InDoubt(Failure::JournalUnavailable)),
        };
        Some(
            self.reconcile_peer(request, &bytes)
                .unwrap_or(Outcome::InDoubt(Failure::PriorAttemptUncertain)),
        )
    }

    fn reconcile_peer(&self, request: &Request<'_>, bytes: &[u8]) -> Option<Outcome> {
        let receipt = std::str::from_utf8(bytes).ok()?;
        let mut lines = receipt.lines();
        let state = lines.next()?;
        if !matches!(state, "pending" | "accepted" | "completed") {
            return None;
        }
        let hash = lines.next()?;
        let recorded_id = lines.next();
        let messages = self.answer_messages(request.binding)?;
        for message in &messages {
            let Some(parts) = message["parts"].as_array() else {
                continue;
            };
            for text in parts.iter().filter_map(|part| {
                (part["type"] == "text")
                    .then(|| part["text"].as_str())
                    .flatten()
            }) {
                let original = Request { text, ..*request };
                let user_id = Self::message_id(&original);
                if Journal::request_hash(&original) != hash
                    || message["info"]["id"] != user_id
                    || message["info"]["sessionID"] != request.binding.session_id
                    || message["info"]["role"] != "user"
                {
                    continue;
                }
                if state == "completed"
                    && recorded_id != Some(format!("opencode:{user_id}").as_str())
                {
                    return None;
                }
                return Some(self.complete(&original, &user_id));
            }
        }
        None
    }

    /// Read-only capability; no session creation, configuration or tool changes.
    pub fn native_continuation(&self, binding: &Binding) -> bool {
        self.native_capability(binding).is_ok()
    }

    fn native_capability(&self, binding: &Binding) -> Result<(), Failure> {
        if !platform::SUPPORTED || !self.verify_binding(binding, Duration::from_secs(3)) {
            return Err(Failure::SessionMismatch);
        }
        let authorization = route_authorization(&*self.table, binding)?;
        let base = binding.endpoint.trim_end_matches('/');
        let plugin = base.starts_with("unix:");
        let route = if plugin {
            format!("/session/{}/native-continuation", binding.session_id)
        } else {
            "/global/health".into()
        };
        let response = self
            .http
            .request(
                "GET",
                &format!("{base}{route}"),
                &authorization,
                &binding.directory,
                None,
                Duration::from_secs(3),
            )
            .ok_or(Failure::EndpointUnavailable)?;
        if response.status != 200 {
            return Err(Failure::ProviderRefused);
        }
        let value: Value =
            serde_json::from_slice(&response.body).map_err(|_| Failure::ProviderRefused)?;
        let supported = if plugin {
            plugin_capability(&value, &binding.session_id)
        } else {
            // The existing HTTP adapter is the V1 API, tested with 1.18.35.
            // V2 uses a different HTTP contract; only its plugin is supported.
            value["healthy"] == true
                && value["version"]
                    .as_str()
                    .is_some_and(supported_server_version)
        };
        if supported {
            Ok(())
        } else {
            Err(Failure::ProviderRefused)
        }
    }

    pub fn inject_native(&self, request: &Request<'_>) -> Outcome {
        self.inject_native_guarded(request, &|| true)
    }

    /// Revalidate the owner's authority after all provider preflight I/O and
    /// immediately before a new POST. Receipt-only retries never submit.
    pub fn inject_native_guarded(
        &self,
        request: &Request<'_>,
        admit: &dyn Fn() -> bool,
    ) -> Outcome {
        if !Self::valid_request(request) {
            return Outcome::Refused(Failure::InvalidBinding);
        }
        self.journal
            .with_lock(request.binding, || {
                if let Some(outcome) = self.previous_peer(request) {
                    return outcome;
                }
                if self.journal.prepare_native(request).is_err() {
                    return Outcome::InDoubt(Failure::JournalUnavailable);
                }
                // The exact durable choice was validated above. Completion
                // needs no live provider or renewed authority to submit.
                if let Some(outcome @ Outcome::Completed { .. }) =
                    self.journal.previous_native(request)
                {
                    return outcome;
                }
                if let Err(failure) = self.native_capability(request.binding) {
                    return Outcome::Waiting(failure);
                }
                self.inject_locked(request, Some(admit))
            })
            .unwrap_or(Outcome::InDoubt(Failure::JournalUnavailable))
    }

    pub(super) fn has_native_reference(&self, binding: &Binding, message_ref: &str) -> bool {
        let Some(key) = binding_key(binding) else {
            return true;
        };
        match fs::symlink_metadata(self.journal.native_reply_path(&key, message_ref)) {
            Ok(_) => true,
            Err(error) => error.kind() != ErrorKind::NotFound,
        }
    }

    /// Only an accepted native turn in this exact owner/process/session binding
    /// can resolve a short Relay reference. Text markers are never required.
    pub fn native_final_answer(&self, binding: &Binding, message_ref: &str) -> Option<String> {
        if !valid_reference(message_ref) {
            return None;
        }
        let key = binding_key(binding)?;
        let turn: NativeTurn = serde_json::from_slice(
            &read_private(&self.journal.native_reply_path(&key, message_ref)).ok()?,
        )
        .ok()?;
        if turn.binding != key || turn.message_ref != message_ref {
            return None;
        }
        let receipt =
            String::from_utf8(read_private(&self.journal.path(&turn.delivery_id)).ok()?).ok()?;
        let mut lines = receipt.lines();
        if lines.next() != Some("completed")
            || lines.next() != Some(&turn.request_hash)
            || lines.next() != Some(format!("opencode:{}", turn.user_id).as_str())
        {
            return None;
        }
        let messages = self.answer_messages(binding)?;
        if !messages.iter().any(|message| {
            message["info"]["role"] == "user"
                && message["info"]["sessionID"] == binding.session_id
                && message["info"]["id"] == turn.user_id
        }) {
            return None;
        }
        Self::answer_for_user(&messages, &binding.session_id, &turn.user_id)
    }
}

fn supported_server_version(value: &str) -> bool {
    let pieces: Vec<_> = value.split('.').collect();
    if pieces.len() != 3 {
        return false;
    }
    let parsed: Option<Vec<u32>> = pieces.iter().map(|piece| piece.parse().ok()).collect();
    parsed.is_some_and(|v| v[0] == 1 && (v[1], v[2]) >= (18, 35))
}

fn plugin_capability(value: &Value, session_id: &str) -> bool {
    value["protocol"] == 1
        && value["version"].as_u64().is_some_and(|v| v >= 7)
        && value["sessionID"].as_str() == Some(session_id)
        && value["messageID"] == true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_plugin_requires_versioned_exact_session_and_deterministic_message_support() {
        let supported = json!({"protocol":1,"version":7,"sessionID":"ses_exact","messageID":true});
        assert!(plugin_capability(&supported, "ses_exact"));
        for (field, value) in [
            ("protocol", json!(2)),
            ("version", json!(6)),
            ("sessionID", json!("ses_other")),
            ("messageID", json!(false)),
        ] {
            let mut unsupported = supported.clone();
            unsupported[field] = value;
            assert!(!plugin_capability(&unsupported, "ses_exact"));
            unsupported.as_object_mut().unwrap().remove(field);
            assert!(!plugin_capability(&unsupported, "ses_exact"));
        }
    }
}
