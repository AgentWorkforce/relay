// `grok agent …` for a copy of Node named `grok`: Node runs this file, copied to
// `agent` in the session's folder, for the commands the core and a Grok TUI use.
//
//   grok agent leader                   listens on the home's leader.sock
//   grok agent … --leader-socket S stdio   answers ACP on stdin and stdout
//
// There is no model. A prompt is recorded in `prompts.jsonl` beside this file and
// acknowledged the way Grok's leader queues it.

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const args = process.argv.slice(2);

if (args[0] === 'leader') {
  const socket = path.join(os.homedir(), '.grok/leader.sock');
  fs.rmSync(socket, { force: true });
  net.createServer((connection) => connection.on('error', () => undefined)).listen(socket);
} else if (args.includes('stdio')) {
  const reply = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const { id, method, params } = JSON.parse(line);
    if (method === 'initialize') {
      reply({
        id,
        result: {
          protocolVersion: 1,
          _meta: { agentVersion: 'fake', modelState: { currentModelId: 'fake-model' } },
        },
      });
    } else if (method === 'session/load') {
      reply({ id, result: { sessionId: params.sessionId } });
    } else if (method === 'session/prompt') {
      const text = params.prompt.map((part) => part.text).join('');
      fs.appendFileSync(path.join(__dirname, 'prompts.jsonl'), `${JSON.stringify({ ...params, text })}\n`);
      reply({
        method: '_x.ai/queue/changed',
        params: { sessionId: params.sessionId, runningPromptId: 'fake-prompt', runningText: text },
      });
      reply({
        method: 'session/update',
        params: {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } },
        },
      });
    }
  });
}
