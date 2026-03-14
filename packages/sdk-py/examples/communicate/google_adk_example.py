from agent_relay import Relay, on_relay
from google.adk.agents import Agent

relay = Relay("GoogleWorker")
agent = Agent(name="GoogleWorker", model="gemini-2.0-flash", instruction="Use relay tools when needed.")
agent = on_relay(agent, relay)
print([tool.__name__ for tool in agent.tools])
