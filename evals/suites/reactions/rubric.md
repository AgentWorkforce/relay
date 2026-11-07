# Reactions Rubric

Reaction cases pass when emoji state is tracked per message and per reacting
agent. Add and remove operations must be idempotent for the same actor, while
distinct actors still contribute distinct counts.
