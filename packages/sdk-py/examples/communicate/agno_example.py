from agent_relay import Relay, on_relay
from agno.agent import Agent
from agno.models.openai import OpenAIChat

relay = Relay("AgnoWorker")
agent = Agent(model=OpenAIChat(id="gpt-5-mini"), instructions="Use relay tools when needed.")
agent = on_relay(agent, relay)
print(len(agent.tools))
