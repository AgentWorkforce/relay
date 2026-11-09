# Worker enrollment input: main-forward

Root delegated the existing feature branch to preserve safe enrollment file/stdin input while incorporating current main. The only source conflict was in the Added changelog entries; both entries and the existing Unreleased-Major level are retained. The five feature source/test/doc files remain byte-identical to reviewed f667f6300. No local-agent feature is imported from its separate pending branch.

The public package publication remains separate from source integration. No package publishing, real enrollment or runtime action is authorized here. Validation uses injected fetch/process boundaries and an owned temporary credential store.

Trail is unavailable on this machine; this tracked note records the delegated decision directly. The final merge commit records the exact two-pass review and validation results.
