# Messaging Rubric

Messaging cases pass when channel posts, direct messages, and group DMs are
created through the canonical relay ops and become visible only through the
appropriate read surfaces. The important signal is durable message state:
author, text, target conversation, attachments, and idempotent retry behavior.
