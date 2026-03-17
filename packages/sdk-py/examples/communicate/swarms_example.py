from agent_relay import Relay, on_relay
from swarms import Agent

relay = Relay("SwarmsWorker")
agent = Agent(agent_name="SwarmsWorker", system_prompt="Use relay tools when needed.", model_name="gpt-4o-mini", max_loops=1)
agent = on_relay(agent, relay)
print(agent.run("Check relay_inbox, then say hello to the team."))
