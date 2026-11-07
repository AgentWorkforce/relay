//! Provider-specific native routes. Never enter the ordinary peer fallback.
use super::*;

impl LocalInjector {
    /// Spawned OpenCode agents use the managed OpenCode route whatever its
    /// flag says, so its injector is always ready.
    pub fn with_managed(mut self, managed: Arc<ManagedSessions>) -> Self {
        self.opencode = opencode_existing::OpenCodeInjector::system(
            self.table.clone(),
            &managed.journal("opencode"),
        )
        .ok();
        self.managed = Some(managed);
        self
    }

    pub(super) fn inject_managed(
        &self,
        target: &Target,
        delivery_id: &str,
        message_id: &str,
        text: &str,
    ) -> InjectOutcome {
        let Some(manager) = &self.managed else {
            return InjectOutcome::Refused(
                "No verified probe-managed route for this session.".into(),
            );
        };
        let Some(binding) = manager.binding(target) else {
            return InjectOutcome::Refused(
                "No verified probe-managed route for this session.".into(),
            );
        };
        self.deliver_managed(manager, target, binding, delivery_id, message_id, text)
    }

    /// One delivery into an open OpenCode session through its plugin
    /// socket, with the managed route's journal, deterministic message id
    /// and correlated-assistant receipt.
    pub(super) fn inject_opencode_open(
        &self,
        registration: &crate::relay::store::Registration,
        delivery_id: &str,
        message_id: &str,
        text: &str,
    ) -> InjectOutcome {
        self.inject_opencode_open_mode(registration, delivery_id, message_id, text, None)
    }

    fn inject_opencode_open_mode(
        &self,
        registration: &crate::relay::store::Registration,
        delivery_id: &str,
        message_id: &str,
        text: &str,
        admit: Option<&(dyn Fn() -> bool + Send + Sync)>,
    ) -> InjectOutcome {
        let Some(journal) = &self.config.opencode_open_journal else {
            return InjectOutcome::Refused("The OpenCode plugin route is turned off.".into());
        };
        let binding = match self.opencode_open_binding(registration) {
            Ok(binding) => binding,
            Err(outcome) => return outcome,
        };
        let injector =
            match opencode_existing::OpenCodeInjector::system(self.table.clone(), journal) {
                Ok(injector) => injector,
                // Nothing has been sent yet.
                Err(_) => {
                    return InjectOutcome::Retry(
                        "The OpenCode delivery journal is unavailable.".into(),
                    )
                }
            };
        self.submit_opencode(
            &injector,
            &binding,
            registration,
            delivery_id,
            message_id,
            text,
            admit,
        )
    }

