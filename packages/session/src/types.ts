/** AI harnesses that can originate a portable Relay session. */
export type SessionCli = 'claude' | 'codex' | 'opencode' | 'grok' | 'cursor';

/** Canonical Relay identity used for ownership and steering attribution. */
export interface SessionActor {
  userId: string;
  email: string;
  displayName: string;
}

/**
 * One immutable entry in a session's control-transfer audit trail.
 *
 * `action` covers only states the SDK actually produces today. There is no
 * release-of-control flow yet: `recordSteering` always logs `took_control`,
 * and `activeActor` has no "released" representation for a consumer to key
 * off. Add `released_control` back (with a matching `activeActor: null` path
 * through `recordSteering`) if that flow is implemented.
 */
export interface SteeringEvent {
  actorId: string;
  action: 'session_started' | 'took_control';
  relayMessageId: string;
  timestamp: string;
  nodeId: string;
}

/** Stable, cross-harness session identity persisted by Relayhistory. */
export interface RelaySession {
  sessionId: string;
  owner: SessionActor;
  activeActor: SessionActor | null;
  steeringLog: SteeringEvent[];
  originCli: SessionCli;
  originNode: string;
  nativeResumeId?: string;
  createdAt: string;
}

export type TurnRole = 'user' | 'assistant' | 'system';
export type TurnActorRole = 'owner' | 'steerer';

/** One ordered turn in the portable Relayhistory journal. */
export interface Turn {
  turnIndex: number;
  role: TurnRole;
  content: string;
  actor: SessionActor;
  actorRole: TurnActorRole;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export type ResumeMode =
  | { mode: 'native'; nativeResumeId: string }
  | { mode: 'inject'; contextPrompt: string };

export interface ResumeSessionResult {
  session: RelaySession;
  turns: Turn[];
  /** Harness-specific continuation plan derived from the fetched session. */
  resume: ResumeMode;
}
