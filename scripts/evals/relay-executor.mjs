import {
  AgentRelay,
  DeliveryRunner,
  InMemoryAgentRelayActions,
  MINIMAL_AGENT_SESSION_CAPABILITIES,
  actionSchemaToJsonSchema,
  agentTokenRecoveryMessage,
  createListenerHub,
  createWorkspaceFacade,
  defineHarness,
  formatAgentHandle,
  isInvalidAgentTokenError,
  isInvalidAgentTokenToolResult,
  matchesSelector,
  nextHarnessName,
  normalizeAgentIdentity,
  toPublicMessagingEvent,
  validateJsonSchemaLite,
} from "@agent-relay/sdk";

const FIXED_TIME = "2026-06-09T00:00:00.000Z";

export function createRelayExecutor() {
  return async function relayExecute(testCase) {
    const state = createRelayState(testCase.mock ?? {});

    try {
      for (const operation of normalizeOperations(testCase.input?.operation ?? testCase.input?.operations)) {
        try {
          await executeOperation(state, operation);
        } catch (error) {
          state.observed.error = normalizeError(error);
          state.contentLines.push(`error ${operation.op ?? operation.type}: ${state.observed.error.code} ${state.observed.error.message}`);
          break;
        }
      }

      return buildActual(state);
    } finally {
      state.stopDelivery?.();
    }
  };
}

function createRelayState(mock) {
  const state = {
    mock,
    agents: new Map(),
    channels: new Map(),
    messages: new Map(),
    dmConversations: new Map(),
    workspace: { id: mock.workspace?.id ?? "ws_eval", name: mock.workspace?.name ?? "relay-eval" },
    workspaces: new Map(),
    activeWorkspace: undefined,
    contentLines: [],
    observed: { content: "", events: [], toolCalls: [], error: undefined },
    actions: new InMemoryAgentRelayActions(),
    eventBus: createEventBus(),
    counters: { agent: 0, channel: 0, message: 0, dm: 0, inbox: 0, invocation: 0 },
    inboxItems: [],
    actionInvocations: new Map(),
    stopDelivery: undefined,
  };
  const defaultWorkspace = createWorkspaceRecord(state, {
    id: state.workspace.id,
    name: state.workspace.name,
    key: state.workspace.key ?? "rk_live_default",
    agents: state.agents,
    channels: state.channels,
    messages: state.messages,
    dmConversations: state.dmConversations,
    inboxItems: state.inboxItems,
  });
  state.activeWorkspace = defaultWorkspace;
  state.workspace = publicWorkspace(defaultWorkspace);
  state.workspaces.set(defaultWorkspace.key, defaultWorkspace);

  state.actions.onEvent((event) => emit(state, event.type, event));

  for (const agent of mock.agents ?? []) {
    upsertAgent(state, agent.name, {
      type: agent.type ?? "agent",
      status: agent.status ?? "online",
      persona: agent.persona,
      metadata: agent.metadata,
      token: agent.token,
    });
  }
  for (const channel of mock.channels ?? []) {
    upsertChannel(state, channel.name, {
      topic: channel.topic,
      metadata: channel.metadata,
      archived: channel.archived,
      members: channel.members ?? [],
    });
  }
  for (const message of mock.messages ?? []) {
    seedMessage(state, message);
  }
  if (!state.agents.has("system")) upsertAgent(state, "system", { type: "system", status: "online" });
  for (const workspace of mock.workspaces ?? []) {
    seedWorkspace(state, workspace);
  }
  switchWorkspace(state, defaultWorkspace);

  state.messaging = createMessagingClient(state);
  state.relay = new AgentRelay({
    messaging: state.messaging,
    actions: state.actions,
    createAgentMessaging: (token) => createMessagingClient(state, agentNameFromToken(state, token)),
  });
  state.listenerHub = createListenerHub(state.messaging.events, state.actions);
  state.workspaceFacade = createWorkspaceFacade(state.messaging, {
    buildAgentClient: (registration) => state.relay.agent({
      id: registration.id,
      name: registration.name,
      handle: `@${registration.name}`,
      token: registration.token,
    }),
    reconnectAgent: async (apiToken) => {
      const name = agentNameFromToken(state, apiToken);
      const agent = state.agents.get(name);
      if (!agent) throw Object.assign(new Error("Invalid agent token"), { code: "AGENT_TOKEN_INVALID" });
      return state.relay.agent({ id: agent.id, name: agent.name, handle: `@${agent.name}`, token: apiToken });
    },
  });
  return state;
}

