// Loaded only in the untrusted candidate CLI process. It forwards API
// requests to the trusted loopback broker; it never receives an upstream
// credential. Direct requests still work for non-Relay origins, but the
// candidate environment contains no secret capable of authenticating them.
const brokerUrl = process.env.RELAY_FLEET_BROKER_URL;
const capability = process.env.RELAY_FLEET_BROKER_CAPABILITY;
const approvedOrigins = new Set(
  [process.env.RELAY_FLEET_CLOUD_ORIGIN, process.env.RELAY_FLEET_RELAY_ORIGIN].filter(Boolean)
);

if (!brokerUrl || !capability || approvedOrigins.size !== 2) {
  throw new Error('candidate credential broker configuration is incomplete');
}

const nativeFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async function candidateBrokerFetch(input, init) {
  const request = new Request(input, init);
  const target = new URL(request.url);
  if (!approvedOrigins.has(target.origin)) return nativeFetch(input, init);

  const body = new Uint8Array(await request.arrayBuffer());
  const headers = Object.fromEntries(request.headers.entries());
  const response = await nativeFetch(brokerUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-relay-fleet-capability': capability,
    },
    body: JSON.stringify({
      target: request.url,
      method: request.method,
      headers,
      body: Buffer.from(body).toString('base64'),
    }),
  });
  if (!response.ok && response.status !== 401 && response.status !== 403) return response;
  return response;
};
