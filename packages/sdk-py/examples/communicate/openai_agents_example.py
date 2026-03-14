from agent_relay import Relay
from agent_relay.communicate.adapters.openai_agents import on_relay
from openai_agents import Agent

relay = Relay("OpenAIWorker")
agent = Agent(name="OpenAIWorker", instructions="Check relay_inbox before acting.")
agent = on_relay(agent, relay)
print(len(agent.tools))