    fn submit_opencode(
        &self,
        injector: &opencode_existing::OpenCodeInjector,
        binding: &opencode_existing::Binding,
        registration: &crate::relay::store::Registration,
        delivery_id: &str,
        message_id: &str,
        text: &str,
        admit: Option<&(dyn Fn() -> bool + Send + Sync)>,
    ) -> InjectOutcome {
        let key = format!("{}\0{message_id}", registration.target.key());
        let cancelled = Arc::new(AtomicBool::new(false));
        self.managed_cancellations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(key.clone(), cancelled.clone());
        let request = opencode_existing::Request {
            binding,
            relay_workspace_id: &binding.relay_workspace_id,
            delivery_id,
            message_id,
            text,
            timeout: Duration::from_secs(120),
            cancelled: &cancelled,
        };
        let outcome = if let Some(admit) = admit {
            injector.inject_native_guarded(&request, admit)
        } else {
            injector.inject(&request)
        };
        self.managed_cancellations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&key);
        match outcome {
            opencode_existing::Outcome::Completed { .. } => InjectOutcome::Delivered,
            opencode_existing::Outcome::Waiting(_) => {
                InjectOutcome::Waiting("The OpenCode session is busy or not ready.".into())
            }
            opencode_existing::Outcome::InDoubt(_) => InjectOutcome::InDoubt(
                "OpenCode may have accepted this message; operator reconciliation is required."
                    .into(),
            ),
            opencode_existing::Outcome::Refused(_) => {
                InjectOutcome::Refused("The OpenCode session refused this delivery.".into())
            }
        }
    }

    fn managed_opencode_binding(
        &self,
        registration: &crate::relay::store::Registration,
    ) -> Option<opencode_existing::Binding> {
        let ManagedBinding::OpenCode(binding) =
            self.managed.as_ref()?.binding(&registration.target)?
        else {
            return None;
        };
        Some(binding)
    }

    fn inject_managed_opencode_native(
        &self,
        registration: &crate::relay::store::Registration,
        route: &crate::relay::inject::DeliveryRoute<'_>,
        text: &str,
        admit: &(dyn Fn() -> bool + Send + Sync),
    ) -> InjectOutcome {
        let Some(binding) = self.managed_opencode_binding(registration) else {
            return InjectOutcome::Refused(
                "No verified probe-managed route for this session.".into(),
            );
        };
        let Some(injector) = self.opencode.as_ref() else {
            return InjectOutcome::Refused("The managed OpenCode route is unavailable.".into());
        };
        self.submit_opencode(
            injector,
            &binding,
            registration,
            route.delivery_id,
            route.message_id,
            text,
            Some(admit),
        )
    }

    pub(super) fn has_native_continuation_choice(
        &self,
        registration: &crate::relay::store::Registration,
        route: &crate::relay::inject::DeliveryRoute<'_>,
    ) -> bool {
        match registration.target.kind {
            SessionKind::Codex => self
                .codex
                .native_choice(&registration.target.id, route.message_id),
            SessionKind::Pi => crate::relay::pi::has_native_choice(
                &self.config.pi,
                self.config.uid,
                registration,
                route.message_id,
            ),
            SessionKind::OpenCode => self
                .opencode
                .as_ref()
                .is_some_and(|injector| injector.has_native_choice(route.delivery_id)),
            SessionKind::OpenCodeOpen => {
                self.config
                    .opencode_open_journal
                    .as_ref()
                    .is_some_and(|journal| {
                        opencode_existing::OpenCodeInjector::system(self.table.clone(), journal)
                            .is_ok_and(|injector| injector.has_native_choice(route.delivery_id))
                    })
            }
            _ => false,
        }
    }

    pub(super) fn can_continue_native(
        &self,
        registration: &crate::relay::store::Registration,
    ) -> bool {
        if !crate::relay::native_continuation::eligible(registration) {
            return false;
        }
        match registration.target.kind {
            SessionKind::Codex => self.codex.native_continuation(&registration.target.id),
            SessionKind::Pi => crate::relay::pi::native_continuation(
                &self.config.pi,
                &*self.table,
                self.config.uid,
                registration,
            ),
            SessionKind::OpenCode => {
                self.managed_opencode_binding(registration)
                    .is_some_and(|binding| {
                        self.opencode
                            .as_ref()
                            .is_some_and(|injector| injector.native_continuation(&binding))
                    })
            }
            SessionKind::OpenCodeOpen => {
                let Some(journal) = self.config.opencode_open_journal.as_ref() else {
                    return false;
                };
                let Ok(binding) = self.opencode_open_binding(registration) else {
                    return false;
                };
                opencode_existing::OpenCodeInjector::system(self.table.clone(), journal)
                    .is_ok_and(|injector| injector.native_continuation(&binding))
            }
            _ => false,
        }
    }

    pub(super) fn deliver_native_continuation(
        &self,
        registration: &crate::relay::store::Registration,
        route: &crate::relay::inject::DeliveryRoute<'_>,
        text: &str,
        admit: &(dyn Fn() -> bool + Send + Sync),
    ) -> InjectOutcome {
        if !route.native || !crate::relay::native_continuation::eligible(registration) {
            return InjectOutcome::Refused(
                "This session cannot accept native mobile input.".into(),
            );
        }
        match registration.target.kind {
            SessionKind::Codex => self.codex.inject_native_existing_guarded(
                &registration.target.id,
                route.message_id,
                text,
                admit,
            ),
            SessionKind::Pi => crate::relay::pi::send_native_guarded(
                &self.config.pi,
                &*self.table,
                self.config.uid,
                registration,
                route.message_id,
                text,
                admit,
            ),
            SessionKind::OpenCode => {
                self.inject_managed_opencode_native(registration, route, text, admit)
            }
            SessionKind::OpenCodeOpen => self.inject_opencode_open_mode(
                registration,
                route.delivery_id,
                route.message_id,
                text,
                Some(admit),
            ),
            _ => InjectOutcome::Refused(
                "Native mobile continuation is unavailable for this session.".into(),
            ),
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::relay::managed_sessions::ManagedRuntime;
    use crate::relay::opencode_existing::{HttpResponse, HttpTransport, SystemClock};
    use crate::relay::process::{FakeProcess, FakeProcesses};
    use serde_json::{json, Value};
    use std::sync::atomic::Ordering;

    struct Runtime {
        binding: ManagedBinding,
        live: Arc<AtomicBool>,
    }
    impl ManagedRuntime for Runtime {
        fn launch(&self, _: &ManagedLaunch, _: &Path) -> Result<ManagedBinding, ()> {
            Ok(self.binding.clone())
        }
        fn verify(&self, binding: &ManagedBinding) -> bool {
            *binding == self.binding && self.live.load(Ordering::SeqCst)
        }
        fn terminate(&self, _: &ManagedBinding) {}
    }

    #[derive(Default)]
    struct Provider {
        prompt: Mutex<Option<Value>>,
        posts: std::sync::atomic::AtomicUsize,
    }
    impl HttpTransport for Provider {
        fn request(
            &self,
            method: &str,
            url: &str,
            _: &str,
            _: &Path,
            body: Option<&[u8]>,
            _: Duration,
        ) -> Option<HttpResponse> {
            let value = if url.ends_with("/global/health") {
                json!({"healthy":true,"version":"1.18.35"})
            } else if url.ends_with("/session/status") {
                json!({})
            } else if url.ends_with("/session/ses_native") {
                json!({"id":"ses_native","projectID":"project","directory":"/synthetic","time":{}})
            } else if method == "POST" && url.ends_with("/prompt_async") {
                self.posts.fetch_add(1, Ordering::SeqCst);
                *self.prompt.lock().ok()? = Some(serde_json::from_slice(body?).ok()?);
                return Some(HttpResponse {
                    status: 204,
                    body: Vec::new(),
                });
            } else {
                let prompt = self.prompt.lock().ok()?.clone()?;
                let user = json!({"info":{"id":prompt["messageID"],"role":"user","sessionID":"ses_native"},
                    "parts":prompt["parts"]});
                if url.ends_with("/message") {
                    json!([user, {"info":{"id":"msg_final","role":"assistant","sessionID":"ses_native",
                        "parentID":prompt["messageID"],"finish":"stop","time":{"completed":3}},
                        "parts":[{"type":"text","text":"Completed"},{"type":"step-finish",
                            "sessionID":"ses_native","messageID":"msg_final","reason":"stop"}]}])
                } else {
                    user
                }
            };
            Some(HttpResponse {
                status: 200,
                body: serde_json::to_vec(&value).ok()?,
            })
        }
    }

    #[test]
    fn native_managed_opencode_uses_sealed_live_binding_and_same_reply_journal() {
        let temp = tempfile::tempdir().unwrap();
        let uid = crate::relay::peer::current_uid();
        let executable = std::env::current_exe().unwrap();
        let table = Arc::new(FakeProcesses::default());
        table.insert(
            42,
            FakeProcess {
                parent: 1,
                uid,
                start: 777,
                executable: Some(executable.clone()),
                arguments: vec![
                    "opencode".into(),
                    "serve".into(),
                    "--hostname".into(),
                    "127.0.0.1".into(),
                    "--port".into(),
                    "4096".into(),
                ],
                environment: [
                    ("OPENCODE_SERVER_USERNAME".into(), "relay".into()),
                    (
                        "OPENCODE_SERVER_PASSWORD".into(),
                        "synthetic-password".into(),
                    ),
                    (
                        "AGENT_RELAY_MANAGED_SESSION_MARKER".into(),
                        "synthetic-marker".into(),
                    ),
                ]
                .into(),
                tcp_listeners: vec![("127.0.0.1".into(), 4096)],
                ..FakeProcess::default()
            },
        );
        let mut binding = opencode_existing::Binding {
            relay_workspace_id: "workspace".into(),
            owner_id: "owner".into(),
            session_id: "ses_native".into(),
            endpoint: "http://127.0.0.1:4096".into(),
            server_pid: 42,
            server_start: 777,
            server_uid: uid,
            executable,
            directory: "/synthetic".into(),
            project_id: "project".into(),
            opencode_workspace_id: None,
            credential_reference: String::new(),
        };
        binding.credential_reference =
            opencode_existing::credential_reference(&binding, "synthetic-marker");
        let managed = ManagedBinding::OpenCode(binding.clone());
        let live = Arc::new(AtomicBool::new(true));
        let manager = Arc::new(ManagedSessions::new(
            temp.path().join("managed"),
            HashSet::new(),
            Arc::new(Runtime {
                binding: managed.clone(),
                live: live.clone(),
            }),
        ));
        manager.adopt(managed).unwrap();
        let config = LocalConfig::from_env(&|_| None, temp.path());
        let router = CodexRouter::new(Arc::new(SystemCodexRoutes::new(
            config.codex.clone(),
            table.clone(),
            uid,
        )));
        let mut injector =
            LocalInjector::new(config, table.clone(), router, ServingPath::default())
                .with_managed(manager.clone());
        let provider = Arc::new(Provider::default());
        injector.opencode = Some(
            opencode_existing::OpenCodeInjector::new(
                table,
                provider.clone(),
                Arc::new(SystemClock),
                &manager.journal("opencode"),
            )
            .unwrap(),
        );
        let registration: crate::relay::store::Registration = serde_json::from_value(json!({
            "name":"managed","agentID":"agent","target":{"kind":"opencode","id":"ses_native"},
            "baseURL":"https://example.test","registeredAt":"2026-10-25T00:00:00Z"
        }))
        .unwrap();
        let route = crate::relay::inject::DeliveryRoute {
            delivery_id: "native-delivery",
            message_id: "native-message",
            native: true,
            ..Default::default()
        };
        assert!(injector.can_continue_native(&registration));
        assert_eq!(
            injector
                .deliver_native_continuation(&registration, &route, "Please continue", &|| true),
            InjectOutcome::Delivered
        );
        assert_eq!(
            injector
                .deliver_native_continuation(&registration, &route, "Please continue", &|| true),
            InjectOutcome::Delivered
        );
        assert_eq!(provider.posts.load(Ordering::SeqCst), 1);
        assert!(injector.managed_cancellations.lock().unwrap().is_empty());
        assert_eq!(
            injector
                .final_answer_registered(
                    &registration,
                    &crate::relay::delivery::policy::MessageRef::of(route.message_id)
                )
                .as_deref(),
            Some("Completed")
        );
        assert_eq!(
            injector.inject_registered(
                &registration,
                route.delivery_id,
                route.message_id,
                "peer wrapper"
            ),
            InjectOutcome::Delivered,
            "original native receipt is acknowledged without another turn"
        );
        live.store(false, Ordering::SeqCst);
        assert!(!injector.can_continue_native(&registration));
        assert!(matches!(
            injector
                .deliver_native_continuation(&registration, &route, "Please continue", &|| true),
            InjectOutcome::Refused(_)
        ));
        assert_eq!(provider.posts.load(Ordering::SeqCst), 1);
    }
}
