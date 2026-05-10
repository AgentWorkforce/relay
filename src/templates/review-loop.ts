import { LoopStep, Step, StepContext } from '@agentworkforce/relay';

export interface ReviewStepOutput {
  passed: boolean;
  feedback?: string;
}

export interface AddressFeedbackInput {
  code: string;
  feedback: string;
}

export interface AddressFeedbackOutput {
  code: string;
}

export interface ReviewLoopConfig {
  maxIterations?: number;
}

export function createReviewLoop(
  reviewStep: Step<unknown, ReviewStepOutput>,
  addressFeedbackStep: Step<AddressFeedbackInput, AddressFeedbackOutput>,
  config: ReviewLoopConfig = {}
): Step<{ code: string }, { finalCode: string; iterations: number }> {
  const maxIterations = config.maxIterations ?? 5;

  return new LoopStep<{ code: string }, { finalCode: string; iterations: number }>({
    steps: [reviewStep, addressFeedbackStep],
    while: (ctx: StepContext) => {
      const reviewOut = ctx.getStepOutput(reviewStep) as ReviewStepOutput;
      return !reviewOut.passed;
    },
    maxLoops: maxIterations,
    finalize: (ctx: StepContext) => {
      const addressOut = ctx.getStepOutput(addressFeedbackStep) as AddressFeedbackOutput | undefined;
      const finalCode = addressOut?.code ?? ctx.input.code;
      return { finalCode, iterations: ctx.iterationCount };
    },
  });
}
