from agent_relay import Relay, on_relay
from claude_agent_sdk import ClaudeAgentOptions

relay = Relay("ClaudeWorker")
options = on_relay(ClaudeAgentOptions(), relay)
print(options.mcp_servers)
