import type {
  ActionValidationIssue,
  ActionValidationResult,
  JsonSchemaLite,
  JsonSchemaLiteObject,
  JsonSchemaLiteType,
  JsonValue,
} from './types.js';

interface ValidationState {
  issues: ActionValidationIssue[];
}

export function validateJsonSchemaLite(
  value: unknown,
  schema: JsonSchemaLite | undefined
): ActionValidationResult {
  if (schema === undefined || schema === true) {
    return { valid: true, issues: [] };
  }

  const state: ValidationState = { issues: [] };
  validateAgainstSchema(value, schema, '$', state);
  return { valid: state.issues.length === 0, issues: state.issues };
}

function validateAgainstSchema(
  value: unknown,
  schema: JsonSchemaLite,
  path: string,
  state: ValidationState
): void {
  if (schema === true) {
    return;
  }

  if (schema === false) {
    addIssue(state, path, 'value is not allowed', 'never', describeValue(value));
    return;
  }

  if (!isSchemaObject(schema)) {
    addIssue(state, path, 'schema must be a boolean or object', 'schema', describeValue(schema));
    return;
  }

  validateCombinators(value, schema, path, state);

  if (schema.const !== undefined && !jsonEqual(value, schema.const)) {
    addIssue(
      state,
      path,
      `expected const ${JSON.stringify(schema.const)}`,
      JSON.stringify(schema.const),
      describeValue(value)
    );
  }

  if (schema.enum && !schema.enum.some((candidate) => jsonEqual(value, candidate))) {
    addIssue(
      state,
      path,
      `expected one of ${schema.enum.map((candidate) => JSON.stringify(candidate)).join(', ')}`
    );
  }

  const types = getExpectedTypes(schema);
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
    addIssue(state, path, `expected ${types.join(' or ')}`, types.join(' or '), describeValue(value));
    return;
  }

  if (shouldValidateObject(value, schema)) {
    validateObject(value as Record<string, unknown>, schema, path, state);
  }

  if (shouldValidateArray(value, schema)) {
    validateArray(value as unknown[], schema, path, state);
  }

  if (typeof value === 'string') {
    validateString(value, schema, path, state);
  }

  if (typeof value === 'number') {
    validateNumber(value, schema, path, state);
  }
}

function validateCombinators(
  value: unknown,
  schema: JsonSchemaLiteObject,
  path: string,
  state: ValidationState
): void {
  if (schema.allOf) {
    for (const child of schema.allOf) {
      validateAgainstSchema(value, child, path, state);
    }
  }

  if (schema.anyOf) {
    const matched = schema.anyOf.some((child) => validateJsonSchemaLite(value, child).valid);
    if (!matched) {
      addIssue(state, path, 'expected value to match at least one anyOf schema');
    }
  }

  if (schema.oneOf) {
    const matches = schema.oneOf.filter((child) => validateJsonSchemaLite(value, child).valid).length;
    if (matches !== 1) {
      addIssue(state, path, `expected value to match exactly one oneOf schema, matched ${matches}`);
    }
  }
}

function validateObject(
  value: Record<string, unknown>,
  schema: JsonSchemaLiteObject,
  path: string,
  state: ValidationState
): void {
  for (const key of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      addIssue(state, appendPath(path, key), 'required property is missing');
    }
  }

  const properties = schema.properties ?? {};
  for (const [key, childSchema] of Object.entries(properties)) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      validateAgainstSchema(value[key], childSchema, appendPath(path, key), state);
    }
  }

  const additional = schema.additionalProperties;
  if (additional === undefined || additional === true) {
    return;
  }

  for (const key of Object.keys(value)) {
    if (Object.prototype.hasOwnProperty.call(properties, key)) {
      continue;
    }

    if (additional === false) {
      addIssue(state, appendPath(path, key), 'additional property is not allowed');
    } else {
      validateAgainstSchema(value[key], additional, appendPath(path, key), state);
    }
  }
}

function validateArray(
  value: unknown[],
  schema: JsonSchemaLiteObject,
  path: string,
  state: ValidationState
): void {
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    addIssue(state, path, `expected at least ${schema.minItems} items`);
  }

  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    addIssue(state, path, `expected at most ${schema.maxItems} items`);
  }

  if (schema.items !== undefined) {
    value.forEach((item, index) => {
      validateAgainstSchema(item, schema.items!, `${path}[${index}]`, state);
    });
  }
}

function validateString(
  value: string,
  schema: JsonSchemaLiteObject,
  path: string,
  state: ValidationState
): void {
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    addIssue(state, path, `expected length >= ${schema.minLength}`);
  }

  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    addIssue(state, path, `expected length <= ${schema.maxLength}`);
  }

  if (schema.pattern !== undefined) {
    try {
      if (!new RegExp(schema.pattern).test(value)) {
        addIssue(state, path, `expected string to match /${schema.pattern}/`);
      }
    } catch {
      addIssue(state, path, `invalid pattern /${schema.pattern}/`);
    }
  }
}

function validateNumber(
  value: number,
  schema: JsonSchemaLiteObject,
  path: string,
  state: ValidationState
): void {
  if (schema.minimum !== undefined && value < schema.minimum) {
    addIssue(state, path, `expected value >= ${schema.minimum}`);
  }

  if (schema.maximum !== undefined && value > schema.maximum) {
    addIssue(state, path, `expected value <= ${schema.maximum}`);
  }
}

function getExpectedTypes(schema: JsonSchemaLiteObject): JsonSchemaLiteType[] {
  if (Array.isArray(schema.type)) {
    return schema.type;
  }

  if (schema.type) {
    return [schema.type];
  }

  if (schema.properties || schema.required || schema.additionalProperties !== undefined) {
    return ['object'];
  }

  if (schema.items || schema.minItems !== undefined || schema.maxItems !== undefined) {
    return ['array'];
  }

  return [];
}

function matchesType(value: unknown, type: JsonSchemaLiteType): boolean {
  switch (type) {
    case 'array':
      return Array.isArray(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return Number.isInteger(value);
    case 'null':
      return value === null;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'object':
      return isPlainObject(value);
    case 'string':
      return typeof value === 'string';
  }

  return false;
}

function shouldValidateObject(value: unknown, schema: JsonSchemaLiteObject): boolean {
  return (
    isPlainObject(value) &&
    Boolean(schema.properties || schema.required || schema.additionalProperties !== undefined)
  );
}

function shouldValidateArray(value: unknown, schema: JsonSchemaLiteObject): boolean {
  return (
    Array.isArray(value) &&
    Boolean(schema.items || schema.minItems !== undefined || schema.maxItems !== undefined)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSchemaObject(value: unknown): value is JsonSchemaLiteObject {
  return isPlainObject(value);
}

function appendPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function addIssue(
  state: ValidationState,
  path: string,
  message: string,
  expected?: string,
  received?: string
): void {
  state.issues.push({
    path,
    message,
    ...(expected !== undefined ? { expected } : {}),
    ...(received !== undefined ? { received } : {}),
  });
}

function describeValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return 'array';
  }

  return typeof value;
}

function jsonEqual(left: unknown, right: JsonValue): boolean {
  if (left === right) {
    return true;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => jsonEqual(item, right[index] as JsonValue))
    );
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);

    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key) => Object.prototype.hasOwnProperty.call(right, key) && jsonEqual(left[key], right[key])
      )
    );
  }

  return false;
}