async function executeOperation(state, operation) {
  const op = operation.op ?? operation.type;
  if (!op) throw codedError("missing_op", `operation is missing op/type: ${JSON.stringify(operation)}`);
  state.observed.toolCalls.push({ name: op, op, as: operation.as });

  switch (op) {
    case "post_message":
      requireAgentClientCapability(state, "messages.send", operation.as);
      return record(state, op, await messagingFor(state, operation.as).messages.send({
        channel: required(operation.channel, "channel"),
        text: operation.text ?? "",
        attachments: operation.attachments,
        mode: operation.mode,
        idempotencyKey: operation.idempotencyKey,
        __id: operation.id,
      }));
    case "send_dm":
      return record(state, op, await messagingFor(state, operation.as).messages.direct({
        to: required(operation.to, "to"),
        text: operation.text ?? "",
        attachments: operation.attachments,
        mode: operation.mode,
        idempotencyKey: operation.idempotencyKey,
        __id: operation.id,
      }));
    case "send_group_dm":
      return record(state, op, await messagingFor(state, operation.as).messages.groupDirect({
        participants: operation.participants ?? [],
        name: operation.name,
        text: operation.text ?? "",
        attachments: operation.attachments,
        mode: operation.mode,
        idempotencyKey: operation.idempotencyKey,
        __id: operation.id,
      }));
    case "reply_to_thread":
      return record(state, op, await messagingFor(state, operation.as).threads.reply({
        messageId: required(operation.parent ?? operation.messageId, "parent"),
        text: operation.text ?? "",
        idempotencyKey: operation.idempotencyKey,
        __id: operation.id,
      }));
    case "get_thread":
      return record(state, op, await state.messaging.threads.get(required(operation.messageId ?? operation.parent, "messageId")));
    case "add_reaction":
      return record(state, op, await messagingFor(state, operation.as).messages.react(required(operation.messageId, "messageId"), required(operation.emoji, "emoji")));
    case "remove_reaction":
      return record(state, op, await messagingFor(state, operation.as).messages.unreact(required(operation.messageId, "messageId"), required(operation.emoji, "emoji")));
    case "mark_read":
      if (state.mock.deliveryCapabilities?.durableAck === false) {
        return record(state, op, { supported: false, action: "markRead", messageId: required(operation.messageId, "messageId"), reason: "durableAck unsupported" });
      }
      return record(state, op, await messagingFor(state, operation.as).messages.markRead(required(operation.messageId, "messageId")));
    case "get_readers":
      return record(state, op, await state.messaging.messages.readers(required(operation.messageId, "messageId")));
    case "check_inbox":
      return record(state, op, await messagingFor(state, operation.as).inbox.get({ limit: operation.limit }));
    case "list_messages":
      return record(state, op, await state.messaging.messages.list(required(operation.channel, "channel"), { limit: operation.limit }));
    case "search_messages":
      return record(state, op, await state.messaging.messages.search(required(operation.query, "query"), { channel: operation.channel, limit: operation.limit }));
    case "create_channel":
      return record(state, op, await state.messaging.channels.create({ name: required(operation.name ?? operation.channel, "name"), topic: operation.topic, metadata: operation.metadata, __id: operation.id }));
    case "join_channel":
      requireAgentClientCapability(state, "channels.join", operation.as);
      return record(state, op, await messagingFor(state, operation.as).channels.join(required(operation.channel ?? operation.name, "channel")));
    case "leave_channel":
      return record(state, op, await messagingFor(state, operation.as).channels.leave(required(operation.channel ?? operation.name, "channel")));
    case "invite_to_channel":
      return record(state, op, await state.messaging.channels.invite(required(operation.channel, "channel"), required(operation.agent, "agent")));
    case "archive_channel":
      return record(state, op, await state.messaging.channels.archive(required(operation.channel ?? operation.name, "channel")));
    case "set_topic":
      return record(state, op, await state.messaging.channels.update(required(operation.channel ?? operation.name, "channel"), { topic: operation.topic ?? "" }));
    case "list_channels":
      return record(state, op, await state.messaging.channels.list({ includeArchived: operation.includeArchived ?? operation.include_archived }));
    case "list_dms":
      return record(state, op, listDms(state, operation.as));
    case "create_workspace":
      {
        const workspace = createWorkspaceRecord(state, {
          id: operation.id ?? `ws_${state.workspaces.size + 1}`,
          name: operation.name ?? "relay-eval-created",
          key: operation.workspaceKey ?? operation.key ?? nextWorkspaceKey(operation.id ?? operation.name ?? state.workspaces.size + 1),
        });
        state.workspaces.set(workspace.key, workspace);
        switchWorkspace(state, workspace);
        if (!state.agents.has("system")) upsertAgent(state, "system", { type: "system", status: "online" });
        return record(state, op, publicWorkspace(workspace));
      }
    case "set_workspace_key":
      {
        const workspaceKey = operation.workspaceKey ?? operation.apiKey ?? operation.key;
        if (!String(workspaceKey ?? "").startsWith("rk_live_")) {
          throw codedError("invalid_workspace_key", `workspace key must start with rk_live_: ${workspaceKey ?? ""}`);
        }
        const workspace = state.workspaces.get(workspaceKey);
        if (!workspace) throw codedError("workspace_not_found", `workspace not found: ${workspaceKey}`);
        switchWorkspace(state, workspace);
        return record(state, op, { ok: true, workspaceKey: workspace.key, workspace: publicWorkspace(workspace) });
      }
    case "register_agent":
      return record(state, op, await state.messaging.agents.register(operation.agent ?? operation));
    case "register_agents":
      return record(state, op, await state.workspaceFacade.register(operation.agents ?? []));
    case "add_agent": {
      const name = required(operation.name ?? operation.agent, "name");
      const agent = upsertAgent(state, name, { type: "agent", status: "online", persona: operation.persona, metadata: operation.metadata });
      emit(state, "agentSpawnRequested", { type: "agentSpawnRequested", agent: { name, cli: operation.cli, task: operation.task, channel: operation.channel, alreadyExisted: false } });
      return record(state, op, publicAgent(agent));
    }
    case "remove_agent": {
      const name = required(operation.name ?? operation.agent, "name");
      const agent = requireAgent(state, name);
      if (operation.deleteAgent || operation.delete_agent) state.agents.delete(name);
      else agent.status = "offline";
      emit(state, "agentReleaseRequested", { type: "agentReleaseRequested", agent: { name }, reason: operation.reason, deleted: Boolean(operation.deleteAgent ?? operation.delete_agent) });
      return record(state, op, { name, removed: true });
    }
    case "list_agents":
      return record(state, op, await state.messaging.agents.list({ status: operation.status ?? "all" }));
    case "deliver":
      return record(state, op, await deliver(state, operation));
    case "register_action":
      return record(state, op, registerAction(state, operation));
    case "invoke_action":
      if (operation.mode === "execute") {
        return record(state, op, await state.actions.execute(
          required(operation.name ?? operation.action, "name"),
          operation.input,
          { caller: { name: operation.as ?? operation.caller ?? "sdk", type: "agent" } },
        ));
      }
      return record(state, op, await state.actions.invoke({
        name: required(operation.name ?? operation.action, "name"),
        input: operation.input,
        caller: { name: operation.as ?? operation.caller ?? "sdk", type: "agent" },
        context: { emit: (event) => emit(state, event.type, event) },
      }));
    case "define_harness":
      return record(state, op, await defineHarnessOperation(state, operation));
    case "next_harness_name":
      return record(state, op, nextHarnessName(required(operation.base, "base"), operation.explicit));
    case "normalize_identity":
      return record(state, op, normalizeAgentIdentity(operation.input ?? operation));
    case "format_handle":
      return record(state, op, formatAgentHandle(required(operation.name, "name")));
    case "read_capabilities":
      return record(state, op, MINIMAL_AGENT_SESSION_CAPABILITIES);
    case "resume_session":
      {
        const resumed = {
          resumed: true,
          sessionId: operation.sessionId ?? operation.id ?? "session_eval",
          agent: operation.agent ?? operation.agentId,
          reason: operation.reason,
          input: operation.input ?? null,
        };
        emit(state, "session.resumed", { type: "session.resumed", ...resumed });
        return record(state, op, resumed);
      }
    case "add_listener":
      requireAgentClientCapability(state, "events.subscribe", operation.as);
      return record(state, op, addListenerOperation(state, operation));
    case "on_predicate":
      return record(state, op, addPredicateListener(state, operation));
    case "emit_event":
      emitRawMessagingEvent(state, operation.raw ?? operation.event ?? operation);
      return record(state, op, { emitted: true });
    case "emit_session_event":
      state.listenerHub.emitSessionEvent(required(operation.agentId, "agentId"), required(operation.event, "event"));
      emit(state, operation.event.type, { agentId: operation.agentId, event: operation.event, type: operation.event.type });
      return record(state, op, { emitted: true });
    case "match_selector":
      return record(state, op, matchesSelector(required(operation.selector, "selector"), required(operation.type, "type")));
    case "to_public_event":
      return record(state, op, toPublicMessagingEvent(required(operation.raw, "raw")));
    case "reconnect":
      return record(state, op, await state.workspaceFacade.reconnect({ apiToken: required(operation.apiToken ?? operation.token, "apiToken") }));
    case "notify":
      return record(state, op, await notify(state, operation));
    case "workspace_info":
      return record(state, op, await state.workspaceFacade.info());
    case "is_invalid_token_error":
      return record(state, op, isInvalidAgentTokenError(makeErrorFixture(operation.error ?? operation)));
    case "is_invalid_token_tool_result":
      return record(state, op, isInvalidAgentTokenToolResult(operation.result ?? operation));
    case "token_recovery_message":
      return record(state, op, agentTokenRecoveryMessage());
    case "validate_schema":
      return record(state, op, validateJsonSchemaLite(operation.value, required(operation.schema, "schema")));
    case "action_schema_to_json_schema":
      return record(state, op, actionSchemaToJsonSchema(operation.schema));
    default:
      throw codedError("unknown_op", `unknown relay eval operation "${op}"`);
  }
}

