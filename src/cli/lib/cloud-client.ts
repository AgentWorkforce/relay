export interface CloudCredential {
  provider: string;
  accessToken: string;
}

export interface CloudAgent {
  name: string;
  status: string;
  daemonId: string;
  daemonName: string;
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
    targetDaemonId: string;
    targetAgent: string;
    from: string;
    content: string;
  }): Promise<void>;
}

interface CloudListAgentsResponse {
  allAgents: CloudAgent[];
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const body = await response.text();
    return body || response.statusText;
  } catch {
    return response.statusText;
  }
}

class FetchCloudApiClient implements CloudApiClient {
  async verifyApiKey(input: { cloudUrl: string; apiKey: string }): Promise<void> {
    const response = await fetch(`${input.cloudUrl}/api/daemons/heartbeat`, {
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
    const response = await fetch(`${input.cloudUrl}/api/daemons/heartbeat`, {
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
    const response = await fetch(`${input.cloudUrl}/api/daemons/credentials`, {
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
    const response = await fetch(`${input.cloudUrl}/api/daemons/agents`, {
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
    return data.allAgents || [];
  }

  async sendMessage(input: {
    cloudUrl: string;
    apiKey: string;
    targetDaemonId: string;
    targetAgent: string;
    from: string;
    content: string;
  }): Promise<void> {
    const response = await fetch(`${input.cloudUrl}/api/daemons/message`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        targetDaemonId: input.targetDaemonId,
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
