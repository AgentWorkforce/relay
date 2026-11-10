# Worker enrollment input: main-forward

Root delegated the existing feature branch to preserve safe enrollment file/stdin input while incorporating current main. The only source conflict was in the Added changelog entries; both entries and the existing Unreleased-Major level are retained. The five feature source/test/doc files remain byte-identical to reviewed f667f6300. No local-agent feature is imported from its separate pending branch.

The public package publication remains separate from source integration. No package publishing, real enrollment or runtime action is authorized here. Validation uses injected fetch/process boundaries and an owned temporary credential store.

Trail is unavailable on this machine; this tracked note records the delegated decision directly. The final merge commit records the exact two-pass review and validation results.

## Release-lock repair integration

Forward-merged accepted main f86ebb61. The enrollment feature source and tests remain byte-identical to the prior reviewed head; package manifests and lockfile are exactly main. Adversarial review confirmed descriptor-bound regular-file checks, bounded fatal UTF-8 reads and credential-safe refusals; contextual review confirmed unchanged enrollment/storage and placed the pending feature under Unreleased. Validation: clean npm ci with lifecycle scripts disabled, 39 focused tests and full npm run typecheck passed; diff whitespace check passed. Hosted checks and required approval remain separate.