function createMessagingClient(state, actorName = "system") {
  const actor = () => {
    const agent = requireAgent(state, actorName);
    if (agent.status === "offline") throw codedError("agent_offline", `agent is offline: ${actorName}`);
    return agent;
  };
  return {
    capabilities: {
      serverDeliveryState: state.mock.delivery?.serverDeliveryState !== false && state.mock.serverDeliveryState !== false,
      durableDelivery: false,
      durableAck: state.mock.deliveryCapabilities?.durableAck !== false,
      durableFail: false,
      durableDefer: false,
    },
    agents: {
      list: async (options = {}) => [...state.agents.values()].filter((agent) => options.status === "all" || !options.status || agent.status === options.status).map(publicAgent),
      get: async (name) => publicAgent(requireAgent(state, name)),
      register: async (input) => {
        const cleanName = normalizeAgentName(required(input.name, "name"));
        if (state.agents.has(cleanName)) throw codedError("agent_exists", `agent already exists: ${cleanName}`);
        const agent = upsertAgent(state, required(input.name, "name"), input);
        agent.status = input.status ?? "online";
        emit(state, "agentOnline", { type: "agentOnline", agent: { name: agent.name } });
        return { id: agent.id, name: agent.name, token: agent.token, status: agent.status, createdAt: agent.createdAt };
      },
      me: async () => publicAgent(actor()),
      update: async (name, input) => publicAgent(upsertAgent(state, name, input)),
      delete: async (name) => { state.agents.delete(name); },
      presence: async () => [...state.agents.values()].map((agent) => ({ agentId: agent.id, agentName: agent.name, status: agent.status === "offline" ? "offline" : "online" })),
    },
    channels: {
      list: async (options = {}) => [...state.channels.values()].filter((channel) => options.includeArchived || !channel.archived).map(publicChannel),
      get: async (name) => publicChannel(requireChannel(state, name)),
      create: async (input) => {
        const cleanName = normalizeChannelName(required(input.name, "name"));
        if (state.channels.has(cleanName)) throw codedError("channel_exists", `channel already exists: ${cleanName}`);
        const channel = upsertChannel(state, input.name, { id: input.__id, topic: input.topic, metadata: input.metadata });
        emit(state, "channelCreated", { type: "channelCreated", channel: { name: channel.name, topic: channel.topic } });
        return publicChannel(channel);
      },
      update: async (name, input) => {
        const channel = requireChannel(state, name);
        if ("topic" in input) channel.topic = input.topic ?? undefined;
        if (input.metadata) channel.metadata = input.metadata;
        emit(state, "channelUpdated", { type: "channelUpdated", channel: { name: channel.name, topic: channel.topic } });
        return publicChannel(channel);
      },
      archive: async (name) => {
        const channel = requireChannel(state, name);
        channel.archived = true;
        emit(state, "channelArchived", { type: "channelArchived", channel: { name: channel.name } });
      },
      join: async (name) => {
        const channel = requireChannel(state, name);
        if (channel.archived) throw codedError("channel_archived", `channel is archived: ${channel.name}`);
        channel.members.add(actor().name);
        emit(state, "memberJoined", { type: "memberJoined", channel: channel.name, agentName: actor().name });
      },
      leave: async (name) => {
        const channel = requireChannel(state, name);
        if (channel.archived) throw codedError("channel_archived", `channel is archived: ${channel.name}`);
        channel.members.delete(actor().name);
        emit(state, "memberLeft", { type: "memberLeft", channel: channel.name, agentName: actor().name });
      },
      invite: async (channelName, agentName) => {
        const channel = requireChannel(state, channelName);
        if (channel.archived) throw codedError("channel_archived", `channel is archived: ${channel.name}`);
        requireAgent(state, agentName);
        channel.members.add(agentName);
        emit(state, "memberJoined", { type: "memberJoined", channel: channel.name, agentName });
      },
      members: async (name) => [...requireChannel(state, name).members].map((member) => ({ agentId: requireAgent(state, member).id, agentName: member, role: "member", muted: false })),
      mute: async (name) => emit(state, "channelMuted", { type: "channelMuted", channel: normalizeChannelName(name), agentName: actor().name }),
      unmute: async (name) => emit(state, "channelUnmuted", { type: "channelUnmuted", channel: normalizeChannelName(name), agentName: actor().name }),
    },
    messages: createMessagesSurface(state, actorName),
    threads: {
      get: async (messageId) => {
        const parent = requireMessage(state, messageId);
        return { parent, replies: [...state.messages.values()].filter((message) => message.parentId === parent.id) };
      },
      reply: async (input) => createReply(state, actorName, input),
    },
    inbox: createInboxSurface(state, actorName),
    events: state.eventBus,
    deliveries: {
      ack: async (messageId) => ({ supported: false, action: "ack", messageId }),
      fail: async (messageId, reason) => ({ supported: false, action: "fail", messageId, reason }),
      defer: async (messageId, deferUntil) => ({ supported: false, action: "defer", messageId, deferUntil }),
    },
    integrations: emptyIntegrations(),
    webhooks: emptyWebhooks(),
    commands: createCommandsSurface(state),
    workspace: { info: async () => state.workspace },
  };
}

