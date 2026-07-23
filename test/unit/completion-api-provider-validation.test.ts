import { describe, expect, it } from 'vitest';
import { validateCompletionApiProvider } from '../../src/completion/api/provider';
import { CompletionInvariantError } from '../../src/completion/model/errors';

const bufferedCapability = {
  responseMode: 'buffered' as const,
  multiCandidateSupport: 'single-request' as const,
};

describe('Completion API Provider capability validation', () => {
  it('accepts matching capability and implementation tables', () => {
    expect(() =>
      validateCompletionApiProvider({
        transport: 'native',
        capabilities: { fim: bufferedCapability },
        operations: { fim: { execute: () => undefined } },
      }),
    ).not.toThrow();
  });

  it('rejects missing implementations and missing capabilities', () => {
    expect(() =>
      validateCompletionApiProvider({
        transport: 'native',
        capabilities: { fim: bufferedCapability },
        operations: {},
      }),
    ).toThrow('capability "fim" has no implementation');
    expect(() =>
      validateCompletionApiProvider({
        transport: 'compatible',
        capabilities: {},
        operations: { fim: {} },
      }),
    ).toThrow('implementation "fim" has no capability');
    expect(() =>
      validateCompletionApiProvider({
        transport: 'native',
        capabilities: { fim: bufferedCapability },
        operations: { fim: undefined },
      }),
    ).toThrow('capability "fim" has no implementation');
    expect(() =>
      validateCompletionApiProvider({
        transport: 'native',
        capabilities: { fim: bufferedCapability },
        operations: { fim: {} },
      }),
    ).toThrow('capability "fim" has no implementation');
    try {
      validateCompletionApiProvider({
        transport: 'native',
        capabilities: { fim: bufferedCapability },
        operations: {},
      });
    } catch (error) {
      expect(error).toBeInstanceOf(CompletionInvariantError);
      expect(error).toMatchObject({
        code: 'completion-invariant-violation',
      });
    }
  });

  it('rejects unknown kinds and response mode mismatches', () => {
    expect(() =>
      validateCompletionApiProvider({
        transport: 'native',
        capabilities: { unknown: bufferedCapability },
        operations: { unknown: {} },
      }),
    ).toThrow('unknown capability "unknown"');
    expect(() =>
      validateCompletionApiProvider({
        transport: 'compatible',
        capabilities: {
          'copilot-replica-nes': bufferedCapability,
        },
        operations: {
          'copilot-replica-nes': { execute: () => undefined },
        },
      }),
    ).toThrow('capability "copilot-replica-nes" is invalid');
  });
});
