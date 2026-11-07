# Channels Rubric

Channels cases pass when the in-memory Relay executor preserves channel lifecycle state across create, join, leave, invite, topic, archive, and listing operations.

Passing behavior must show deterministic membership snapshots, stable topic values, archived-channel visibility only when requested, and typed errors for duplicate channel names, unknown invite targets, and archived-channel membership attempts.
