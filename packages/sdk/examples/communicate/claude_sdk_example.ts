import { Relay, onRelay } from '@agent-relay/sdk/communicate';

const relay = new Relay('ClaudeWorker');
const options = onRelay('ClaudeWorker', {}, relay);
console.log(options.mcpServers?.relaycast);
