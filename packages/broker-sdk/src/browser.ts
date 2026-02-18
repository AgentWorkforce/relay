/**
 * Browser-compatible entry point for the broker SDK.
 *
 * Exports only modules with zero Node.js dependencies.
 * The ConsensusEngine class (needs node:crypto + node:events) is NOT
 * exported here — only its types and pure helper functions.
 *
 * @example
 * ```ts
 * import { PROTOCOL_VERSION, type BrokerEvent } from "agent-relay/broker/browser";
 * ```
 */

// Protocol types — pure TypeScript, zero deps
export {
  PROTOCOL_VERSION,
  type AgentRuntime,
  type AgentSpec,
  type BrokerEvent,
  type BrokerStatus,
  type BrokerToSdk,
  type BrokerToWorker,
  type PendingDeliveryInfo,
  type ProtocolEnvelope,
  type ProtocolError,
  type RelayDelivery,
  type SdkToBroker,
  type WorkerToBroker,
} from "./protocol.js";

// Consensus types + pure functions (from the Node-free helpers file)
export {
  formatProposalMessage,
  formatResultMessage,
  parseVoteCommand,
  parseProposalCommand,
  isConsensusCommand,
  type ConsensusType,
  type VoteValue,
  type ProposalStatus,
  type AgentWeight,
  type Vote,
  type Proposal,
  type ConsensusResult,
  type ConsensusConfig,
  type ConsensusEvents,
  type ParsedProposalCommand,
} from "./consensus-helpers.js";

// Shadow manager — pure in-memory, no I/O deps
export {
  ShadowManager,
  type ShadowConfig,
  type ShadowRelationship,
  type ShadowCopy,
  type SpeakOnTrigger,
} from "./shadow.js";
