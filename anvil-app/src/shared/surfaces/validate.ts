// Validator for the JsonSchema subset in src/shared/surfaces/types.ts. Used at the
// main-process trust boundary for tool arguments and surface payloads.
import type { JsonSchema } from './types.js';

export interface SchemaValidationError {
  path: string;
  message: string;
}

const MAX_ERRORS = 20;

export function validateJsonSchema(
  schema: JsonSchema,
  value: unknown,
  path = '$',
): SchemaValidationError[] {
  const errors: SchemaValidationError[] = [];
  visit(schema, value, path, errors);
  return errors.slice(0, MAX_ERRORS);
}

export function formatSchemaErrors(errors: SchemaValidationError[], limit = 5): string {
  const shown = errors.slice(0, limit).map((error) => `${error.path}: ${error.message}`);
  const more = errors.length > limit ? ` (+${errors.length - limit} more)` : '';
  return `${shown.join('; ')}${more}`;
}

function visit(
  schema: JsonSchema,
  value: unknown,
  path: string,
  errors: SchemaValidationError[],
): void {
  if (errors.length >= MAX_ERRORS) return;

  if (schema.oneOf?.length) {
    const matches = schema.oneOf.filter((option) => validateJsonSchema(option, value).length === 0);
    if (matches.length !== 1) {
      errors.push({
        path,
        message:
          matches.length === 0
            ? 'does not match any allowed shape'
            : 'matches more than one allowed shape',
      });
      return;
    }
  }

  if (schema.type && !matchesType(schema.type, value)) {
    errors.push({ path, message: `expected ${schema.type}, got ${describe(value)}` });
    return;
  }

  if (schema.enum && !schema.enum.includes(value as string | number)) {
    errors.push({ path, message: `must be one of ${schema.enum.map(String).join(', ')}` });
    return;
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path, message: `must be >= ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path, message: `must be <= ${schema.maximum}` });
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path, message: `must be at least ${schema.minLength} characters` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ path, message: `must be at most ${schema.maxLength} characters` });
    }
  }

  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ path, message: `must have at most ${schema.maxItems} items` });
    }
    if (schema.items) {
      value.forEach((item, index) =>
        visit(schema.items as JsonSchema, item, `${path}[${index}]`, errors),
      );
    }
    return;
  }

  if (
    isRecord(value) &&
    (schema.properties || schema.required || schema.additionalProperties !== undefined)
  ) {
    for (const key of schema.required ?? []) {
      if (value[key] === undefined)
        errors.push({ path: childPath(path, key), message: 'is required' });
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (propertySchema) {
        if (child !== undefined) visit(propertySchema, child, childPath(path, key), errors);
      } else if (schema.additionalProperties === false) {
        errors.push({ path: childPath(path, key), message: 'is not allowed' });
      } else if (isRecord(schema.additionalProperties)) {
        visit(schema.additionalProperties, child, childPath(path, key), errors);
      }
    }
  }
}

function matchesType(type: NonNullable<JsonSchema['type']>, value: unknown): boolean {
  switch (type) {
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && !Number.isFinite(value)) return 'non-finite number';
  return typeof value;
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
