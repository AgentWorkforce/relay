# @agent-relay/integration-prompts

Shared prompt builders for Relayfile integration writeback instructions.

```ts
import {
  deriveDescriptorsFromMount,
  prescriptiveInstructions,
} from '@agent-relay/integration-prompts';

const descriptors = await deriveDescriptorsFromMount({
  readFile: async (path) => mount.readText(path),
  listTree: async (path) => mount.listTree(path),
});

const instructions = prescriptiveInstructions(descriptors);
```
