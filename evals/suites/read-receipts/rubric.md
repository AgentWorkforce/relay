# Read Receipts Rubric

Read receipt cases pass when unread inbox state changes only through delivery
and explicit mark_read operations, and get_readers returns deduplicated readers
for the target message. Failures point to broken read/unread transitions or
receipt attribution.
