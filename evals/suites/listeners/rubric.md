# Listeners Rubric

Listener cases are deterministic. A passing run must show that public listener
selectors and predicate subscriptions fire only for matching message, read,
reaction, action, status, and tool events; public event mapping preserves
message envelope details; wildcard selector matching is exact; and unsupported
raw event types are ignored rather than surfaced.
