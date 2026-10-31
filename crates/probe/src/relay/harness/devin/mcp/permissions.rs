//! ACP v1 permission requests contain only a tool-call id. Correlate the
//! trusted CLI's earlier update, never a title, command substring, or an
//! MCP server's own metadata. The launch injects this exact helper binding.

use super::valid_arguments;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

const LIMIT: usize = 1024;

pub(crate) struct Gate {
    session: String,
    tool: String,
    calls: BTreeMap<String, Value>,
    consumed: BTreeSet<String>,
}
impl Gate {
    pub(crate) fn new(session: &str, alias: &str) -> Self {
        Self {
            session: session.into(),
            tool: format!("mcp__{alias}__{}", super::TOOL),
            calls: BTreeMap::new(),
            consumed: BTreeSet::new(),
        }
    }
    pub(crate) fn clear(&mut self) {
        self.calls.clear();
    }
    pub(crate) fn observe(&mut self, frame: &Value) {
        if frame["method"] != "session/update" || frame["params"]["sessionId"] != self.session {
            return;
        }
        let update = &frame["params"]["update"];
        if !matches!(
            update["sessionUpdate"].as_str(),
            Some("tool_call" | "tool_call_update")
        ) {
            return;
        }
        let Some(id) = update["toolCallId"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 256)
        else {
            return;
        };
        if self.calls.len() >= LIMIT && !self.calls.contains_key(id) {
            return;
        }
        let call = self.calls.entry(id.into()).or_insert_with(|| json!({}));
        for key in ["_meta", "rawInput", "kind"] {
            if let Some(value) = update.get(key) {
                call[key] = if value.to_string().len() <= 70_000 {
                    value.clone()
                } else {
                    json!({"invalid":"oversized"})
                };
            }
        }
    }
    pub(crate) fn outcome(&mut self, frame: &Value) -> Value {
        self.approve(frame).map_or_else(
            || json!({"outcome":"cancelled"}),
            |id| json!({"outcome":"selected","optionId":id}),
        )
    }
    fn approve(&mut self, frame: &Value) -> Option<String> {
        let params = &frame["params"];
        if frame["method"] != "session/request_permission" || params["sessionId"] != self.session {
            return None;
        }
        let id = params["toolCall"]["toolCallId"].as_str()?;
        if params["toolCall"]
            .as_object()?
            .keys()
            .any(|key| key != "toolCallId")
        {
            return None;
        }
        if self.consumed.contains(id) || self.consumed.len() >= 4096 {
            return None;
        }
        let call = self.calls.get(id)?;
        let meta = &call["_meta"];
        // Devin constructs these identities itself. A controlled real-CLI
        // test confirmed injected server definitions cannot spoof this meta.
        if meta["cognition.ai/toolName"] != self.tool
            || meta["cognition.ai/inferenceToolName"] != self.tool
            || meta["cognition.ai/eventType"] != "mcp_tool_call"
            || call
                .get("kind")
                .is_some_and(|kind| !kind.is_null() && kind != "other")
            || !valid_arguments(&call["rawInput"])
        {
            return None;
        }
        let options = params["options"].as_array()?;
        let mut once = options
            .iter()
            .filter(|option| option["kind"] == "allow_once");
        let option = once.next()?["optionId"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 256)?;
        if once.next().is_some()
            || options
                .iter()
                .filter(|item| item["optionId"] == option)
                .count()
                != 1
        {
            return None;
        }
        self.consumed.insert(id.into());
        Some(option.into())
    }
}

#[cfg(test)]
mod tests;
