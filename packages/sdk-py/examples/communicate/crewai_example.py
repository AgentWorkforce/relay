from agent_relay import Relay, on_relay
from crewai import Agent

relay = Relay("CrewWorker")
agent = Agent(role="Relay worker", goal="Coordinate with teammates", backstory="You check relay messages before acting.", llm="gpt-4o-mini")
agent = on_relay(agent, relay)
print(agent.backstory)
