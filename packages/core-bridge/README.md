# @agent-relay/core-bridge

A Node client for the local Agent Relay core's bridge: JSON-RPC 2.0 over
newline-delimited JSON, on a Unix socket (macOS, Linux) or a named pipe
(Windows). It is the client the `agent-relay` CLI uses to find, greet and drive
the core that the Agent Relay desktop app or `agent-relay init` started.

ESM only, Node 22 or later, no runtime dependencies.

```ts
import { connectCore, spawnTargets } from '@agent-relay/core-bridge';

await using client = await connectCore();
console.log(client.hello.daemon_version, client.hello.methods);
const status = await client.call('status.get');
```

## Connecting

- `connectCore(opts?)` resolves the socket, checks it (see Security), connects,
  sends `hello` with this package's `BRIDGE_VERSION`, checks the greeting and
  returns a `CoreClient`. It throws a typed error on any failure.
- `tryConnectCore(opts?)` is the same, but resolves `undefined` when no core is
  running (`CoreNotRunningError`). Every other failure still throws, so a
  refused or impostor socket never looks like "no core, start one".
- Options: `socket` (default `coreSocketPath(env, home)`), `env`, `home`,
  `connectTimeoutMs` and `callTimeoutMs` (both default 15 000 ms), and `signal`
  (aborts connecting; once connected, aborting closes the client).
- `coreSocketPath(env?, home?)` returns `$AGENT_RELAY_CORE_SOCKET` when set, or
  `~/.agentworkforce/desktop/core.sock`. `pipeName(socket)` returns the Windows pipe the
  core binds for that path.

## CoreClient

- `hello`: the frozen greeting (`bridge_version`, `daemon_version`, `pid`,
  `methods`, `topics`). Feature-detect with `hello.methods.includes(...)`.
- `call(method, params?, { timeoutMs?, signal? })`: one request; resolves with
  `result`, rejects with a typed error. A timeout or abort abandons that call
  only; the connection stays open and a late reply is ignored.
- `subscribe(topics)` / `unsubscribe(topics)`: topics are `status`, `activity`,
  `shutdown`, `invalidated`, `notify` and `sign_in`.
- `onEvent(listener)` / `onClose(listener)`: return a function that removes the
  listener.
- `closed`, `close()`, and `[Symbol.asyncDispose]()` for `await using`.

### Events

A line with `method: "event"` and no `id` is delivered to `onEvent` listeners as
`{ topic, seq, data }`. Events arrive only for subscribed topics. Other
notifications and unparseable lines are ignored, so new server notifications do
not break this client. A listener that throws does not stop the read loop. A
`shutdown` event is followed by the core closing the connection, which fires
`onClose`.

### Ordering

The core answers one connection's requests in order. `spawn.invoke` makes
network calls and can take a while, so a caller that also polls (for example
`spawn.status` or `status.get`) should open a second `connectCore` for the slow
calls. The package does not pool connections.

## Size limits

These limits are new compared with the client that used to live in the CLI:

- **Replies: 16 MiB per line** (`MAX_REPLY_BYTES`, the core's own reply cap). A
  buffered line over this size closes the connection: pending calls and the
  `onClose` listeners receive `CoreReplyTooLargeError`. Open a new connection
  afterwards. Before, the buffer grew without bound.
- **Requests: 1 MiB per line** (`MAX_REQUEST_BYTES`, the core's `MAX_FRAME_BYTES`),
  measured in UTF-8 bytes of the serialized request. A larger request is
  refused locally with `CoreRequestTooLargeError` and nothing is sent; the
  connection stays usable. Before, the core answered `invalid_request` and
  dropped the connection.

## Errors

Every error extends `CoreBridgeError` and carries a `code`:

| Class                                                                  | `code`                    | When                                                                                        |
| ---------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------- |
| `CoreNotRunningError`                                                  | `core_not_running`        | no socket file (not on Windows), nothing listening, or connect timed out                    |
| `CoreUntrustedError` (`reason`)                                        | `core_untrusted`          | the socket's directory or the socket fails the owner/mode checks                            |
| `NotACoreError`                                                        | `not_a_core`              | the greeting is not a core's (no numeric `bridge_version`/`pid`, or another bridge version) |
| `BridgeVersionMismatchError` (`clientVersion`, `coreMessage`)          | `bridge_version_mismatch` | the core refused this bridge version                                                        |
| `CoreBridgeError`                                                      | `handshake_failed`        | `hello` failed for any other reason                                                         |
| `CoreRpcError` (`rpcCode`, `kind`, `retryable`, `planLimit`, `reason`) | `rpc_error`               | any JSON-RPC error reply                                                                    |
| `CoreTimeoutError` (`method`)                                          | `timeout`                 | no reply in time                                                                            |
| `CoreReplyTooLargeError`                                               | `reply_too_large`         | see Size limits                                                                             |
| `CoreRequestTooLargeError` (`method`, `bytes`, `limit`)                | `request_too_large`       | see Size limits                                                                             |
| `CoreClosedError`                                                      | `closed`                  | a call after close, or the connection closed or failed with calls pending                   |
| `CoreBridgeError`                                                      | `invalid_params`          | a spawn helper refused its params locally                                                   |

`CoreRpcError.kind` is the core's `data.kind` (`ErrorKind`; unknown kinds are
passed through as strings). With kind `refused`, `CoreRpcError.reason` is the
core's `data.reason` when it gave one (`RefusalReason`: `service_unknown`,
`service_disabled`, `service_expired`, `workspace_mismatch`, `not_owner`,
`outside_scope`, `management_peer`; unknown reasons are passed through as
strings) and `undefined` otherwise. `CoreCallError` is a deprecated alias of
`CoreRpcError` and will be removed in a later release.

