import { Step } from '../../types';
import { updateRunAskQuestionExchanges } from '../persistence/runs';

export async function handleSlackAskQuestion(
  step: Step,
  runId: string,
  timeoutMs: number
): Promise<void> {
  try {
    const result = await step.waitForReply(timeoutMs);
    const exchange = {
      question: step.input.question,
      timestamp: new Date(),
      reply: result.reply,
      timeout: result.timeout === true
    };
    await updateRunAskQuestionExchanges(runId, exchange);
  } catch (error) {
    throw error;
  }
}
