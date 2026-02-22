import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { RelayYamlConfig } from './types.js';

const YAML_EXTENSIONS = ['.yaml', '.yml'] as const;

export const BUILT_IN_TEMPLATE_NAMES = [
  'feature-dev',
  'bug-fix',
  'code-review',
  'security-audit',
  'refactor',
  'documentation',
  'review-loop',
] as const;

export type BuiltInTemplateName = (typeof BUILT_IN_TEMPLATE_NAMES)[number];

export interface TemplateRegistryOptions {
  builtInTemplatesDir?: string;
  customTemplatesDir?: string;
  workspaceDir?: string;
  fetcher?: typeof fetch;
}

export interface LoadTemplateOptions {
  overrides?: Record<string, unknown>;
}

export interface TemplateShorthandConfig {
  swarm: string;
  overrides?: Record<string, unknown>;
}

export type TemplateReferenceInput =
  | string
  | RelayYamlConfig
  | (Partial<Omit<RelayYamlConfig, 'swarm'>> & TemplateShorthandConfig);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasYamlExtension(fileName: string): boolean {
  return YAML_EXTENSIONS.some((ext) => fileName.endsWith(ext));
}

export class TemplateRegistry {
  private readonly builtInTemplatesDir: string;
  private readonly customTemplatesDir: string;
  private readonly fetcher: typeof fetch;

  constructor(options: TemplateRegistryOptions = {}) {
    this.builtInTemplatesDir = this.resolveBuiltInTemplatesDir(options.builtInTemplatesDir);
    this.customTemplatesDir = options.customTemplatesDir
      ? path.resolve(options.customTemplatesDir)
      : path.resolve(options.workspaceDir ?? process.cwd(), '.relay/workflows');

    this.fetcher = options.fetcher ?? fetch;
  }

  listBuiltInTemplates(): string[] {
    return [...BUILT_IN_TEMPLATE_NAMES];
  }

  async listCustomTemplates(): Promise<string[]> {
    const files = await this.safeReadDir(this.customTemplatesDir);
    return files
      .filter((fileName) => hasYamlExtension(fileName))
      .map((fileName) => this.normalizeTemplateName(fileName))
      .sort();
  }

  async listTemplates(): Promise<string[]> {
    const custom = await this.listCustomTemplates();
    const merged = new Set<string>([...BUILT_IN_TEMPLATE_NAMES, ...custom]);
    return Array.from(merged).sort();
  }

  async hasTemplate(name: string): Promise<boolean> {
    try {
      await this.resolveTemplatePath(name);
      return true;
    } catch {
      return false;
    }
  }

  async loadTemplate(
    name: string,
    options: LoadTemplateOptions = {}
  ): Promise<RelayYamlConfig> {
    const templatePath = await this.resolveTemplatePath(name);
    const template = await this.readTemplateFile(templatePath);

    if (options.overrides && Object.keys(options.overrides).length > 0) {
      return this.applyOverrides(template, options.overrides);
    }

    return template;
  }

  async resolveTemplateReference(
    input: TemplateReferenceInput,
    options: LoadTemplateOptions = {}
  ): Promise<RelayYamlConfig> {
    if (typeof input === 'string') {
      return this.loadTemplate(input, options);
    }

    if (this.isTemplateShorthand(input)) {
      const { swarm, overrides = {}, ...rest } = input;
      const mergedOverrides = {
        ...overrides,
        ...(options.overrides ?? {}),
      };
      const baseTemplate = await this.loadTemplate(swarm, {
        overrides: mergedOverrides,
      });
      return this.mergeRelayConfig(baseTemplate, rest);
    }

    const config = this.cloneValue(input as RelayYamlConfig);

    if (options.overrides && Object.keys(options.overrides).length > 0) {
      return this.applyOverrides(config, options.overrides);
    }

    return config;
  }

