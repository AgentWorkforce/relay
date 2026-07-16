import type { AgentObservabilityCapabilities } from '@agent-relay/sdk';

function summarizeSupport(value: unknown): string[] {
  const support = value as { available: boolean; fidelities?: readonly string[] } | undefined;
  return support?.available ? [...(support.fidelities ?? [])] : ['unavailable'];
}

export function summarizeProfile(profile: AgentObservabilityCapabilities) {
  return {
    activities: Object.fromEntries(
      Object.entries(profile.activities).map(([key, value]) => [key, summarizeSupport(value)])
    ),
    semanticFamilies: Object.fromEntries(
      Object.entries(profile.events).map(([key, value]) => [key, summarizeSupport(value)])
    ),
  };
}

export function compareProfiles(
  reference: AgentObservabilityCapabilities,
  candidate: AgentObservabilityCapabilities
) {
  const compare = (referenceValues: Record<string, unknown>, candidateValues: Record<string, unknown>) =>
    Object.fromEntries(
      Object.keys(referenceValues).map((key) => [
        key,
        {
          reference: summarizeSupport(referenceValues[key]),
          candidate: summarizeSupport(candidateValues[key]),
        },
      ])
    );
  return {
    activities: compare(reference.activities, candidate.activities),
    semanticFamilies: compare(reference.events, candidate.events),
  };
}
