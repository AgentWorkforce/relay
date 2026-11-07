# Agent Directory Rubric

Agent directory cases pass when registration, worker spawning, removal, listing filters, DM directory state, channel listings, and presence transitions are deterministic.

Passing behavior must preserve agent type and metadata, expose online and offline status accurately, scope DM listings to the acting agent, and return typed errors for duplicate registration, unknown removal targets, and attempts to act as an offline agent.