  applyOverrides(
    config: RelayYamlConfig,
    overrides: Record<string, unknown>
  ): RelayYamlConfig {
    const nextConfig = this.cloneValue(config);

    for (const [overridePath, value] of Object.entries(overrides)) {
      this.setOverride(nextConfig, overridePath, value);
    }

    return nextConfig;
  }

  async installExternalTemplate(url: string, name?: string): Promise<string> {
    const response = await this.fetcher(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch template from ${url}: ${response.status} ${response.statusText}`);
    }

    const raw = await response.text();
    const parsed = parseYaml(raw);

    if (!isRecord(parsed)) {
      throw new Error(`Template from ${url} is not a YAML object`);
    }

    const inferredName = typeof parsed.name === 'string' ? parsed.name : '';
    const templateName = this.normalizeTemplateName(name ?? inferredName);

    if (!templateName) {
      throw new Error(
        'Template name is required. Provide name explicitly or include a string "name" field.'
      );
    }

    if (templateName.includes('/') || templateName.includes('\\') || templateName.includes('..') || path.isAbsolute(templateName)) {
      throw new Error(`Invalid template name: "${templateName}" contains path separators or traversal sequences`);
    }

    this.validateRelayConfig(parsed, url);

    await fs.mkdir(this.customTemplatesDir, { recursive: true });
    const targetPath = path.join(this.customTemplatesDir, `${templateName}.yaml`);
    await fs.writeFile(targetPath, stringifyYaml(parsed), 'utf-8');
    return targetPath;
  }

  private isTemplateShorthand(
    input: TemplateReferenceInput
  ): input is Partial<Omit<RelayYamlConfig, 'swarm'>> & TemplateShorthandConfig {
    return isRecord(input) && typeof input.swarm === 'string';
  }

  private mergeRelayConfig(
    base: RelayYamlConfig,
    patch: Partial<Omit<RelayYamlConfig, 'swarm'>>
  ): RelayYamlConfig {
    const merged = this.cloneValue(base);

    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        continue;
      }
      (merged as unknown as Record<string, unknown>)[key] = this.cloneValue(value);
    }

    return merged;
  }

  private normalizeTemplateName(name: string): string {
    return name.replace(/\.ya?ml$/i, '').trim();
  }

  private resolveBuiltInTemplatesDir(explicitDir?: string): string {
    if (explicitDir) {
      return path.resolve(explicitDir);
    }

    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(currentDir, 'builtin-templates'),
      path.resolve(currentDir, '../workflows/builtin-templates'),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return candidates[0];
  }

  private async resolveTemplatePath(name: string): Promise<string> {
    const normalizedName = this.normalizeTemplateName(name);

    const customPath = await this.findTemplatePath(this.customTemplatesDir, normalizedName);
    if (customPath) {
      return customPath;
    }

    const builtInPath = await this.findTemplatePath(this.builtInTemplatesDir, normalizedName);
    if (builtInPath) {
      return builtInPath;
    }

    throw new Error(`Template not found: ${name}`);
  }

  private async findTemplatePath(
    directory: string,
    templateName: string
  ): Promise<string | undefined> {
    for (const ext of YAML_EXTENSIONS) {
      const candidate = path.join(directory, `${templateName}${ext}`);
      try {
        const stat = await fs.stat(candidate);
        if (stat.isFile()) {
          return candidate;
        }
      } catch {
        // Continue checking other extensions.
      }
    }

    return undefined;
  }

  private async readTemplateFile(templatePath: string): Promise<RelayYamlConfig> {
    const raw = await fs.readFile(templatePath, 'utf-8');
    const parsed = parseYaml(raw);

    if (!isRecord(parsed)) {
      throw new Error(`Template at ${templatePath} is not a YAML object`);
    }

    const normalized = this.normalizeLegacyTemplate(parsed);
    this.validateRelayConfig(normalized, templatePath);
    return normalized;
  }

  private normalizeLegacyTemplate(rawTemplate: Record<string, unknown>): Record<string, unknown> {
    const normalized = this.cloneValue(rawTemplate);

    if (!isRecord(normalized.swarm) && typeof normalized.pattern === 'string') {
      normalized.swarm = { pattern: normalized.pattern };
      delete normalized.pattern;
    }

    if (Array.isArray(normalized.agents)) {
      normalized.agents = normalized.agents.map((agent) => {
        if (!isRecord(agent)) {
          return agent;
        }

        if (typeof agent.name !== 'string' && typeof agent.id === 'string') {
          return { ...agent, name: agent.id };
        }

        return agent;
      });
    }

    if (!Array.isArray(normalized.workflows) && isRecord(normalized.workflow)) {
      const workflowName = typeof normalized.name === 'string'
        ? `${normalized.name}-workflow`
        : 'default-workflow';

      const workflow = normalized.workflow;
      const steps = Array.isArray(workflow.steps)
        ? workflow.steps.map((step) => this.normalizeLegacyStep(step)).filter((step) => step !== null)
        : [];

      normalized.workflows = [
        {
          name: workflowName,
          description: typeof workflow.description === 'string' ? workflow.description : undefined,
          onError: typeof workflow.onError === 'string' ? workflow.onError : undefined,
          steps,
        },
      ];

      delete normalized.workflow;
    }

    return normalized;
  }

  private normalizeLegacyStep(step: unknown): Record<string, unknown> | null {
    if (!isRecord(step)) {
      return null;
    }

    const name = typeof step.name === 'string'
      ? step.name
      : typeof step.id === 'string'
        ? step.id
        : undefined;

    const task = typeof step.task === 'string'
      ? step.task
      : typeof step.prompt === 'string'
        ? step.prompt
        : undefined;

    if (!name || typeof step.agent !== 'string' || !task) {
      return null;
    }

    const normalized: Record<string, unknown> = {
      name,
      agent: step.agent,
      task,
    };

    if (Array.isArray(step.dependsOn)) {
      normalized.dependsOn = step.dependsOn;
    }

    if (typeof step.timeoutMs === 'number') {
      normalized.timeoutMs = step.timeoutMs;
    }

    if (typeof step.retries === 'number') {
      normalized.retries = step.retries;
    } else if (typeof step.maxRetries === 'number') {
      normalized.retries = step.maxRetries;
    }

    if (isRecord(step.verification)) {
      normalized.verification = step.verification;
    } else if (typeof step.expects === 'string') {
      normalized.verification = {
        type: 'output_contains',
        value: step.expects,
      };
    }

    return normalized;
  }

  private validateRelayConfig(rawConfig: unknown, source: string): asserts rawConfig is RelayYamlConfig {
    if (!isRecord(rawConfig)) {
      throw new Error(`Template at ${source} is not an object`);
    }

    if (typeof rawConfig.version !== 'string') {
      throw new Error(`Template at ${source} is missing required string field: version`);
    }

    if (typeof rawConfig.name !== 'string') {
      throw new Error(`Template at ${source} is missing required string field: name`);
    }

    if (!isRecord(rawConfig.swarm) || typeof rawConfig.swarm.pattern !== 'string') {
      throw new Error(`Template at ${source} is missing required field: swarm.pattern`);
    }

    if (!Array.isArray(rawConfig.agents) || rawConfig.agents.length === 0) {
      throw new Error(`Template at ${source} must include a non-empty agents array`);
    }

    for (const agent of rawConfig.agents) {
      if (!isRecord(agent) || typeof agent.name !== 'string' || typeof agent.cli !== 'string') {
        throw new Error(`Template at ${source} contains an invalid agent definition`);
      }
    }

    if (rawConfig.workflows !== undefined) {
      if (!Array.isArray(rawConfig.workflows)) {
        throw new Error(`Template at ${source} has invalid workflows; expected an array`);
      }

      for (const workflow of rawConfig.workflows) {
        if (!isRecord(workflow) || typeof workflow.name !== 'string' || !Array.isArray(workflow.steps)) {
          throw new Error(`Template at ${source} contains an invalid workflow definition`);
        }

        for (const step of workflow.steps) {
          if (!isRecord(step) || typeof step.name !== 'string') {
            throw new Error(`Template at ${source} contains an invalid workflow step`);
          }

          // Deterministic steps require type and command
          if (step.type === 'deterministic') {
            if (typeof step.command !== 'string') {
              throw new Error(`Template at ${source} has deterministic step "${step.name}" without a command`);
            }
          } else {
            // Agent steps (type is undefined or 'agent') require agent and task
            if (typeof step.agent !== 'string' || typeof step.task !== 'string') {
              throw new Error(`Template at ${source} has agent step "${step.name}" without agent or task`);
            }
          }
        }
      }
    }
  }

  private setOverride(
    config: RelayYamlConfig,
    overridePath: string,
    value: unknown
  ): void {
    const pathParts = overridePath
      .replace(/\[(\d+)\]/g, '.$1')
      .split('.')
      .map((part) => part.trim())
      .filter(Boolean);

    if (pathParts.length === 0) {
      return;
    }

    if (pathParts[0] === 'steps') {
      const workflow = config.workflows?.[0];
      if (!workflow) {
        throw new Error(`Cannot apply override "${overridePath}": workflows[0] is missing`);
      }
      this.setOnValue(workflow.steps as unknown, pathParts.slice(1), value, overridePath);
      return;
    }

    if (pathParts[0] === 'workflow' && pathParts[1] === 'steps') {
      const workflow = config.workflows?.[0];
      if (!workflow) {
        throw new Error(`Cannot apply override "${overridePath}": workflows[0] is missing`);
      }
      this.setOnValue(workflow.steps as unknown, pathParts.slice(2), value, overridePath);
      return;
    }

    this.setOnValue(config as unknown, pathParts, value, overridePath);
  }

  private setOnValue(
    target: unknown,
    pathParts: string[],
    value: unknown,
    fullPath: string
  ): void {
    if (pathParts.length === 0) {
      throw new Error(`Invalid override path: ${fullPath}`);
    }

    let current: unknown = target;

    for (let i = 0; i < pathParts.length - 1; i += 1) {
      const part = pathParts[i];
      const nextPart = pathParts[i + 1];

      if (Array.isArray(current)) {
        const index = this.resolveArrayItemIndex(current, part);
        if (index < 0) {
          throw new Error(`Cannot apply override "${fullPath}": array item "${part}" was not found`);
        }
        current = current[index];
        continue;
      }

      if (!isRecord(current)) {
        throw new Error(`Cannot apply override "${fullPath}": segment "${part}" is not an object`);
      }

      if (!(part in current) || current[part] === undefined || current[part] === null) {
        current[part] = /^\d+$/.test(nextPart) ? [] : {};
      }

      current = current[part];
    }

    const finalPart = pathParts[pathParts.length - 1];

    if (Array.isArray(current)) {
      const index = this.resolveArrayItemIndex(current, finalPart);
      if (index < 0) {
        throw new Error(`Cannot apply override "${fullPath}": array item "${finalPart}" was not found`);
      }
      current[index] = value;
      return;
    }

    if (!isRecord(current)) {
      throw new Error(`Cannot apply override "${fullPath}": parent object is invalid`);
    }

    current[finalPart] = value;
  }

  private resolveArrayItemIndex(items: unknown[], segment: string): number {
    if (/^\d+$/.test(segment)) {
      const index = Number.parseInt(segment, 10);
      return index >= 0 && index < items.length ? index : -1;
    }

    return items.findIndex(
      (item) =>
        isRecord(item) &&
        ((typeof item.name === 'string' && item.name === segment) ||
          (typeof item.id === 'string' && item.id === segment))
    );
  }

  private async safeReadDir(directory: string): Promise<string[]> {
    try {
      return await fs.readdir(directory);
    } catch {
      return [];
    }
  }

  private cloneValue<T>(value: T): T {
    if (typeof structuredClone === 'function') {
      return structuredClone(value);
    }

    return JSON.parse(JSON.stringify(value)) as T;
  }
}
