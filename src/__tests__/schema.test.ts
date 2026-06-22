import { describe, it, expect } from 'vitest';
import { validateInputSchema } from '../agent/schema';

describe('validateInputSchema', () => {
  describe('type validation', () => {
    it('accepts valid string', () => {
      expect(validateInputSchema({ type: 'string' }, 'hello')).toEqual({ ok: true });
    });

    it('rejects non-string when string expected', () => {
      const result = validateInputSchema({ type: 'string' }, 42);
      expect(result.ok).toBe(false);
    });

    it('accepts valid number', () => {
      expect(validateInputSchema({ type: 'number' }, 42)).toEqual({ ok: true });
    });

    it('rejects NaN', () => {
      const result = validateInputSchema({ type: 'number' }, NaN);
      expect(result.ok).toBe(false);
    });

    it('rejects Infinity', () => {
      const result = validateInputSchema({ type: 'number' }, Infinity);
      expect(result.ok).toBe(false);
    });

    it('accepts valid boolean', () => {
      expect(validateInputSchema({ type: 'boolean' }, true)).toEqual({ ok: true });
    });

    it('rejects non-boolean when boolean expected', () => {
      const result = validateInputSchema({ type: 'boolean' }, 'true');
      expect(result.ok).toBe(false);
    });
  });

  describe('object validation', () => {
    const schema = {
      type: 'object' as const,
      required: ['name'],
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
    };

    it('accepts valid object', () => {
      expect(validateInputSchema(schema, { name: 'Josh' })).toEqual({ ok: true });
    });

    it('accepts object with all properties', () => {
      expect(validateInputSchema(schema, { name: 'Josh', age: 30 })).toEqual({ ok: true });
    });

    it('rejects missing required field', () => {
      const result = validateInputSchema(schema, { age: 30 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('name');
    });

    it('rejects unknown properties', () => {
      const result = validateInputSchema(schema, { name: 'Josh', unknown: true });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('unknown');
    });

    it('rejects non-object', () => {
      const result = validateInputSchema(schema, 'not-object');
      expect(result.ok).toBe(false);
    });

    it('rejects array when object expected', () => {
      const result = validateInputSchema(schema, []);
      expect(result.ok).toBe(false);
    });

    it('rejects null', () => {
      const result = validateInputSchema(schema, null);
      expect(result.ok).toBe(false);
    });
  });

  describe('array validation', () => {
    const schema = {
      type: 'array' as const,
      items: { type: 'string' },
    };

    it('accepts valid array', () => {
      expect(validateInputSchema(schema, ['a', 'b'])).toEqual({ ok: true });
    });

    it('accepts empty array', () => {
      expect(validateInputSchema(schema, [])).toEqual({ ok: true });
    });

    it('rejects non-array', () => {
      const result = validateInputSchema(schema, 'not-array');
      expect(result.ok).toBe(false);
    });

    it('rejects array with wrong item type', () => {
      const result = validateInputSchema(schema, ['valid', 42]);
      expect(result.ok).toBe(false);
    });
  });

  describe('URI format validation', () => {
    const schema = { type: 'string' as const, format: 'uri' };

    it('accepts HTTPS URL', () => {
      expect(validateInputSchema(schema, 'https://example.com')).toEqual({ ok: true });
    });

    it('accepts HTTP URL', () => {
      expect(validateInputSchema(schema, 'http://example.com')).toEqual({ ok: true });
    });

    it('rejects non-HTTP protocol', () => {
      const result = validateInputSchema(schema, 'ftp://example.com');
      expect(result.ok).toBe(false);
    });

    it('rejects invalid URL', () => {
      const result = validateInputSchema(schema, 'not-a-url');
      expect(result.ok).toBe(false);
    });
  });

  describe('nested validation', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        items: {
          type: 'array' as const,
          items: {
            type: 'object' as const,
            required: ['id'],
            properties: {
              id: { type: 'string' },
            },
          },
        },
      },
    };

    it('accepts valid nested structure', () => {
      expect(validateInputSchema(schema, { items: [{ id: '1' }] })).toEqual({ ok: true });
    });

    it('rejects invalid nested item', () => {
      const result = validateInputSchema(schema, { items: [{ id: 42 }] });
      expect(result.ok).toBe(false);
    });
  });
});