function createMessagesSurface(state, actorName) {
  return {
    send: async (input) => {
      const channel = upsertChannel(state, input.channel, { members: [actorName] });
      const message = createMessage(state, { id: input.__id, kind: "channel", from: actorName, text: input.text, channel: channel.name, attachments: input.attachments, mode: input.mode });
      emit(state, "messageCreated", { type: "messageCreated", channel: channel.name, message });
      return message;
    },
    list: async (channel, options = {}) => limit([...state.messages.values()].filter((message) => message.channel?.name === normalizeChannelName(channel) && !message.parentId), options.limit),
    get: async (id) => requireMessage(state, id),
    reply: async (input) => createReply(state, actorName, input),
    direct: async (input) => {
      upsertAgent(state, input.to, { status: "online" });
      const conversationId = dmIdFor([actorName, input.to]);
      const message = createMessage(state, { id: input.__id, kind: "dm", from: actorName, text: input.text, conversationId, attachments: input.attachments, mode: input.mode, target: { kind: "agent", agentName: input.to } });
      upsertDm(state, conversationId, [actorName, input.to]);
      emit(state, "dmReceived", { type: "dmReceived", conversationId, message });
      return message;
    },
    groupDirect: async (input) => {
      const participants = [...new Set([actorName, ...(input.participants ?? [])])];
      participants.forEach((name) => upsertAgent(state, name, { status: "online" }));
      const conversationId = input.conversationId ?? `gdm_${++state.counters.dm}`;
      upsertDm(state, conversationId, participants, input.name);
      const message = createMessage(state, { id: input.__id, kind: "group_dm", from: actorName, text: input.text, conversationId, attachments: input.attachments, mode: input.mode, target: { kind: "group_dm", conversationId } });
      emit(state, "groupDmReceived", { type: "groupDmReceived", conversationId, message });
      return message;
    },
    createGroupDirect: async (input) => upsertDm(state, `gdm_${++state.counters.dm}`, input.participants ?? [], input.name),
    listDirect: async (input) => limit([...state.messages.values()].filter((message) => message.conversationId === input.conversationId), input.limit),
    markRead: async (messageId) => {
      const message = requireMessage(state, messageId);
      message.readers ??= new Set();
      message.readers.add(actorName);
      const receipt = { messageId: message.id, agentId: requireAgent(state, actorName).id, agentName: actorName, readAt: FIXED_TIME };
      emit(state, "messageRead", { type: "messageRead", messageId: message.id, agentName: actorName, readAt: receipt.readAt });
      return receipt;
    },
    readers: async (messageId) => [...(requireMessage(state, messageId).readers ?? new Set())].map((name) => ({ messageId, agentId: requireAgent(state, name).id, agentName: name, readAt: FIXED_TIME })),
    readStatus: async (channel) => [...state.agents.values()].map((agent) => ({ agentName: agent.name, lastReadId: lastMessageInChannel(state, channel)?.id, lastReadAt: FIXED_TIME })),
    reactions: async (messageId) => requireMessage(state, messageId).reactions ?? [],
    react: async (messageId, emoji) => {
      const message = requireMessage(state, messageId);
      const reaction = ensureReaction(message, emoji);
      if (!reaction.agents.includes(actorName)) reaction.agents.push(actorName);
      reaction.count = reaction.agents.length;
      emit(state, "reactionAdded", { type: "reactionAdded", messageId: message.id, emoji, agentName: actorName });
      return reaction;
    },
    unreact: async (messageId, emoji) => {
      const message = requireMessage(state, messageId);
      const reaction = ensureReaction(message, emoji);
      reaction.agents = reaction.agents.filter((name) => name !== actorName);
      reaction.count = reaction.agents.length;
      emit(state, "reactionRemoved", { type: "reactionRemoved", messageId: message.id, emoji, agentName: actorName });
    },
    search: async (query, options = {}) => limit([...state.messages.values()]
      .filter((message) => (!options.channel || message.channel?.name === normalizeChannelName(options.channel)) && String(message.text).toLowerCase().includes(String(query).toLowerCase()))
      .map((message) => ({ id: message.id, channelName: message.channel?.name ?? "", agentName: message.from?.name ?? "", text: message.text, createdAt: message.createdAt, relevanceScore: 1 })), options.limit),
  };
}

