export interface CloudCredential {
  provider: string;
  accessToken: string;
}

export interface CloudAgent {
  name: string;
  status: string;
  brokerId: string;
  brokerName: string;
  machineId: string;
}

export interface CloudApiClient {
  verifyApiKey(input: { cloudUrl: string; apiKey: string }): Promise<void>;
  checkConnection(input: { cloudUrl: string; apiKey: string }): Promise<boolean>;
  syncCredentials(input: { cloudUrl: string; apiKey: string }): Promise<CloudCredential[]>;
  listAgents(input: { cloudUrl: string; apiKey: string }): Promise<CloudAgent[]>;
  sendMessage(input: {
    cloudUrl: string;
    apiKey: string;
    targetBrokerId: string;
    targetAgent: string;
    from: string;
    content: string;
  }): Promise<void>;
}

interface CloudListAgentsResponse {
  allAgents?: Array<Partial<CloudAgent>>;
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const body = await response.text();
    return body || response.statusText;
  } catch {
    return response.statusText;
  }
}

const BROKER_HARD_CUT_WARNING =
  'BREAKING CHANGE: daemon compatibility was removed. Update your cloud API to /api/brokers/* and brokerId/brokerName fields.';

async function fetchBrokerEndpoint(cloudUrl: string, endpoint: string, init: RequestInit): Promise<Response> {
  const response = await fetch(`${cloudUrl}${endpoint}`, init);
  if (response.status === 404) {
    throw new Error(`${BROKER_HARD_CUT_WARNING} Missing endpoint: ${endpoint}`);
  }
  return response;
}

function normalizeCloudAgent(raw: Partial<CloudAgent>, index: number): CloudAgent {
  const brokerId = typeof raw.brokerId === 'string' ? raw.brokerId.trim() : '';
  const brokerName = typeof raw.brokerName === 'string' ? raw.brokerName.trim() : '';
  if (!brokerId || !brokerName) {
    throw new Error(
      `${BROKER_HARD_CUT_WARNING} Invalid /api/brokers/agents payload at index ${index}: missing brokerId/brokerName.`
    );
  }
  return {
    name: typeof raw.name === 'string' ? raw.name : '',
    status: typeof raw.status === 'string' ? raw.status : 'offline',
    machineId: typeof raw.machineId === 'string' ? raw.machineId : '',
    brokerId,
    brokerName,
  };
}

class FetchCloudApiClient implements CloudApiClient {
  async verifyApiKey(input: { cloudUrl: string; apiKey: string }): Promise<void> {
    const response = await fetchBrokerEndpoint(input.cloudUrl, '/api/brokers/heartbeat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agents: [],
        metrics: { linkedAt: new Date().toISOString() },
      }),
    });

    if (!response.ok) {
      const error = await readErrorBody(response);
      throw new Error(error);
    }
  }

  async checkConnection(input: { cloudUrl: string; apiKey: string }): Promise<boolean> {
    const response = await fetchBrokerEndpoint(input.cloudUrl, '/api/brokers/heartbeat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ agents: [], metrics: {} }),
    });

    return response.ok;
  }

  async syncCredentials(input: { cloudUrl: string; apiKey: string }): Promise<CloudCredential[]> {
    const response = await fetchBrokerEndpoint(input.cloudUrl, '/api/brokers/credentials', {
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
      },
    });

    if (!response.ok) {
      const error = await readErrorBody(response);
      throw new Error(error);
    }

    const data = (await response.json()) as { credentials?: CloudCredential[] };
    return Array.isArray(data.credentials) ? data.credentials : [];
  }

  async listAgents(input: { cloudUrl: string; apiKey: string }): Promise<CloudAgent[]> {
    const response = await fetchBrokerEndpoint(input.cloudUrl, '/api/brokers/agents', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ agents: [] }),
    });

    if (!response.ok) {
      const error = await readErrorBody(response);
      throw new Error(error);
    }

    const data = (await response.json()) as CloudListAgentsResponse;
    if (!Array.isArray(data.allAgents)) {
      return [];
    }
    return data.allAgents
      .map((raw, index) => normalizeCloudAgent(raw, index))
      .filter((agent) => agent.name.length > 0);
  }

  async sendMessage(input: {
    cloudUrl: string;
    apiKey: string;
    targetBrokerId: string;
    targetAgent: string;
    from: string;
    content: string;
  }): Promise<void> {
    const response = await fetchBrokerEndpoint(input.cloudUrl, '/api/brokers/message', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        targetBrokerId: input.targetBrokerId,
        targetAgent: input.targetAgent,
        message: {
          from: input.from,
          content: input.content,
        },
      }),
    });

    if (!response.ok) {
      const error = await readErrorBody(response);
      throw new Error(error);
    }
  }
}

export function createCloudApiClient(): CloudApiClient {
  return new FetchCloudApiClient();
}
