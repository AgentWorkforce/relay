# Continue Claude from your phone

This experimental path sends the signed-in computer owner's messages into an
existing Claude Code conversation as native user turns. Claude stays running
on a Mac or Linux computer. Its session ID, working directory, tools, model, and permission
configuration stay in place, and the desktop conversation receives the same turns.

## Enable it once

1. Update Agent Relay Desktop and the iPhone/iPad app.
2. Use Claude Code 2.1.310 or later in the 2.1 release series.
3. Enable agent hosting and wait for the computer to be claimed by your signed-in
   account. This first version uses that verified ownership binding.
4. In desktop Settings, enable **Continue Claude from mobile (Experimental)**.
   This installs Agent Relay's bundled Claude plugin in each watched Claude
   login folder that you share with Relay, including separate logins. New shared
   folders discovered later receive the plugin automatically. Start a new Claude
   session, or run `/reload-plugins` once in an existing session after its folder
   receives the plugin. Unshared folders are left alone. Sessions whose plugin
   could not be installed, or whose ID matches multiple native sessions, do not
   advertise native mobile continuation.
5. On the phone, open the existing agent conversation and send a message.

Reading the conversation sends nothing. A message stays queued until Claude
can accept it; opening the phone app does not take over a busy turn. A delivery
receipt means native input was accepted, not that Claude has finished the task.
Tool approvals arrive in the same mobile conversation and apply to one action.
They expire after five minutes. Connection retries reuse the same prompt and
decision; they do not grant approval or create another prompt.
Answers and approvals stay bound to the account and workspace that started the
turn, including when a connection retry overlaps an account switch.
Claude's existing permission hooks still apply. Interactive `AskUserQuestion`
forms remain in the desktop UI in this version.

After your first mobile message, replies stay synced to your phone, including
replies to later messages you type in the same desktop conversation. Before
that first mobile message, desktop replies are not forwarded. Permission
prompts for turns you start on the desktop still use Claude's desktop UI.

Keep the computer awake and Claude running. Returning to its desktop window
requires no merge or new session. Other agents' messages remain peer messages;
they cannot use this native owner-input path or approve its tool requests.
Disabling the setting cancels queued submissions and clears the mobile status.
An uncertain submission is never automatically replayed.
Restarting Agent Relay ends existing native control generations and their pending
approvals. Send a new mobile message to reconnect to the same Claude conversation;
no plugin reload is needed for a Relay restart. Previously submitted messages are
not replayed, and approvals from before the restart cannot authorize a later turn.
If login sharing settings cannot be read, native support pauses until they can be
verified again; Relay does not install into unknown folders or treat that outage
as an explicit unshare.

Long answers are shortened with a visible notice on mobile; their complete text
remains in Claude. Answers awaiting transport are kept in a bounded in-memory
plugin queue, so closing Claude while offline can lose undelivered mobile replies.

## Platform boundary

Claude connects directly through its native HTTP API to Agent Relay's private
Unix socket. The core requires the exact registered Claude process; tool
subprocesses cannot access the native-input bridge. The installed bridge config
contains only the socket path, never a helper executable or credential.

Windows keeps the setting visible but disabled, with an explanation. Its core
reports native continuation unsupported and refuses opt-in before installation.
Claude's native connection must be verified with Windows named pipes before the
feature can be enabled there. No subprocess fallback is provided.

## Validation

- `node --test scripts/test-claude-mobile-plugin.mjs` checks native submission,
  retry safety, conversation identity, permission decisions, and answer forwarding.
- Rust tests cover the durable queue, current owner and process authorization,
  session-socket routes, installer, opt-out, and scoped approval replies.
- **Mobile CI** runs the iOS unit tests and `MobileHandoffUITests` on a simulator.
  Its artifact includes screenshots of queued, connecting, ready, and failed states.
- `python3 scripts/test-claude-handoff.py --run --claude /absolute/path/to/claude`
  starts a disposable real Claude session on Unix. It tests desktop input, the
  bundled plugin's native user input, a delayed permission denial, and desktop
  input again, preserving the same session, process, model, directory, and tools.
  This opt-in test uses billable provider turns. Its local fake bridge replaces
  authenticated transport; it does not prove Cloud authentication or the mobile UI.

## Headless transfer is separate

This version does not fork, background, or merge Claude sessions. Testing native
`/background` on Claude 2.1.310 produced a different session ID and failed to
preserve an explicit tool restriction. Automatic transfer remains excluded until
the provider can preserve those constraints and support a verified return path.
