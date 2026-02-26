export interface HealthIssue {
  severity: string;
  message: string;
}

export interface HealthCrash {
  id: string;
  agentName: string;
  crashedAt: string;
  likelyCause: string;
  summary: string;
}

export interface HealthAlert {
  id: string;
  agentName: string;
  alertType: string;
  message: string;
  createdAt: string;
}

export interface HealthPayload {
  healthScore: number;
  summary: string;
  issues: HealthIssue[];
  recommendations: string[];
  crashes: HealthCrash[];
  alerts: HealthAlert[];
  stats: {
    totalCrashes24h: number;
    totalAlerts24h: number;
    agentCount: number;
  };
}
