export function assertRelayExpected(testCase, actualInput) {
  const expected = testCase.expected ?? {};
  const actual = normalizeRelayActual(actualInput);
  const checks = [];

  for (const item of asArray(expected.messageExists)) {
    const check = objectCheck(item, 'messageExists');
    addCheck(
      checks,
      `messageExists:${check.text ?? '*'}`,
      actual.messages.some((message) => messageMatches(message, check)),
      `expected a message matching ${JSON.stringify(check)}`
    );
  }

  for (const item of asArray(expected.threadReplyCount)) {
    const { parent, count } = objectCheck(item, 'threadReplyCount');
    const replies = actual.messages.filter((message) => message.parentId === parent);
    addCheck(
      checks,
      `threadReplyCount:${parent}`,
      replies.length === Number(count),
      `expected ${count} replies for ${parent}, got ${replies.length}`
    );
  }

  for (const item of asArray(expected.reactionCount)) {
    const { messageId, emoji, count } = objectCheck(item, 'reactionCount');
    const message = actual.messages.find(
      (candidate) => candidate.id === messageId || candidate.messageId === messageId
    );
    const reaction = message?.reactions?.find((candidate) => candidate.emoji === emoji);
    const observed = Number(reaction?.count ?? 0);
    addCheck(
      checks,
      `reactionCount:${messageId}:${emoji}`,
      observed === Number(count),
      `expected ${count} ${emoji} reactions on ${messageId}, got ${observed}`
    );
  }

  for (const item of asArray(expected.channelMembers)) {
    const { channel, members } = objectCheck(item, 'channelMembers');
    const observed = (
      actual.channels.find((candidate) => candidate.name === normalizeChannelName(channel))?.members ?? []
    ).map((member) => (typeof member === 'string' ? member : (member.agentName ?? member.name)));
    const missing = asArray(members).filter((member) => !observed.includes(String(member)));
    addCheck(
      checks,
      `channelMembers:${channel}`,
      missing.length === 0,
      `expected ${channel} to include members ${missing.join(', ') || '(none missing)'}`
    );
  }

  for (const item of asArray(expected.agentPresence)) {
    const { name, status } = objectCheck(item, 'agentPresence');
    const agent = actual.agents.find((candidate) => candidate.name === name);
    addCheck(
      checks,
      `agentPresence:${name}`,
      Boolean(agent) && (!status || agent.status === status),
      `expected agent ${name} presence${status ? ` status ${status}` : ''}`
    );
  }

  for (const code of asArray(expected.errorCode)) {
    const allowed = asArray(code).map(String);
    addCheck(
      checks,
      `errorCode:${allowed.join('|')}`,
      Boolean(actual.error?.code) && allowed.includes(String(actual.error.code)),
      `expected error code ${allowed.join(' or ')}, got ${actual.error?.code ?? 'none'}`
    );
  }

  for (const item of asArray(expected.eventEmitted)) {
    const passed =
      typeof item === 'string'
        ? actual.events.some((event) => event.type === item)
        : actual.events.some((event) => eventMatches(event, objectCheck(item, 'eventEmitted')));
    addCheck(
      checks,
      `eventEmitted:${typeof item === 'string' ? item : (item.type ?? '*')}`,
      passed,
      `expected event ${JSON.stringify(item)} to be emitted`
    );
  }

  return checks;
}

function normalizeRelayActual(actualInput) {
  const actual = actualInput && typeof actualInput === 'object' ? actualInput : {};
  const observed = actual.observed && typeof actual.observed === 'object' ? actual.observed : {};
  return {
    ...actual,
    messages: Array.isArray(actual.messages) ? actual.messages : [],
    channels: Array.isArray(actual.channels) ? actual.channels : [],
    agents: Array.isArray(actual.agents) ? actual.agents : [],
    events: Array.isArray(observed.events)
      ? observed.events
      : Array.isArray(actual.events)
        ? actual.events
        : [],
    error: observed.error ?? actual.error,
  };
}

function addCheck(checks, name, passed, message) {
  checks.push({ name, passed: Boolean(passed), message });
}

function asArray(value) {
  if (value === undefined || value === null || value === false) return [];
  return Array.isArray(value) ? value : [value];
}

function objectCheck(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} check must be an object`);
  }
  return value;
}

function messageMatches(message, check) {
  if (check.channel !== undefined && message.channel?.name !== normalizeChannelName(check.channel))
    return false;
  if (check.kind !== undefined && message.kind !== check.kind) return false;
  if (check.text !== undefined && !String(message.text ?? '').includes(String(check.text))) return false;
  if (check.from !== undefined && message.from?.name !== check.from) return false;
  return true;
}

function eventMatches(event, check) {
  return Object.entries(check).every(([key, value]) => deepRead(event, key) === value);
}

function deepRead(value, key) {
  return String(key)
    .split('.')
    .reduce((current, part) => current?.[part], value);
}

function normalizeChannelName(name) {
  return String(name ?? '').replace(/^#/, '');
}