function createInboxSurface(state, actorName) {
  return {
    get: async () => ({
      unreadChannels: [],
      mentions: [...state.messages.values()].filter((message) => String(message.text).includes(`@${actorName}`)),
      unreadDms: [...state.messages.values()]
        .filter((message) => message.kind === "dm" && message.target?.agentName === actorName && !message.readers?.has(actorName))
        .map((message) => ({ conversationId: message.conversationId, from: message.from?.name, unreadCount: 1, lastMessage: { id: message.id, text: message.text, createdAt: message.createdAt } })),
      recentReactions: state.observed.events.filter((event) => event.type === "reactionAdded").map((event) => ({ messageId: event.messageId, channelName: requireMessage(state, event.messageId).channel?.name ?? "", emoji: event.emoji, agentName: event.agentName, createdAt: FIXED_TIME })),
    }),
    list: async () => ({ items: state.inboxItems.filter((item) => !actorName || item.recipient.name === actorName) }),
    subscribe: async function* () {
      for (const item of state.inboxItems.filter((candidate) => candidate.recipient.name === actorName || !actorName)) yield item;
    },
    ack: async (input) => updateInboxItem(state, input.inboxItemId, input.state ?? "delivered"),
    fail: async (input) => updateInboxItem(state, input.inboxItemId, "failed", input.error),
    defer: async (input) => updateInboxItem(state, input.inboxItemId, "deferred", input.reason, input.availableAt),
    markRead: async (input) => updateInboxItem(state, input.inboxItemId, "read"),
  };
}

function createCommandsSurface(state) {
  return {
    register: async (input) => ({ command: input.command, description: input.description, handlerAgent: input.handlerAgent, inputSchema: input.inputSchema, outputSchema: input.outputSchema, availableTo: input.availableTo }),
    list: async () => state.actions.list(),
    delete: async (command) => { state.actions.unregister(command); },
    available: () => true,
    agentScoped: () => true,
    invoke: async (name, input = {}) => {
      const invocationId = `inv_${++state.counters.invocation}`;
      state.actionInvocations.set(invocationId, { invocationId, actionName: name, callerName: "sdk", input, status: "invoked" });
      emit(state, "actionInvoked", { type: "actionInvoked", invocationId, actionName: name, callerName: "sdk", handlerAgentId: "handler" });
      return { invocationId, actionName: name, input, status: "invoked" };
    },
    getInvocation: async (_name, invocationId) => state.actionInvocations.get(invocationId),
    completeInvocation: async (name, invocationId, data) => {
      const invocation = state.actionInvocations.get(invocationId) ?? { invocationId, actionName: name };
      Object.assign(invocation, data, { status: data.error ? "failed" : "completed" });
      state.actionInvocations.set(invocationId, invocation);
      return invocation;
    },
  };
}

async function deliver(state, operation) {
  if (state.mock.delivery?.serverDeliveryState === false || state.mock.serverDeliveryState === false || operation.serverDeliveryState === false) {
    state.messaging.capabilities.serverDeliveryState = false;
  }
  const recipient = operation.to ?? operation.as ?? "worker";
  upsertAgent(state, recipient, { status: "online" });
  const message = createMessage(state, { id: operation.id, kind: "dm", from: operation.from ?? "system", text: operation.text ?? "delivery", conversationId: dmIdFor(["system", recipient]), target: { kind: "agent", agentName: recipient } });
  const item = { id: `inbox_${++state.counters.inbox}`, recipient: { name: recipient }, state: "queued", attempts: 0, message };
  state.inboxItems.push(item);
  const results = [];
  const fixture = state.mock.delivery ?? {};
  const deliveryResult = operation.result ?? fixture.result;
  const throws = operation.throws ?? fixture.throws;
  const delivery = deliveryResult
    ? { inject: async () => deliveryResult }
    : throws
      ? { inject: async () => { throw new Error(String(throws)); } }
    : { receiveMessage: async (_message, context) => ({ status: operation.status ?? "delivered", deliveryId: context.id, metadata: { mode: context.mode } }) };
  const runner = new DeliveryRunner({
    messaging: messagingFor(state, recipient),
    delivery,
    agentName: recipient,
    context: { mode: operation.mode === "steer" ? "immediate" : operation.mode === "wait" ? "next-message" : operation.mode },
    onResult: (_item, result) => results.push(result),
  });
  await runner.start();
  return { item, results };
}

function registerAction(state, operation) {
  const name = required(operation.name ?? operation.action, "name");
  const fixture = operation.handlerFixture ?? operation.fixture ?? "echo_text";
  const inputSchema = operation.inputSchemaFixture
    ? schemaFixture(operation.inputSchemaFixture)
    : operation.inputSchema ?? operation.input;
  const policy = fixture === "policy_deny" ? () => ({ allowed: false, reason: "policy denied by fixture" }) : undefined;
  const handle = state.actions.register({
    name,
    description: operation.description ?? name,
    inputSchema,
    outputSchema: operation.outputSchema ?? operation.output,
    policy,
    handler: handlerFixture(fixture),
  });
  const descriptor = state.actions.get(name);
  if (operation.unregisterAfter) handle.unregister();
  return { registered: name, handlerFixture: fixture, descriptor, unregistered: Boolean(operation.unregisterAfter) };
}

