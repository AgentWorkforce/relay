export const PROTOCOL_VERSION = 1 as const;

export type AgentRuntime = "pty" | "headless_claude";

export interface AgentSpec {
  name: string;
  runtime: AgentRuntime;
  cli?: string;
  args?: string[];
  channels?: string[];
}

export interface RelayDelivery {
  delivery_id: string;
  event_id: string;
  from: string;
  target: string;
  body: string;
  thread_id?: string;
  priority?: number;
}

export interface ProtocolEnvelope<TPayload> {
  v: number;
  type: string;
  request_id?: string;
  payload: TPayload;
}

export type SdkToBroker =
  | {
      type: "hello";
      payload: { client_name: string; client_version: string };
    }
  | {
      type: "spawn_agent";
      payload: { agent: AgentSpec };
    }
  | {
      type: "send_message";
      payload: {
        to: string;
        text: string;
        from?: string;
        thread_id?: string;
        priority?: number;
      };
    }
  | {
      type: "release_agent";
      payload: { name: string };
    }
  | {
      type: "list_agents";
      payload: Record<string, never>;
    }
  | {
      type: "shutdown";
      payload: Record<string, never>;
    };

export interface ProtocolError {
  code: string;
  message: string;
  retryable: boolean;
  data?: unknown;
}

export type BrokerEvent =
  | {
      kind: "agent_spawned";
      name: string;
      runtime: AgentRuntime;
      parent?: string;
    }
  | {
      kind: "agent_released";
      name: string;
    }
  | {
      kind: "agent_exited";
      name: string;
      code?: number;
      signal?: string;
    }
  | {
      kind: "relay_inbound";
      event_id: string;
      from: string;
      target: string;
      body: string;
      thread_id?: string;
    }
  | {
      kind: "worker_stream";
      name: string;
      stream: string;
      chunk: string;
    }
  | {
      kind: "delivery_retry";
      name: string;
      delivery_id: string;
      event_id: string;
      attempts: number;
    }
  | {
      kind: "delivery_dropped";
      name: string;
      count: number;
      reason: string;
    }
  | {
      kind: "acl_denied";
      name: string;
      sender: string;
      owner_chain: string[];
    };

export type BrokerToSdk =
  | {
      type: "hello_ack";
      payload: { broker_version: string; protocol_version: number };
    }
  | {
      type: "ok";
      payload: { result: unknown };
    }
  | {
      type: "error";
      payload: ProtocolError;
    }
  | {
      type: "event";
      payload: BrokerEvent;
    };

export type BrokerToWorker =
  | {
      type: "init_worker";
      payload: { agent: AgentSpec };
    }
  | {
      type: "deliver_relay";
      payload: RelayDelivery;
    }
  | {
      type: "shutdown_worker";
      payload: { reason: string; grace_ms?: number };
    }
  | {
      type: "ping";
      payload: { ts_ms: number };
    };

export type WorkerToBroker =
  | {
      type: "worker_ready";
      payload: { name: string; runtime: AgentRuntime };
    }
  | {
      type: "delivery_ack";
      payload: { delivery_id: string; event_id: string };
    }
  | {
      type: "worker_stream";
      payload: { stream: string; chunk: string };
    }
  | {
      type: "worker_error";
      payload: ProtocolError;
    }
  | {
      type: "worker_exited";
      payload: { code?: number; signal?: string };
    }
  | {
      type: "pong";
      payload: { ts_ms: number };
    };
