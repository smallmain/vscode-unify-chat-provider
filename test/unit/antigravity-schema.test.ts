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
});