function handlerFixture(name) {
  switch (name) {
    case "echo_text":
      return (input) => ({ echoed: input?.text ?? input?.message ?? "" });
    case "sum_numbers":
      return (input) => ({ sum: input?.count !== undefined ? Number(input.count) * 2 : Number(input?.a ?? 0) + Number(input?.b ?? 0) });
    case "throw_error":
      return () => { throw new Error("fixture threw"); };
    case "invalid_output":
      return () => ({ invalid: "output" });
    case "policy_deny":
      return (input) => input;
    default:
      throw codedError("unknown_handler_fixture", `unknown handlerFixture: ${name}`);
  }
}

function schemaFixture(name) {
  switch (name) {
    case "coerce_string_count":
      return {
        safeParse(input) {
          if (input && typeof input === "object" && typeof input.count === "string") {
            return { success: true, data: { count: Number(input.count) } };
          }
          if (input && typeof input === "object" && typeof input.a === "string" && typeof input.b === "string") {
            return { success: true, data: { a: Number(input.a), b: Number(input.b) } };
          }
          return { success: false, error: { issues: [{ path: ["count"], message: "expected string count or string a/b values" }] } };
        },
      };
    default:
      throw codedError("unknown_schema_fixture", `unknown inputSchemaFixture: ${name}`);
  }
}

async function defineHarnessOperation(state, operation) {
  const harness = defineHarness({
    name: required(operation.name, "name"),
    version: operation.version,
    create: async (input, context) => ({
      identity: normalizeAgentIdentity({ id: context.agent.id, name: input?.name ?? operation.name, handle: context.agent.handle }),
      capabilities: MINIMAL_AGENT_SESSION_CAPABILITIES,
      receiveMessage: async (_message, deliveryContext) => ({ status: "delivered", deliveryId: deliveryContext.id }),
      release: async () => {},
    }),
  });
  const agent = await harness.create(operation.input ?? {});
  return { harness: harness.config.name, agent };
}

function addListenerOperation(state, operation) {
  const events = [];
  const off = state.listenerHub.addListener(operation.selector ?? "*", (event) => {
    events.push(event);
    state.contentLines.push(`listener ${event.type}`);
  });
  return { listening: operation.selector ?? "*", unsubscribe: Boolean(off), events };
}

function addPredicateListener(state, operation) {
  const predicate = buildPredicate(state, operation);
  const off = state.listenerHub.addListener(predicate, (event) => {
    state.contentLines.push(`predicate ${event.type}`);
  });
  return { listening: true, unsubscribe: Boolean(off) };
}

function buildPredicate(state, operation) {
  if (operation.predicate === "message.created") {
    let predicate = state.listenerHub.events.message.created();
    if (operation.channel) predicate = predicate.in(operation.channel);
    if (operation.mentions) predicate = predicate.mentions(operation.mentions);
    return predicate;
  }
  if (operation.predicate === "message.read") return state.listenerHub.events.message.read();
  if (operation.predicate === "message.reacted") return state.listenerHub.events.message.reacted();
  if (operation.predicate === "action") {
    let predicate = state.listenerHub.action(required(operation.action, "action"));
    if (operation.calledBy) predicate = predicate.calledBy(operation.calledBy);
    if (operation.phase === "completed") predicate = predicate.completed();
    if (operation.phase === "failed") predicate = predicate.failed();
    if (operation.phase === "denied") predicate = predicate.denied();
    return predicate;
  }
  if (operation.predicate === "status") return state.listenerHub.agent({ id: required(operation.agentId, "agentId"), name: operation.name ?? operation.agentId }).status.becomes(operation.status ?? "idle");
  throw codedError("unknown_predicate", `unknown predicate: ${operation.predicate}`);
}

function emitRawMessagingEvent(state, raw) {
  state.eventBus.emit(raw.type, raw);
  state.eventBus.emit("any", raw);
  state.observed.events.push(raw);
}

async function notify(state, operation) {
  const target = required(operation.target, "target");
  const text = operation.options?.text ?? operation.text ?? "notification";
  return messagingFor(state, operation.as).messages.direct({ to: target, text });
}

function record(state, op, value) {
  const text = stableStringify(value);
  state.contentLines.push(`${op}: ${text}`);
  state.observed.content = state.contentLines.join("\n");
  return value;
}

function buildActual(state) {
  const messages = [...state.messages.values()].map(publicMessage);
  const channels = [...state.channels.values()].map((channel) => ({ ...publicChannel(channel), members: [...channel.members].sort(compareStrings) }));
  const agents = [...state.agents.values()].map(publicAgent);
  state.observed.content = state.contentLines.join("\n");
  return {
    ok: state.observed.error === undefined,
    status: state.observed.error ? "failed" : "completed",
    content: state.observed.content,
    toolCalls: state.observed.toolCalls,
    observed: state.observed,
    messages,
    channels,
    agents,
    inboxItems: state.inboxItems,
    workspace: state.workspace,
    notes: "Relay eval ran against an in-memory SDK harness with no live broker.",
  };
}

function normalizeOperations(input) {
  if (input === undefined) return [];
  return Array.isArray(input) ? input : [input];
}

function messagingFor(state, as) {
  return as ? createMessagingClient(state, as) : state.messaging;
}

function requireAgentClientCapability(state, capability, as) {
  if (as && state.mock.clientCapabilities?.agentClient === false) {
    throw codedError("relay_capability_error", `RelayCapabilityError: ${capability} requires an agent-scoped client`);
  }
}

function createWorkspaceRecord(state, input = {}) {
  return {
    id: input.id ?? `ws_${state.workspaces.size + 1}`,
    name: input.name ?? "Relay Eval Workspace",
    key: input.key ?? nextWorkspaceKey(input.id ?? input.name ?? state.workspaces.size + 1),
    agents: input.agents ?? new Map(),
    channels: input.channels ?? new Map(),
    messages: input.messages ?? new Map(),
    dmConversations: input.dmConversations ?? new Map(),
    inboxItems: input.inboxItems ?? [],
  };
}

