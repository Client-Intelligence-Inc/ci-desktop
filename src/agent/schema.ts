import { DesktopCapability } from './types';

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

export function validateInputSchema(
  schema: DesktopCapability['inputSchema'],
  value: unknown,
  path = 'args',
): ValidationResult {
  const expectedType = schema.type;

  if (expectedType && typeof expectedType === 'string') {
    const typeResult = validateType(expectedType, value, path);
    if (!typeResult.ok) return typeResult;
  }

  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: `${path} must be an object` };
    }

    const record = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === 'string' && !(key in record)) {
        return { ok: false, error: `${path}.${key} is required` };
      }
    }

    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const key of Object.keys(record)) {
      const propertySchema = properties[key];
      if (!isRecord(propertySchema)) {
        return { ok: false, error: `${path}.${key} is not allowed` };
      }

      const propertyResult = validateInputSchema(propertySchema, record[key], `${path}.${key}`);
      if (!propertyResult.ok) return propertyResult;
    }
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      return { ok: false, error: `${path} must be an array` };
    }

    if (isRecord(schema.items)) {
      for (let index = 0; index < value.length; index += 1) {
        const itemResult = validateInputSchema(schema.items, value[index], `${path}[${index}]`);
        if (!itemResult.ok) return itemResult;
      }
    }
  }

  if (schema.format === 'uri' && typeof value === 'string') {
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { ok: false, error: `${path} must be an http or https URL` };
      }
    } catch {
      return { ok: false, error: `${path} must be a valid URL` };
    }
  }

  return { ok: true };
}

function validateType(type: string, value: unknown, path: string): ValidationResult {
  switch (type) {
    case 'object':
      return value && typeof value === 'object' && !Array.isArray(value)
        ? { ok: true }
        : { ok: false, error: `${path} must be an object` };
    case 'array':
      return Array.isArray(value)
        ? { ok: true }
        : { ok: false, error: `${path} must be an array` };
    case 'string':
      return typeof value === 'string'
        ? { ok: true }
        : { ok: false, error: `${path} must be a string` };
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? { ok: true }
        : { ok: false, error: `${path} must be a finite number` };
    case 'boolean':
      return typeof value === 'boolean'
        ? { ok: true }
        : { ok: false, error: `${path} must be a boolean` };
    default:
      return { ok: false, error: `${path} uses unsupported schema type ${type}` };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
