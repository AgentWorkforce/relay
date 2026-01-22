// Temporary shim until daemon consensus is extracted into a package
export interface Vote {
  agent: string;
  vote: string;
  comment?: string;
  timestamp?: number;
}

export interface Proposal {
  id: string;
  title: string;
  description?: string;
  status: string;
  proposer?: string;
  participants: string[];
  votes: Vote[];
  createdAt: number;
  updatedAt?: number;
}

export interface ConsensusState {
  proposals: Proposal[];
  stats?: Record<string, unknown>;
}

// Stubbed implementation for build-time; real implementation lives in daemon (Phase 6)
export async function getConsensus(_workspaceId?: string): Promise<ConsensusState> {
  return { proposals: [] };
}