function seedWorkspace(state, input) {
  const workspace = createWorkspaceRecord(state, {
    id: input.id,
    name: input.name,
    key: input.key ?? input.workspaceKey,
  });
  state.workspaces.set(workspace.key, workspace);
  const previous = state.activeWorkspace;
  switchWorkspace(state, workspace);
  for (const agent of input.agents ?? []) {
    upsertAgent(state, agent.name, {
      type: agent.type ?? "agent",
      status: agent.status ?? "online",
      persona: agent.persona,
      metadata: agent.metadata,
      token: agent.token,
    });
  }
  for (const channel of input.channels ?? []) {
    upsertChannel(state, channel.name, {
      topic: channel.topic,
      metadata: channel.metadata,
      archived: channel.archived,
      members: channel.members ?? [],
    });
  }
  for (const message of input.messages ?? []) seedMessage(state, message);
  if (!state.agents.has("system")) upsertAgent(state, "system", { type: "system", status: "online" });
  if (previous) switchWorkspace(state, previous);
  return workspace;
}

function switchWorkspace(state, workspace) {
  state.activeWorkspace = workspace;
  state.workspace = publicWorkspace(workspace);
  state.agents = workspace.agents;
  state.channels = workspace.channels;
  state.messages = workspace.messages;
  state.dmConversations = workspace.dmConversations;
  state.inboxItems = workspace.inboxItems;
}

function publicWorkspace(workspace) {
  return { id: workspace.id, name: workspace.name, key: workspace.key, workspaceKey: workspace.key };
}

function nextWorkspaceKey(seed) {
  return `rk_live_${sanitizeKey(seed)}`;
}

function sanitizeKey(value) {
  return String(value ?? "workspace").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "workspace";
}

function seedMessage(state, message) {
  const from = message.from ?? message.agentName ?? message.as ?? "system";
  const to = message.to ? normalizeAgentName(message.to) : undefined;
  upsertAgent(state, from, { type: "agent", status: "online" });
  if (to) upsertAgent(state, to, { type: "agent", status: "online" });
  if (message.channel) upsertChannel(state, message.channel, { members: [from] });
  const kind = message.kind ?? (message.threadParent ? "thread_reply" : message.channel ? "channel" : "dm");
  const conversationId = message.conversationId ?? (kind === "dm" && to ? dmIdFor([from, to]) : undefined);
  createMessage(state, {
    id: message.id,
    kind,
    from,
    text: message.text ?? "",
    channel: message.channel,
    parentId: message.threadParent ?? message.parentId,
    conversationId,
    attachments: message.attachments,
    target: to ? { kind: "agent", agentName: to } : undefined,
  });
  if (conversationId && to) upsertDm(state, conversationId, [from, to]);
}

function listDms(state, actorName) {
  const conversations = [...state.dmConversations.values()];
  const visible = actorName ? conversations.filter((conversation) => conversation.participants.includes(normalizeAgentName(actorName))) : conversations;
  return visible.map((conversation) => ({
    ...conversation,
    messages: [...state.messages.values()].filter((message) => message.conversationId === conversation.id).map(publicMessage),
  }));
}

function upsertAgent(state, name, input = {}) {
  const cleanName = normalizeAgentName(required(name, "agent.name"));
  const existing = state.agents.get(cleanName);
  const agent = existing ?? {
    id: input.id ?? `agent_${++state.counters.agent}`,
    name: cleanName,
    type: input.type ?? "agent",
    status: input.status ?? "online",
    token: input.token ?? `at_eval_${cleanName}`,
    metadata: {},
    channels: new Set(),
    createdAt: FIXED_TIME,
  };
  Object.assign(agent, {
    type: input.type ?? agent.type,
    status: input.status ?? agent.status,
    persona: input.persona ?? agent.persona,
    metadata: input.metadata ?? agent.metadata,
  });
  state.agents.set(cleanName, agent);
  return agent;
}

function upsertChannel(state, name, input = {}) {
  const cleanName = normalizeChannelName(required(name, "channel.name"));
  const existing = state.channels.get(cleanName);
  const channel = existing ?? {
    id: input.id ?? `ch_${++state.counters.channel}`,
    name: cleanName,
    topic: input.topic,
    metadata: input.metadata ?? {},
    archived: Boolean(input.archived),
    members: new Set(),
    createdAt: FIXED_TIME,
  };
  if (input.topic !== undefined) channel.topic = input.topic;
  if (input.metadata !== undefined) channel.metadata = input.metadata;
  if (input.archived !== undefined) channel.archived = Boolean(input.archived);
  for (const member of input.members ?? []) {
    channel.members.add(normalizeAgentName(member));
    upsertAgent(state, member, { status: "online" });
  }
  state.channels.set(cleanName, channel);
  return channel;
}

function createMessage(state, input) {
  const id = input.id ?? `m_${++state.counters.message}`;
  const from = upsertAgent(state, input.from ?? "system", { status: "online" });
  const message = {
    id,
    messageId: id,
    kind: input.kind,
    text: input.text ?? "",
    from: { id: from.id, name: from.name },
    channel: input.channel ? { name: normalizeChannelName(input.channel) } : undefined,
    target: input.target,
    conversationId: input.conversationId,
    parentId: input.parentId,
    threadId: input.parentId,
    mode: input.mode,
    attachments: input.attachments ?? [],
    reactions: [],
    readers: new Set(),
    replyCount: 0,
    createdAt: FIXED_TIME,
  };
  if (input.parentId && state.messages.has(input.parentId)) {
    state.messages.get(input.parentId).replyCount += 1;
  }
  state.messages.set(id, message);
  return message;
}

