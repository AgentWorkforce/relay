export class RelayCapabilityError extends Error {
  readonly capability: string;

  constructor(capability: string, message?: string) {
    super(message ?? `Agent Relay capability is not available: ${capability}`);
    this.name = 'RelayCapabilityError';
    this.capability = capability;
  }
}

export type Unsubscribe = () => void;
