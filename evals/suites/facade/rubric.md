# Facade Rubric

Facade cases are deterministic. A passing run must show that workspace
registration returns usable live agent clients, batch registration is complete
and duplicate-safe, reconnect preserves token-bound identity, workspace info is
read from the facade, and notify routes channel and agent targets with the
expected delivery mode mapping.