function createReply(state, actorName, input) {
  const parent = requireMessage(state, input.messageId);
  const message = createMessage(state, {
    id: input.__id,
    kind: "thread_reply",
    from: actorName,
    text: input.text,
    channel: parent.channel?.name,
    parentId: parent.id,
  });
  emit(state, "threadReply", { type: "threadReply", channel: parent.channel?.name ?? "", parentId: parent.id, message });
  return message;
}

function upsertDm(state, id, participants, name) {
  const conversation = { id, conversationId: id, name, participants: [...new Set(participants)].sort(compareStrings) };
  state.dmConversations.set(id, conversation);
  return conversation;
}

function emit(state, type, event) {
  const raw = event?.type ? event : { ...event, type };
  state.observed.events.push(raw);
  state.eventBus.emit(type, raw);
  state.eventBus.emit("any", raw);
}

function createEventBus() {
  const handlers = new Map();
  return {
    connect() {},
    async disconnect() {},
    subscribe() {},
    unsubscribe() {},
    on(type, handler) {
      const set = handlers.get(type) ?? new Set();
      set.add(handler);
      handlers.set(type, set);
      return () => set.delete(handler);
    },
    emit(type, event) {
      for (const handler of handlers.get(type) ?? []) handler(event);
    },
  };
}

function updateInboxItem(state, inboxItemId, nextState, reason, availableAt) {
  const item = state.inboxItems.find((candidate) => candidate.id === inboxItemId);
  if (item) {
    item.state = nextState;
    item.reason = reason;
    item.availableAt = availableAt;
  }
  return { supported: false, action: nextState === "failed" ? "fail" : nextState === "deferred" ? "defer" : "ack", messageId: item?.message?.id ?? inboxItemId, reason, deferUntil: availableAt };
}

function publicAgent(agent) {
  return { id: agent.id, name: agent.name, type: agent.type, status: agent.status, persona: agent.persona, metadata: agent.metadata ?? {}, createdAt: agent.createdAt, channels: [] };
}

function publicChannel(channel) {
  return {
    id: channel.id,
    name: channel.name,
    topic: channel.topic,
    metadata: channel.metadata ?? {},
    archived: Boolean(channel.archived),
    memberCount: channel.members.size,
    members: [...channel.members].sort(compareStrings).map((name) => ({ agentId: name, agentName: name, role: "member", muted: false })),
  };
}

function publicMessage(message) {
  return {
    ...message,
    reactions: message.reactions ?? [],
    readers: [...(message.readers ?? new Set())],
    readByCount: message.readers?.size ?? 0,
  };
}

function requireAgent(state, name) {
  const agent = state.agents.get(normalizeAgentName(name));
  if (!agent) throw codedError("agent_not_found", `agent not found: ${name}`);
  return agent;
}

function requireChannel(state, name) {
  const channel = state.channels.get(normalizeChannelName(name));
  if (!channel) throw codedError("channel_not_found", `channel not found: ${name}`);
  return channel;
}

function requireMessage(state, id) {
  const message = state.messages.get(id);
  if (!message) throw codedError("message_not_found", `message not found: ${id}`);
  return message;
}

function ensureReaction(message, emoji) {
  let reaction = message.reactions.find((candidate) => candidate.emoji === emoji);
  if (!reaction) {
    reaction = { emoji, count: 0, agents: [] };
    message.reactions.push(reaction);
  }
  return reaction;
}

function lastMessageInChannel(state, channel) {
  return [...state.messages.values()].filter((message) => message.channel?.name === normalizeChannelName(channel)).at(-1);
}

function agentNameFromToken(state, token) {
  return [...state.agents.values()].find((agent) => agent.token === token)?.name ?? String(token ?? "").replace(/^at_eval_/, "");
}

function makeErrorFixture(input) {
  if (input?.code || input?.message || input?.status || input?.statusCode) {
    return Object.assign(new Error(input.message ?? ""), input);
  }
  if (input?.invalidToken) return Object.assign(new Error("Invalid agent token"), { code: "AGENT_TOKEN_INVALID" });
  return input;
}

function emptyIntegrations() {
  const list = async () => [];
  return {
    webhooks: { create: async (input) => ({ id: "wh_eval", ...input }), list, delete: async () => {}, trigger: async (_id, payload) => payload },
    subscriptions: { create: async (input) => ({ id: "sub_eval", ...input }), list, get: async (id) => ({ id }), delete: async () => {} },
  };
}

function emptyWebhooks() {
  const list = async () => [];
  return {
    createInbound: async (input) => ({ webhookId: "in_wh_eval", url: "https://eval.invalid/webhook", token: "tok_eval", channel: input.channel, name: input.name }),
    subscribe: async (input) => ({ id: "sub_eval", ...input }),
    list,
    delete: async () => {},
    subscriptions: list,
    unsubscribe: async () => {},
  };
}

function limit(items, count) {
  return count ? items.slice(0, count) : items;
}

function normalizeChannelName(name) {
  return String(name ?? "").replace(/^#/, "");
}

function normalizeAgentName(name) {
  return String(name ?? "").replace(/^@/, "");
}

function dmIdFor(participants) {
  return `dm_${participants.map(normalizeAgentName).sort(compareStrings).join("_")}`;
}

function required(value, name) {
  if (value === undefined || value === null || value === "") throw codedError("invalid_args", `${name} is required`);
  return value;
}

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function normalizeError(error) {
  if (error?.name === "RelayCapabilityError") {
    const capability = error.capability ?? (String(error.message).includes("server-backed delivery state") ? "messaging.capabilities.serverDeliveryState" : undefined);
    return {
      code: "relay_capability_error",
      message: `RelayCapabilityError${capability ? ` ${capability}` : ""}: ${error.message}`,
    };
  }
  return {
    code: error?.code ?? error?.name ?? "error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function stableStringify(value) {
  return JSON.stringify(value, (_key, item) => item instanceof Set ? [...item] : item, 2);
}

function compareStrings(left, right) {
  return String(left).localeCompare(String(right), "en");
}
