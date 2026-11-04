//! Authenticated transcript reads shared by peer and native answer correlation.
use super::*;

impl OpenCodeInjector {
    pub(super) fn answer_messages(&self, binding: &Binding) -> Option<Vec<Value>> {
        if !binding_valid(binding, &binding.relay_workspace_id) {
            return None;
        }
        let authorization = route_authorization(&*self.table, binding).ok()?;
        let base = binding.endpoint.trim_end_matches('/');
        let session = self.http.request(
            "GET",
            &format!("{base}/session/{}", binding.session_id),
            &authorization,
            &binding.directory,
            None,
            Duration::from_secs(10),
        )?;
        if session.status != 200 || !session_matches(&session.body, binding) {
            return None;
        }
        let response = self.http.request(
            "GET",
            &format!("{base}/session/{}/message", binding.session_id),
            &authorization,
            &binding.directory,
            None,
            Duration::from_secs(10),
        )?;
        if response.status != 200 {
            return None;
        }
        serde_json::from_slice::<Vec<Value>>(&response.body).ok()
    }

    pub(super) fn answer_for_user(
        messages: &[Value],
        session_id: &str,
        user_id: &str,
    ) -> Option<String> {
        let receipt = completion(&serde_json::to_vec(messages).ok()?, session_id, user_id)
            .and_then(Result::ok)?
            .strip_prefix("opencode:")?
            .to_string();
        let answer = messages.iter().find_map(|message| {
            let info = message.get("info")?;
            if info.get("id")?.as_str()? != receipt
                || info.get("parentID")?.as_str()? != user_id
                || info.get("sessionID")?.as_str()? != session_id
            {
                return None;
            }
            Some(
                message
                    .get("parts")?
                    .as_array()?
                    .iter()
                    .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
        })?;
        (!answer.is_empty() && answer.len() <= MAX_BODY).then_some(answer)
    }
}
