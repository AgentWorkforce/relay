import { createAgentSession } from '@mariozechner/pi-coding-agent';
import { Relay, onRelay } from '@agent-relay/sdk/communicate';

const relay = new Relay('PiWorker');
const config = onRelay('PiWorker', {}, relay);
const { session } = await createAgentSession({ customTools: config.customTools });
await config.onSessionCreated(session);
await session.prompt('Check relay_inbox before you act.');
