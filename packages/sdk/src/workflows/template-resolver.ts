import type { RelayYamlConfig } from './types.js';

/**
 * Escape a string for safe inclusion in a shell command passed to `sh -c`.
 * Wraps the value in single quotes and escapes any embedded single quotes.
 */
export function shellEscape(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

const TEMPLATE_VARIABLE_PATTERN = /\{\{([\w][\w.\-]*)\}\}/g;
const STEP_OUTPUT_TEMPLATE_PATTERN = /\{\{(steps\.[\w\-]+\.output)\}\}/g;
const STEP_OUTPUT_REF_PATTERN = /^steps\.([\w\-]+)\.output$/;

/**
 * Variable context for template resolution.
 * Values are typed as `unknown` to accommodate dynamic step-output contexts;
 * only scalar values (string | number | boolean) are interpolated — complex
 * objects are coerced via String(). Shell-bound templates are escaped by
 * {@link resolveTemplateForShell}.
 */
export interface VariableContext {
  [key: string]: unknown;
}

export function resolveVariables(config: RelayYamlConfig, vars: VariableContext): RelayYamlConfig {
  const resolved = structuredClone(config);

  for (const agent of resolved.agents) {
    if (agent.task) {
      agent.task = resolveTemplate(agent.task, vars);
    }
  }

  if (resolved.workflows) {
    for (const workflow of resolved.workflows) {
      for (const step of workflow.steps) {
        if (step.task) {
          step.task = resolveTemplate(step.task, vars);
        }
        if (step.command) {
          step.command = resolveTemplateForShell(step.command, vars);
        }
        if (step.params && typeof step.params === 'object') {
          for (const key of Object.keys(step.params)) {
            const value = (step.params as Record<string, unknown>)[key];
            if (typeof value === 'string') {
              (step.params as Record<string, string>)[key] = resolveTemplate(value, vars);
            }
          }
        }
      }
    }
  }

  return resolved;
}

export function resolveTemplate(template: string, context: VariableContext): string {
  return template.replace(TEMPLATE_VARIABLE_PATTERN, (match, key: string) => {
    if (key.startsWith('steps.')) {
      return match;
    }

    const value = resolveDotPath(key, context);
    if (value === undefined) {
      throw new Error(`Unresolved variable: {{${key}}}`);
    }
    return String(value);
  });
}

/**
 * Like resolveTemplate but shell-escapes interpolated values.
 * Use this when the result will be passed to `sh -c` to prevent injection.
 */
export function resolveTemplateForShell(template: string, context: VariableContext): string {
  return template.replace(TEMPLATE_VARIABLE_PATTERN, (match, key: string) => {
    if (key.startsWith('steps.')) {
      return match;
    }

    const value = resolveDotPath(key, context);
    if (value === undefined) {
      throw new Error(`Unresolved variable: {{${key}}}`);
    }
    return shellEscape(String(value));
  });
}

export function resolveDotPath(key: string, context: VariableContext): string | number | boolean | undefined {
  if (!key.includes('.')) {
    return toTemplateScalar(context[key]);
  }

  const parts = key.split('.');
  let current: unknown = context;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return toTemplateScalar(current);
}

export function resolveStepOutputRef(ref: string, stepOutputs: Map<string, string>): string {
  const normalizedRef = ref.startsWith('{{') && ref.endsWith('}}') ? ref.slice(2, -2).trim() : ref;
  const match = STEP_OUTPUT_REF_PATTERN.exec(normalizedRef);
  if (!match) {
    throw new Error(`Invalid step output reference: ${ref}`);
  }

  const stepOutput = stepOutputs.get(match[1]);
  if (stepOutput === undefined) {
    throw new Error(`Unresolved step output reference: ${ref}`);
  }

  return stepOutput;
}

export function interpolateStepTask(template: string, context: VariableContext): string {
  const stepOutputs = buildStepOutputMap(context);
  return template.replace(STEP_OUTPUT_TEMPLATE_PATTERN, (match, ref: string) => {
    try {
      return resolveStepOutputRef(ref, stepOutputs);
    } catch {
      return match;
    }
  });
}

function buildStepOutputMap(context: VariableContext): Map<string, string> {
  const stepOutputs = new Map<string, string>();
  const steps = context.steps;

  if (!steps || typeof steps !== 'object') {
    return stepOutputs;
  }

  for (const [stepName, stepState] of Object.entries(steps as Record<string, unknown>)) {
    if (!stepState || typeof stepState !== 'object') {
      continue;
    }

    const output = toTemplateScalar((stepState as Record<string, unknown>).output);
    if (output !== undefined) {
      stepOutputs.set(stepName, String(output));
    }
  }

  return stepOutputs;
}

function toTemplateScalar(value: unknown): string | number | boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return String(value);
}

export class TemplateResolver {
  resolveVariables(config: RelayYamlConfig, vars: VariableContext): RelayYamlConfig {
    return resolveVariables(config, vars);
  }

  interpolate(template: string, vars: VariableContext): string {
    return resolveTemplate(template, vars);
  }

  resolveDotPath(key: string, vars: VariableContext): string | number | boolean | undefined {
    return resolveDotPath(key, vars);
  }

  interpolateStepTask(template: string, context: VariableContext): string {
    return interpolateStepTask(template, context);
  }
}
