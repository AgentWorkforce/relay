import type { WorkflowRunRow, WorkflowStepRow } from './types.js';
import type { WorkflowDb } from './runner.js';

/**
 * In-memory implementation of WorkflowDb for local workflow runs.
 * No persistence — state lives only for the duration of the process.
 */
export class InMemoryWorkflowDb implements WorkflowDb {
  private runs = new Map<string, WorkflowRunRow>();
  private steps = new Map<string, WorkflowStepRow>();

  async insertRun(run: WorkflowRunRow): Promise<void> {
    this.runs.set(run.id, { ...run });
  }

  async updateRun(id: string, patch: Partial<WorkflowRunRow>): Promise<void> {
    const existing = this.runs.get(id);
    if (!existing) return;
    this.runs.set(id, { ...existing, ...patch, updatedAt: new Date().toISOString() });
  }

  async getRun(id: string): Promise<WorkflowRunRow | null> {
    return this.runs.get(id) ?? null;
  }

  async insertStep(step: WorkflowStepRow): Promise<void> {
    this.steps.set(step.id, { ...step });
  }

  async updateStep(id: string, patch: Partial<WorkflowStepRow>): Promise<void> {
    const existing = this.steps.get(id);
    if (!existing) return;
    this.steps.set(id, { ...existing, ...patch, updatedAt: new Date().toISOString() });
  }

  async getStepsByRunId(runId: string): Promise<WorkflowStepRow[]> {
    return Array.from(this.steps.values()).filter((s) => s.runId === runId);
  }
}
