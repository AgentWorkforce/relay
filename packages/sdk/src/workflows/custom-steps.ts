/**
 * Custom Steps Loader
 *
 * Loads and resolves custom step definitions from .relay/steps.yaml
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { CustomStepsConfig, CustomStepDefinition, CustomStepParam, WorkflowStep } from './types.js';

/** Default location for custom steps configuration. */
export const CUSTOM_STEPS_FILE = '.relay/steps.yaml';

/** Result of validating custom steps usage in a workflow. */
export interface CustomStepsValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** Custom steps that were referenced but not found. */
  missingSteps: string[];
  /** Parameters that were required but not provided. */
  missingParams: Array<{ step: string; use: string; param: string }>;
  /** Unreferenced variables in step definitions. */
  unresolvedVariables: Array<{ step: string; variable: string }>;
}

/**
 * Load custom step definitions from .relay/steps.yaml.
 * Returns an empty map if the file doesn't exist.
 */
export function loadCustomSteps(cwd: string): Map<string, CustomStepDefinition> {
  const stepsPath = path.join(cwd, CUSTOM_STEPS_FILE);
  const steps = new Map<string, CustomStepDefinition>();

  if (!existsSync(stepsPath)) {
    return steps;
  }

  try {
    const content = readFileSync(stepsPath, 'utf-8');

    // Handle empty file
    if (!content.trim()) {
      return steps;
    }

    const config = parseYaml(content) as CustomStepsConfig;

    if (!config || typeof config !== 'object') {
      throw new CustomStepsParseError(
        'Invalid file format',
        'The file must contain a valid YAML object with a "steps" key',
        stepsPath
      );
    }

    if (!config.steps) {
      throw new CustomStepsParseError(
        'Missing "steps" key',
        'Add a "steps" object containing your custom step definitions:\n\n' +
          'steps:\n' +
          '  my-step:\n' +
          '    command: "echo hello"',
        stepsPath
      );
    }

    if (typeof config.steps !== 'object' || Array.isArray(config.steps)) {
      throw new CustomStepsParseError(
        'Invalid "steps" format',
        'The "steps" key must be an object (not an array) mapping step names to definitions',
        stepsPath
      );
    }

    for (const [name, definition] of Object.entries(config.steps)) {
      validateCustomStepDefinition(name, definition, stepsPath);
      steps.set(name, definition);
    }

    return steps;
  } catch (err) {
    if (err instanceof CustomStepsParseError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new CustomStepsParseError('Failed to parse file', message, stepsPath);
  }
}

/**
 * Custom error class for parse errors with helpful context.
 */
export class CustomStepsParseError extends Error {
  constructor(
    public readonly issue: string,
    public readonly suggestion: string,
    public readonly filePath: string
  ) {
    super(`${filePath}: ${issue}\n\n${suggestion}`);
    this.name = 'CustomStepsParseError';
  }
}

/**
 * Custom error class for step resolution errors.
 */
export class CustomStepResolutionError extends Error {
  constructor(
    public readonly stepName: string,
    public readonly issue: string,
    public readonly suggestion: string
  ) {
    super(`Step "${stepName}": ${issue}\n\n${suggestion}`);
    this.name = 'CustomStepResolutionError';
  }
}

/**
 * Validate a custom step definition with clear error messages.
 */
function validateCustomStepDefinition(
  name: string,
  def: unknown,
  filePath: string
): asserts def is CustomStepDefinition {
  if (!def || typeof def !== 'object') {
    throw new CustomStepsParseError(
      `Invalid step "${name}"`,
      'Each step must be an object with at least a "command" or "branch" field:\n\n' +
        `steps:\n` +
        `  ${name}:\n` +
        `    command: "your-command-here"`,
      filePath
    );
  }

  const stepDef = def as Record<string, unknown>;

  // Validate type if specified
  if (stepDef.type !== undefined) {
    if (stepDef.type !== 'deterministic' && stepDef.type !== 'worktree') {
      throw new CustomStepsParseError(
        `Invalid type "${stepDef.type}" for step "${name}"`,
        'Step type must be either "deterministic" or "worktree"',
        filePath
      );
    }
  }

  // Determine step type (default to deterministic if command is provided)
  const hasCommand = typeof stepDef.command === 'string';
  const hasBranch = typeof stepDef.branch === 'string';
  const explicitType = stepDef.type as string | undefined;
  const stepType = explicitType ?? (hasCommand ? 'deterministic' : hasBranch ? 'worktree' : undefined);

  if (!stepType) {
    throw new CustomStepsParseError(
      `Step "${name}" is missing required fields`,
      'Deterministic steps need "command", worktree steps need "branch":\n\n' +
        '# Deterministic step:\n' +
        `  ${name}:\n` +
        '    command: "your-command {{param}}"\n\n' +
        '# Worktree step:\n' +
        `  ${name}:\n` +
        '    type: worktree\n' +
        '    branch: "{{branch-name}}"',
      filePath
    );
  }

  if (stepType === 'deterministic' && !hasCommand) {
    throw new CustomStepsParseError(
      `Deterministic step "${name}" is missing "command"`,
      'Add a command field:\n\n' + `  ${name}:\n` + '    command: "your-shell-command"',
      filePath
    );
  }

  if (stepType === 'worktree' && !hasBranch) {
    throw new CustomStepsParseError(
      `Worktree step "${name}" is missing "branch"`,
      'Add a branch field:\n\n' +
        `  ${name}:\n` +
        '    type: worktree\n' +
        '    branch: "feature/{{branch-name}}"',
      filePath
    );
  }

  // Validate params if present
  if (stepDef.params !== undefined) {
    if (!Array.isArray(stepDef.params)) {
      throw new CustomStepsParseError(
        `Invalid params for step "${name}"`,
        'Params must be an array:\n\n' +
          `  ${name}:\n` +
          '    params:\n' +
          '      - name: myParam\n' +
          '        required: true\n' +
          '      - name: optionalParam\n' +
          '        default: "value"',
        filePath
      );
    }

    for (let i = 0; i < stepDef.params.length; i++) {
      const param = stepDef.params[i] as Record<string, unknown>;
      if (!param || typeof param !== 'object') {
        throw new CustomStepsParseError(
          `Invalid param at index ${i} for step "${name}"`,
          'Each param must be an object with at least a "name" field',
          filePath
        );
      }
      if (!param.name || typeof param.name !== 'string') {
        throw new CustomStepsParseError(
          `Param at index ${i} for step "${name}" is missing "name"`,
          'Add a name to the parameter:\n\n' + '    params:\n' + '      - name: myParam',
          filePath
        );
      }
      if (param.required !== undefined && typeof param.required !== 'boolean') {
        throw new CustomStepsParseError(
          `Invalid "required" value for param "${param.name}" in step "${name}"`,
          'The "required" field must be true or false',
          filePath
        );
      }
    }
  }
}

/**
 * Extract all variable references ({{varName}}) from a string.
 */
function extractVariables(text: string): string[] {
  const matches = text.match(/\{\{(\w+)\}\}/g) ?? [];
  return matches.map((m) => m.slice(2, -2));
}

/**
 * Validate custom step usage in workflow steps without resolving.
 * Returns validation errors and warnings for dry-run.
 */
export function validateCustomStepsUsage(
  steps: WorkflowStep[],
  customSteps: Map<string, CustomStepDefinition>
): CustomStepsValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const missingSteps: string[] = [];
  const missingParams: Array<{ step: string; use: string; param: string }> = [];
  const unresolvedVariables: Array<{ step: string; variable: string }> = [];

  for (const step of steps) {
    if (!step.use) continue;

    const customDef = customSteps.get(step.use);
    if (!customDef) {
      missingSteps.push(step.use);
      errors.push(
        `Step "${step.name}" uses undefined custom step "${step.use}". ` +
          `Add it to .relay/steps.yaml or check for typos.`
      );
      continue;
    }

    // Check required parameters
    const stepAny = step as unknown as Record<string, unknown>;
    const providedParams = new Set<string>();

    if (customDef.params) {
      for (const param of customDef.params) {
        const providedValue = stepAny[param.name];
        if (providedValue !== undefined) {
          providedParams.add(param.name);
        } else if (param.default !== undefined) {
          providedParams.add(param.name);
        } else if (param.required) {
          missingParams.push({ step: step.name, use: step.use, param: param.name });
          errors.push(
            `Step "${step.name}" is missing required parameter "${param.name}" for custom step "${step.use}".`
          );
        }
      }
    }

    // Check for unresolved variables in the resolved command/branch
    const textToCheck = customDef.command ?? customDef.branch ?? '';
    const variables = extractVariables(textToCheck);
    for (const variable of variables) {
      if (!providedParams.has(variable)) {
        // Check if it's a known param with a default
        const paramDef = customDef.params?.find((p) => p.name === variable);
        if (!paramDef) {
          unresolvedVariables.push({ step: step.name, variable });
          warnings.push(
            `Step "${step.name}": Variable "{{${variable}}}" in custom step "${step.use}" ` +
              `is not defined as a parameter. It will not be interpolated.`
          );
        }
      }
    }

    // Check for extra parameters that aren't defined
    const definedParams = new Set((customDef.params ?? []).map((p) => p.name));
    const stepKeys = Object.keys(stepAny).filter(
      (k) => !['name', 'use', 'dependsOn', 'timeoutMs'].includes(k)
    );
    for (const key of stepKeys) {
      if (!definedParams.has(key)) {
        warnings.push(
          `Step "${step.name}": Parameter "${key}" is not defined in custom step "${step.use}" and will be ignored.`
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    missingSteps,
    missingParams,
    unresolvedVariables,
  };
}

/**
 * Resolve a workflow step that uses a custom step definition.
 * Returns a new step with the custom definition merged in.
 */
export function resolveCustomStep(
  step: WorkflowStep,
  customSteps: Map<string, CustomStepDefinition>
): WorkflowStep {
  if (!step.use) {
    return step;
  }

  const customDef = customSteps.get(step.use);
  if (!customDef) {
    throw new CustomStepResolutionError(
      step.name,
      `Custom step "${step.use}" not found`,
      `Make sure "${step.use}" is defined in .relay/steps.yaml:\n\n` +
        'steps:\n' +
        `  ${step.use}:\n` +
        '    command: "your-command"'
    );
  }

  // Build parameter values from step properties and defaults
  const paramValues: Record<string, string> = {};
  const missingRequired: string[] = [];

  if (customDef.params) {
    // Cast step to access arbitrary parameters (custom step params are passed as extra properties)
    const stepAny = step as unknown as Record<string, unknown>;
    for (const param of customDef.params) {
      // Check if value provided in step
      const providedValue = stepAny[param.name];
      if (providedValue !== undefined) {
        paramValues[param.name] = String(providedValue);
      } else if (param.default !== undefined) {
        paramValues[param.name] = param.default;
      } else if (param.required) {
        missingRequired.push(param.name);
      }
    }
  }

  if (missingRequired.length > 0) {
    const paramList = missingRequired.map((p) => `  - ${p}`).join('\n');
    throw new CustomStepResolutionError(
      step.name,
      `Missing required parameter(s) for custom step "${step.use}"`,
      `Add the following to your step:\n\n` +
        `- name: ${step.name}\n` +
        `  use: ${step.use}\n` +
        missingRequired.map((p) => `  ${p}: <value>`).join('\n')
    );
  }

  // Determine step type
  const stepType = customDef.type ?? (customDef.command ? 'deterministic' : 'worktree');

  // Interpolate parameter values into the definition
  const interpolate = (value: string | undefined): string | undefined => {
    if (!value) return value;
    return value.replace(/\{\{(\w+)\}\}/g, (match, paramName) => {
      return paramValues[paramName] ?? match;
    });
  };

  // Build resolved step
  const resolvedStep: WorkflowStep = {
    name: step.name,
    type: stepType as 'deterministic' | 'worktree',
    dependsOn: step.dependsOn,
    timeoutMs: step.timeoutMs ?? customDef.timeoutMs,
  };

  if (stepType === 'deterministic') {
    resolvedStep.command = interpolate(customDef.command);
    resolvedStep.failOnError = customDef.failOnError;
    resolvedStep.captureOutput = customDef.captureOutput;
  } else if (stepType === 'worktree') {
    resolvedStep.branch = interpolate(customDef.branch);
    resolvedStep.baseBranch = interpolate(customDef.baseBranch);
    resolvedStep.path = interpolate(customDef.path);
    resolvedStep.createBranch = customDef.createBranch;
  }

  return resolvedStep;
}

/**
 * Resolve all custom steps in a workflow's steps array.
 */
export function resolveAllCustomSteps(
  steps: WorkflowStep[],
  customSteps: Map<string, CustomStepDefinition>
): WorkflowStep[] {
  return steps.map((step) => resolveCustomStep(step, customSteps));
}

/**
 * Check if .relay/steps.yaml exists.
 */
export function customStepsFileExists(cwd: string): boolean {
  return existsSync(path.join(cwd, CUSTOM_STEPS_FILE));
}

/**
 * Get the full path to the custom steps file.
 */
export function getCustomStepsPath(cwd: string): string {
  return path.join(cwd, CUSTOM_STEPS_FILE);
}
