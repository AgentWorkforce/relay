import { claudePreflight, ensureClaudeDirectDelivery, injectClaude } from './claude.js';
import { createCodexRouter } from './codex.js';

/** Routes Connect text into the joined Claude Code or Codex session. */
export function createInjector({ home, env, platform = process.platform, run }) {
  const codex = createCodexRouter({ home, env, platform, run });
  return {
    async prepare(target) {
      if (target.kind === 'claude') await ensureClaudeDirectDelivery({ home, env, platform });
    },
    async inject(target, { messageId, text }) {
      if (target.kind === 'claude')
        return await injectClaude({ home, env, sessionId: target.id, messageId, text });
      return await codex.inject({ threadId: target.id, messageId, text });
    },
    async observe(target, { messageId, text }) {
      // Only a provider queue (Codex) ever accepts without delivering.
      if (target.kind === 'claude')
        return { outcome: 'in_doubt', detail: 'Claude Code reported no acceptance to observe.' };
      return await codex.observe({ threadId: target.id, messageId, text });
    },
    async preflight(target) {
      if (target.kind === 'claude') return await claudePreflight({ home, env, sessionId: target.id });
      return await codex.preflight({ threadId: target.id });
    },
  };
}
