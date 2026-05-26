import { AgentRelay, defaultHarnesses } from '@agent-relay/sdk';
import { myApi } from '../my-internal-api'


const { codex, claude } = defaultHarnesses;

const piCoding = {
  runtime: 'pty',
  command: 'pid',
     args: [
       '--dangerously-skip-permissions',
       '--append-system-prompt',
       'Follow the company review rubric.',
       '{modelArgs}',
       '{args}',
     ],
     modelArgs: ['--model', '{model}'],
     env: {
       FUN_SETTING: '1',
     },
  beforeSpawn: async (ctx) => {
    const hasCreditsAvailable = await myApi.hasCreditsAvailable()

    if (!hasCreditsAvailable) {
      return { error: 'No credits available', status: 402 }
    }

    const sessionId = await createPiResumableSessionId(ctx.cwd, ctx.task, ctx.env)
    return { sessionId }
  }

}



const relay = new AgentRelay(
  harnesses: [ piCoding, codex, claude ]
);
