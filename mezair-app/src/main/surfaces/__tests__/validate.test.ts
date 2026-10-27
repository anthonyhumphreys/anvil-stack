import { describe, expect, it } from 'vitest';
import type { JsonSchema } from '../../../shared/surfaces/types.js';
import { formatSchemaErrors, validateJsonSchema } from '../validate.js';

const schema: JsonSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 10 },
    count: { type: 'integer', minimum: 0, maximum: 5 },
    severity: { type: 'string', enum: ['low', 'high'] },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
    meta: { type: 'object', additionalProperties: { type: 'number' } },
    target: {
      oneOf: [
        {
          type: 'object',
          properties: { file: { type: 'string' } },
          required: ['file'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: { node: { type: 'string' } },
          required: ['node'],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ['title'],
  additionalProperties: false,
};

describe('validateJsonSchema', () => {
  it('accepts a valid value', () => {
    expect(
      validateJsonSchema(schema, {
        title: 'Hi',
        count: 3,
        severity: 'low',
        tags: ['a'],
        meta: { x: 1 },
        target: { file: 'a.ts' },
      }),
    ).toEqual([]);
  });

  it('reports paths for every violation', () => {
    const errors = validateJsonSchema(schema, {
      count: 2.5,
      severity: 'medium',
      tags: ['a', 2, 'c'],
      meta: { x: 'no' },
      extra: true,
      'odd key': 1,
    });
    const paths = errors.map((error) => error.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        '$.title',
        '$.count',
        '$.severity',
        '$.tags',
        '$.tags[1]',
        '$.meta.x',
        '$.extra',
        '$["odd key"]',
      ]),
    );
    expect(formatSchemaErrors(errors, 2)).toMatch(/\(\+\d+ more\)$/);
  });

  it('enforces numeric and string bounds', () => {
    expect(validateJsonSchema(schema, { title: '' })[0]).toMatchObject({ path: '$.title' });
    expect(validateJsonSchema(schema, { title: 'x'.repeat(11) })[0].message).toMatch(/at most 10/);
    expect(validateJsonSchema(schema, { title: 'ok', count: 9 })[0].message).toMatch(/<= 5/);
    expect(validateJsonSchema(schema, { title: 'ok', count: -1 })[0].message).toMatch(/>= 0/);
  });

  it('requires exactly one oneOf match', () => {
    expect(validateJsonSchema(schema, { title: 'ok', target: { line: 1 } })[0]).toMatchObject({
      path: '$.target',
      message: 'does not match any allowed shape',
    });
    const ambiguous: JsonSchema = { oneOf: [{ type: 'string' }, { type: 'string', maxLength: 5 }] };
    expect(validateJsonSchema(ambiguous, 'abc')[0].message).toBe(
      'matches more than one allowed shape',
    );
  });

  it('distinguishes types precisely', () => {
    expect(validateJsonSchema({ type: 'object' }, [])).toHaveLength(1);
    expect(validateJsonSchema({ type: 'number' }, Number.NaN)).toHaveLength(1);
    expect(validateJsonSchema({ type: 'null' }, null)).toEqual([]);
    expect(validateJsonSchema({ type: 'integer' }, 4)).toEqual([]);
  });
});
