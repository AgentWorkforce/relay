import { createHash } from 'node:crypto';

/** Read-only Management MCP; never expose headers, tokens, or provider content. */
export async function nangoLogsCall(name, args, key, request = fetch) {
  if (!['logs_list_operations', 'logs_get_operation'].includes(name))
    throw new Error('Only read-only Nango log tools are allowed');
  if (!key) throw new Error('NANGO_SECRET_KEY is required for evidence readback');
  const response = await request('https://mcp.nango.dev/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Nango log read failed: HTTP ${response.status}`);
  const text = await response.text();
  const body = text.trimStart().startsWith('{')
    ? JSON.parse(text)
    : JSON.parse(
        text
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .at(-1)
          ?.slice(6) ?? '{}'
      );
  if (body.error || body.result?.isError) throw new Error('Nango log tool returned an error');
  const data =
    body.result?.structuredContent ??
    JSON.parse(body.result?.content?.find((b) => b.type === 'text')?.text ?? 'null');
  if (!data || !data.pagination || !Object.hasOwn(data.pagination, 'cursor'))
    throw new Error('Nango log response lacks pagination evidence');
  return data;
}

export function nangoForwardReceipts(operation, messages, expected) {
  if (
    operation.operation?.type !== 'webhook' ||
    operation.operation?.action !== 'forward' ||
    operation.integrationName !== expected.providerConfigKey
  )
    return [];
  const receipts = [];
  for (const message of messages) {
    const request = message.request ?? {},
      body = request.body ?? {},
      headers = Object.fromEntries(
        Object.entries(request.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
      );
    const payload = body.payload ?? {};
    if (
      request.url !== expected.destination ||
      request.method?.toUpperCase() !== 'POST' ||
      body.connectionId !== expected.connectionId ||
      body.providerConfigKey !== expected.providerConfigKey ||
      payload.repository?.full_name !== expected.repo
    )
      continue;
    const encoded = JSON.stringify(payload);
    if (!encoded.includes(`GHSUB_EVENT_NONCE=${expected.nonce}`)) continue;
    const deliveryId = headers['x-github-delivery'];
    if (typeof deliveryId !== 'string' || !deliveryId || !message.id || !operation.id)
      throw new Error('Matching Nango forward lacks independent delivery identity');
    receipts.push({
      nangoOperationId: operation.id,
      nangoMessageId: message.id,
      environment: operation.environmentName,
      observedAt: message.createdAt,
      endedAt: message.endedAt,
      destination: new URL(request.url).origin + new URL(request.url).pathname,
      status: message.response?.code,
      connectionId: body.connectionId,
      providerConfigKey: body.providerConfigKey,
      githubDeliveryId: deliveryId,
      githubEvent: headers['x-github-event'],
      githubAction: payload.action,
      hookId: headers['x-github-hook-id'],
      repository: payload.repository.full_name,
      nonceDigest: createHash('sha256').update(expected.nonce).digest('hex'),
      payloadSha256: createHash('sha256').update(encoded).digest('hex'),
    });
  }
  return receipts;
}

/** Empty pages can carry a cursor. Exhaust both operation and message pagination. */
export async function captureNangoForwards(call, expected, period) {
  const receipts = [],
    operations = new Set(),
    operationCursors = new Set();
  let cursor;
  for (let page = 0; page < 1000; page++) {
    const data = await call('logs_list_operations', {
      operations: [{ type: 'webhook', actions: ['forward'] }],
      integrations: [expected.providerConfigKey],
      period,
      limit: 100,
      ...(cursor ? { cursor } : {}),
      // Forward operations have no top-level connection ID. Match their request bodies below.
    });
    if (!Array.isArray(data.operations)) throw new Error('Invalid Nango operation inventory');
    const fresh = data.operations.filter((operation) => {
      if (operations.has(operation.id)) return false;
      operations.add(operation.id);
      return true;
    });
    const inspect = async (operation) => {
      const messages = [],
        messageCursors = new Set();
      let messageCursor;
      for (let detailPage = 0; detailPage < 1000; detailPage++) {
        const detail = await call('logs_get_operation', {
          operationId: operation.id,
          messages: { limit: 100, ...(messageCursor ? { cursor: messageCursor } : {}) },
        });
        if (!Array.isArray(detail.messages) || detail.operation?.id !== operation.id)
          throw new Error('Invalid Nango operation detail');
        messages.push(...detail.messages);
        messageCursor = detail.pagination.cursor;
        if (messageCursor === null) break;
        if (typeof messageCursor !== 'string' || messageCursors.has(messageCursor) || detailPage === 999)
          throw new Error('Incomplete Nango message pagination');
        messageCursors.add(messageCursor);
      }
      return nangoForwardReceipts(operation, messages, expected);
    };
    // Independent operation histories can be read together. Keep pagination
    // sequential within each history and settle the entire bounded batch before
    // reporting an error; partial scans must never claim exhaustion.
    for (let offset = 0; offset < fresh.length; offset += 4) {
      const batch = await Promise.allSettled(fresh.slice(offset, offset + 4).map(inspect));
      const failure = batch.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
      for (const result of batch) receipts.push(...result.value);
    }
    cursor = data.pagination.cursor;
    if (cursor === null) return { receipts, inspectedOperations: operations.size, exhausted: true };
    if (typeof cursor !== 'string' || operationCursors.has(cursor))
      throw new Error('Incomplete Nango operation pagination');
    operationCursors.add(cursor);
  }
  throw new Error('Nango operation pagination limit exceeded');
}
