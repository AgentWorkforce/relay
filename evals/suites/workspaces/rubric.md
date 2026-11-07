# Workspaces Rubric

Workspaces cases pass when workspace creation returns a usable Relay-style key, setting a workspace key selects the intended workspace, and workspace state remains isolated across key switches and duplicate display names.

Failures must be deterministic for invalid key formats, and failed workspace-key selection must not mutate the active workspace context.
