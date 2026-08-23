import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  env: { language: 'en' },
  l10n: {
    t: (message: string | { message: string }) =>
      typeof message === 'string' ? message : message.message,
  },
}));

vi.mock('../../src/client/utils', () => ({}));
vi.mock('../../src/utils', () => ({}));
vi.mock('../../src/client/google/ai-studio-client', () => ({
  GoogleAIStudioProvider: class {},
}));

import { cleanJsonSchemaForAntigravity } from '../../src/client/google/code-assist-client';

describe('Antigravity tool schema', () => {
  it('removes MCP transport header annotations recursively', () => {
    expect(
      cleanJsonSchemaForAntigravity({
        type: 'object',
        'x-mcp-header': 'Root',
        properties: {
          region: {
            type: 'string',
            description: 'The region to query',
            'x-mcp-header': 'Region',
          },
          options: {
            type: 'object',
            properties: {
              tenant: {
                type: 'string',
                'x-mcp-header': 'Tenant',
              },
            },
          },
        },
        required: ['region'],
      }),
    ).toEqual({
      type: 'object',
      properties: {
        region: {
          type: 'string',
          description: 'The region to query',
        },
        options: {
          type: 'object',
          properties: {
            tenant: {
              type: 'string',
            },
          },
        },
      },
      required: ['region'],
    });
  });

  it('preserves x-mcp-header keys inside opaque schema values', () => {
    const literal = { 'x-mcp-header': 'literal' };

    expect(
      cleanJsonSchemaForAntigravity({ example: literal }),
    ).toEqual({ example: literal });
    expect(cleanJsonSchemaForAntigravity({ const: literal })).toEqual({
      enum: [JSON.stringify(literal)],
    });
    expect(cleanJsonSchemaForAntigravity({ enum: [literal] })).toEqual({
      enum: [JSON.stringify(literal)],
    });
  });

  it('keeps a tool argument named x-mcp-header and its required entry', () => {
    expect(
      cleanJsonSchemaForAntigravity({
        type: 'object',
        properties: {
          'x-mcp-header': {
            type: 'string',
            description: 'A regular tool argument',
          },
        },
        required: ['x-mcp-header'],
      }),
    ).toEqual({
      type: 'object',
      properties: {
        'x-mcp-header': {
          type: 'string',
          description: 'A regular tool argument',
        },
      },
      required: ['x-mcp-header'],
    });
  });

  it('does not mutate the input schema', () => {
    const schema = {
      type: 'object',
      properties: {
        region: {
          type: 'string',
          'x-mcp-header': 'Region',
          example: { 'x-mcp-header': 'literal' },
        },
      },
      required: ['region'],
    };
    const original = structuredClone(schema);

    const cleaned = cleanJsonSchemaForAntigravity(schema);

    expect(schema).toEqual(original);
    expect(cleaned).not.toBe(schema);
  });
});
