import { describe, expect, it } from 'vitest';
import { cleanJsonSchemaForGemini } from '../../src/client/zed/gemini-schema';

describe('Gemini schema edge cases', () => {
  it('represents tuple items as a single item schema', () => {
    expect(cleanJsonSchemaForGemini({ type: 'array', items: [{ type: 'string' }, { type: 'integer' }] }))
      .toEqual({ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'integer' }] } });
  });
  it('preserves numeric enum information without sending an invalid enum', () => {
    const schema = cleanJsonSchemaForGemini({ type: 'integer', enum: [1, 2], description: 'Choose a number' });
    expect(schema).not.toHaveProperty('enum');
    expect(schema.description).toContain('[1,2]');
    expect(schema.description).toContain('Choose a number');
  });
  it('handles numeric constants and empty tuples without invalid Gemini fields', () => {
    expect(cleanJsonSchemaForGemini({ type: 'integer', const: 2 })).not.toHaveProperty('enum');
    expect(cleanJsonSchemaForGemini({ type: 'array', items: [] })).toMatchObject({ items: { type: 'object' } });
  });
});
