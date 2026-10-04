# PTY delivery acceptance

Relay keeps custody of a PTY delivery until the harness accepts a turn. Seeing
the formatted message in terminal output is only editor echo: it does not prove
that the composer submitted it.

## Submit strategies

| Harness                                          | Initial body                   | Submit gesture             | Bounded recovery                                                             |
| ------------------------------------------------ | ------------------------------ | -------------------------- | ---------------------------------------------------------------------------- |
| Codex                                            | bulk editor input              | distinct `CR` after 250 ms | `End`, then distinct `CR`; `LF` only if the same body remains visibly parked |
| Claude and Muse                                  | paced or configured body input | distinct `CR` after 250 ms | distinct `CR`, then guarded `LF`                                             |
| Devin                                            | bracketed paste                | distinct `CR` after 250 ms | distinct `CR`, then guarded `LF`                                             |
| OpenCode, Gemini, Cursor and other PTY harnesses | paced typed input              | trailing `CR`              | distinct `CR`, then guarded `LF`                                             |

A recovery never writes the message body again. Relay retries a submit key only
when the expected message tail is still present in the live composer at the
cursor. It stops immediately when an activity marker appears or an echoed body
has left a proven idle composer. An inconclusive screen is reported as failure
instead of receiving a blind keypress.

Human drive sessions and queued human PTY writes take priority. An interactive
hold pauses recovery without consuming its retry budget. Actual human input
transfers composer ownership to the operator, cancels automatic recovery, and
reports the broker delivery as failed rather than submitting mixed input.

## Codex mechanism

Reproduced with authenticated Codex CLI 0.160.0 in a real PTY: a message body
and `CR` delivered in the same terminal write remained in Codex's multiline
composer. Terminal output contained the complete body, which made the previous
echo verifier acknowledge a turn that had never started. Moving the cursor to
the end and sending `CR` as a later write advanced the harness and produced the
expected response. The final `LF` exists for the older observed field state and
is sent only after the body is still proven to be parked.

## Events and status

PTY workers emit `delivery_unconfirmed` before recovery,
`delivery_resubmitted` after a submit-only retry is queued,
`delivery_verified` with `verification: harness_acceptance` after acceptance,
and `delivery_failed` after a write error, inconclusive screen, or exhausted
budget. Unconfirmed and retry events put the worker in `blocked_on_send`; agent
and fleet listings already expose that state and retain the pending message
count until a real `delivery_ack`.

## Rollout

The change is planned for broker 13.2.0. Upgrade and restart brokers and their
PTY agents. Existing processes keep the old verification and recovery behavior
until restarted. Native Codex app-server/IPC delivery is a separate transport
and is not affected by this PTY-specific bug.