## Native spawn controls

`spawnTargets`, `spawnInvoke`, `spawnStatus` and `spawnRelease` wrap
`spawn.targets`, `spawn.invoke`, `spawn.status` and `spawn.release` with types
copied from the core's contract. Each helper:

- throws `CoreRpcError` with kind `method_not_found` before sending anything
  when `hello.methods` lacks the method;
- checks params with the core's rules (name segments `^[A-Za-z0-9_-]{1,200}$`,
  idempotency keys at least 16 characters, a task that is non-empty and at most
  64 KiB, an absolute directory with no NUL) and throws `CoreBridgeError`
  `invalid_params` naming the field, never its value;
- sends exactly the contract's keys, since the core refuses unknown fields;
- returns the invocation with `released` read strictly: `true` only when the
  core reported the provider released the agent, `false` when absent (an
  older core) or anything else. It is never derived from `status`, so a
  `completed` release is not by itself a confirmed one. `isReleaseConfirmed`
  makes that check on any reply.

Each helper accepts per-call timeout and cancellation options. `spawn.invoke`
and `spawn.release` take `actionTimeoutMs`, which defaults to six minutes
(`DEFAULT_SPAWN_ACTION_TIMEOUT_MS`) because verified startup and exact cleanup
can legitimately exceed the bridge client's 15-second call deadline; that
deadline still governs every other call.

The core stays authoritative. Rules a caller must know:

- A session caller passes `caller_name`, which must be an active local
  registration of this core with a stored token. The core uses that
  registration; no token crosses the bridge.
- A service caller binds its connection first and then passes no caller:

  ```ts
  const descriptor = await readCallerDescriptor('/path/to/caller.json');
  requireServiceCallerMethods(client);
  await authenticate(client, descriptor.credential); // spawn_callers.challenge + .authenticate
  await spawnInvoke(client, { node_id, node_name, name, harness, task, directory, idempotency_key });
  ```

  `readCallerDescriptor` requires schema `agent-relay-service-caller/2` and the
  exact `challenge-hmac-sha256/v1` auth route, and refuses schema 1
  static-secret files. `readCallerCredential` retains its 18.0 compatibility
  behavior and still accepts them.
  `authenticate` requires only `spawn_callers.challenge` and
  `spawn_callers.authenticate` before it sends a challenge. Consumers that
  need the complete service-caller lifecycle must call
  `requireServiceCallerMethods(client)` to fail closed when any method is
  absent.

  `authenticate` answers a single-use challenge with
  `HMAC-SHA256(SHA-256(secret), transcript)`. A connection binds once; three
  failed attempts lock it (`auth_locked`), so open a new connection.

- No params carry a credential. A `caller_secret` key is refused locally
  (`legacy_credential_refused`) before anything is sent, and by the core.
- `spawn.invoke` targets only this computer's own spawn node, which must be
  live, have `handlers_live`, not be stale, and advertise `spawn:<harness>`.
- Persist idempotency keys (`newIdempotencyKey()` makes one) and reuse them on
  retry.
