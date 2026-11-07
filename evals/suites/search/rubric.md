# Search Rubric

Search cases pass when list_messages and search_messages expose the expected
conversation state with correct scoping, limits, and immediate visibility of
new messages. Failures mean callers cannot rely on relay search/list surfaces
for deterministic message discovery.
