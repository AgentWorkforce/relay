# Auth Errors Rubric

Auth error cases are deterministic. A passing run must show that invalid
Relaycast agent tokens are detected by typed code, legacy status/message pairs,
nested body errors, cause chains, and MCP-style tool-result content, while
ordinary unauthorized errors and unrelated tool results do not trigger token
recovery. The recovery message must include the stable code and explicit
`register_agent` guidance.