- `spawn.status` fills in `agent_id`, `name` and `node_id` only for spawns made on
  this core.

## Service-caller result inbox

After `authenticate` binds a connection, the service-caller helpers use the
connection as the caller and send no `caller_name` or `caller_secret`:

```ts
const descriptor = await readCallerDescriptor('/path/to/caller.json');
await using client = await connectCore({ socket: descriptor.socket });
requireServiceCallerMethods(client);
await authenticate(client, descriptor.credential);
const identity = await serviceCallerIdentity(client);
assertServiceCallerIdentity(descriptor, identity);
const { iterator_id } = await serviceCallerInboxOpen(client, invocationId);
const { delivery } = await serviceCallerInboxNext(client, iterator_id);

if (delivery?.text !== undefined) {
  await writeResultToJournal(delivery.text);
  await serviceCallerInboxAck(client, delivery.item_id);
} else if (delivery?.failure) {
  await writeFailureToJournal(delivery.failure);
  await serviceCallerInboxFail(client, delivery.item_id);
}

await serviceCallerInboxClose(client, iterator_id);
await serviceCallerDisconnect(client);
```

`serviceCallerInboxOpen` binds one iterator to one invocation. `inbox.next`
long-polls for at most 30 seconds; its helper gives the bridge call five extra
seconds by default and preserves an explicit call timeout or abort signal. Use
an independent authenticated connection for each concurrently waiting inbox,
because the core answers one connection's calls in order.

`readCallerDescriptor(path)` returns the exact validated schema-v2 handoff from
the same secure file read: its redacting credential, socket, publisher,
workspace and account identity, allowed harnesses and directories, ownership
rule, timestamps, Desktop version and exact inbox route. It rejects unknown
top-level or nested fields, a retired schema, a changed auth/inbox route,
relative socket or directory paths, malformed timestamps and duplicate scope
entries. The descriptor never contains the secret. `readCallerCredential`
remains as a convenience for consumers that need only challenge
authentication. Before spawning, use `assertServiceCallerIdentity` to compare
the authenticated publisher and workspace to the descriptor; the helper
returns no mismatched value in its error.

The settlement helpers hard-code the only metadata Desktop accepts:
`{"relayflows_result":"journaled"}` for ack and
`{"relayflows_result":"rejected"}` for fail. Journal the terminal result or
failure before settling it. An ack of a failure delivery is refused by the
core. Close every iterator before `serviceCallerDisconnect`; disconnect fails
while an iterator is still open. Closing the bridge connection also closes its
iterators and releases their unsettled delivery leases.

Every helper feature-detects its method, validates its input without echoing
values, and refuses malformed replies. Settlement replies must match the item,
action and terminal state requested; delivery replies must contain exactly one
of `text` or a typed failure.

## Versioning

`BRIDGE_VERSION` is the wire contract. The core changes it only when something
is removed, renamed or changes meaning; new methods, params, result fields,
topics and error kinds do not change it, so feature-detect with `hello.methods`.
The core speaks exactly one bridge version and this client never downgrades. The
package version moves in lockstep with the relay repository; a `BRIDGE_VERSION`
bump is a semver-major release of this package.

## Security

- On macOS and Linux, before connecting: the socket's directory (and its
  symlink, if any) must be owned by you and not group- or world-writable, and
  the socket must be a socket owned by you with mode 0600. This stands in for
  peer credentials, which Node cannot read. The core itself also drops any peer
  whose uid differs from its own.
- Any failure other than "not running" throws, so callers never start a second
  core next to a refused one.
- **Windows gap (accepted):** there are no file checks. The pipe's DACL admits
  only the current user, refuses remote clients and holds the name exclusively,
  but unlike the Rust clients this package cannot verify that the pipe's
  _server_ runs as the current user without native code.
- No credential crosses this client: `authenticate` sends a caller id and an
  HMAC, never the secret or its key, and `CallerCredential` prints as
  `[redacted]`. It never logs params or replies (a spawn task can hold user
  text).
- `readCallerCredential` refuses, on macOS and Linux, a `caller.json` that is a
  symlink, not a regular file, not owned by you, has any group or other
  permission bit, sits in a group- or world-writable directory that is not
  sticky, or is over 64 KiB. **Windows gap:** Node cannot read access lists,
  so on Windows it checks only that the path is absolute, not a link or
  reparse point, a regular file and at most 64 KiB; it relies on the per-user
  profile's access list that Agent Relay Desktop writes the file under.
