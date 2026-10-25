# Starting a Capy thread from Relay Desktop

Relay Desktop can start a headless Capy thread without receiving the
workspace's Capy key. The macOS and Linux apps call typed relay-core methods;
the core uses the signed-in person's Agent Relay Cloud session, and Cloud
makes the Capy request with the encrypted workspace key.

## Ownership and authorization

The Capy service-user key stays in Agent Relay Cloud under **Settings →
Workspace → Capy**. Cloud stores the encrypted key and never returns it to the
desktop app or relay core. Thread creation, binding, delivery subscriptions and
grants therefore remain in the same server-side trust boundary.

The workspace routes require a person connection whose current workspace is
the workspace in the path. Only a current workspace owner or admin may list
projects, start a thread or read its spawn status.

## Shipped Cloud API

Relay Desktop uses these session-authenticated routes under `/api/v1`:

- `GET /workspaces/{workspaceId}/capy/projects?cursor=` returns
  `{"projects":[{"id","name"}],"truncated","nextCursor"}`. When
  `truncated` is true, the app passes `nextCursor` to the next request.
- `POST /workspaces/{workspaceId}/capy/thread-spawns` accepts
  `clientRequestId`, `projectId`, `task`, optional `model`, optional
  `pullRequestAuthor` (`user` or `capy`), and optional `reportTo`.
- `GET /workspaces/{workspaceId}/capy/thread-spawns/{threadId}` returns the
  current thread and relay-binding status. The path uses Capy's thread id, not
  the client request id.

The create and status responses are:

```json
{
  "thread_id": "jam_…",
  "title": "…",
  "status": "…",
  "binding": { "state": "pending" }
}
```

After the first turn binds the thread, `binding` is
`{"state":"bound","agent":"capy-…"}`. Bound means the binding is active,
its delivery subscription is installed, and its grant is live.

Cloud returns safe JSON errors as `{"error":"…","retryAfterSeconds":…}`.
Relevant statuses are 401, 403, 404, 409 when Capy is not connected, 429 and
502. Neither Cloud nor the desktop logs the Capy key or returns a raw provider
response.

## Idempotency and first-turn binding

Before either UI makes the create call, it saves a `capyThreadSpawn.v1`
operation in its native preferences. That record contains the workspace,
form values and one `relay-desktop-<uuid>` `clientRequestId`. A failed call,
timeout or app restart reuses the same record. **Start another** clears it and
creates a new id.

Cloud derives Capy's required request id from the workspace, signed-in person
and client request id:

```text
agent-relay-<sha256(workspaceId + NUL + userId + NUL + clientRequestId)>
```

Cloud always creates an organization-visible thread, does not export the
service-user key, and prefixes the task with an instruction to call
`bind_capy_thread` before doing the work. Replaying a create with the same
client id therefore returns the same Capy thread.

## Desktop behavior

The relay core exposes `capy.projects.list`, `capy.threads.spawn` and
`capy.threads.get`. It supplies the current workspace from its Cloud session,
reduces responses to the shared contract models and never exposes credentials.

Starting Capy threads is an agent operation. macOS and Linux omit
**Start Capy thread…** from the account and Agents/Team overflow menus.
The retained form implementation selects a project, takes the task and optionally
selects a model and pull-request author. Both apps use the same states:

- **Starting Capy thread…** while the create call is unresolved.
- **Thread started · Waiting for Capy to join the relay** after Capy returns
  but before the first turn binds.
- **Running on the relay**, the thread id, `@agent`, **Message**, and **Start
  another** once Cloud reports the binding.

When the workspace has no Capy connection, the error offers **Agent Relay
Cloud → Settings → Workspace → Capy**. Other Cloud errors remain bounded to
project access, write access, rate limiting, reachability and binding status.
A binding-status error stays visible beside the waiting state with **Check
again**; retrying never replaces the saved idempotency key.
