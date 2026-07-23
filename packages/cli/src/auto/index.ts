/**
 * Auto-routing: dynamically determine model-tier and team composition for a task.
 *
 * Usage:
 *   const assessment = classifyTask(taskDescription);
 *   const team = composeTeam(assessment, taskDescription);
 *   const directorPrompt = buildDirectorPrompt(taskDescription, team);
 *   // spawn lead with model=team.lead.model and task=directorPrompt
 */
export { classifyTask } from './classifier.js';
export type { TaskAssessment } from './classifier.js';

export { composeTeam } from './composer.js';
export type { TeamSpec, WorkerSpec, ModelTier, OnboardingVariant } from './composer.js';

export { buildDirectorPrompt } from './director-prompt.js';
