import { describe, expect, it } from 'vitest';
import {
  normalizeCompletionConfig,
  resolveCompletionConfig,
  resolveExternalCompletionConfig,
} from '../../src/completion/model/configuration';

describe('completion model configuration', () => {
  it('distinguishes absent, valid, and invalid configuration', () => {
    expect(normalizeCompletionConfig(undefined)).toEqual({ status: 'absent' });
    expect(normalizeCompletionConfig({})).toEqual({
      status: 'valid',
      value: {},
    });
    expect(normalizeCompletionConfig(null)).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'completion-not-object' }],
    });
  });

  it('trims baseUrl and canonicalizes template arrays as unordered sets', () => {
    expect(
      normalizeCompletionConfig({
        transport: 'native',
        baseUrl: '  https://completion.example.test/v1  ',
        templates: [
          'copilot-replica-nes',
          'fim',
          'copilot-replica-nes',
          'codegemma',
        ],
      }),
    ).toEqual({
      status: 'valid',
      value: {
        transport: 'native',
        baseUrl: 'https://completion.example.test/v1',
        templates: ['fim', 'codegemma', 'copilot-replica-nes'],
      },
    });

    expect(normalizeCompletionConfig({ baseUrl: '  ' })).toEqual({
      status: 'valid',
      value: {},
    });
  });

  it('preserves all and an explicitly empty template set', () => {
    expect(normalizeCompletionConfig({ templates: 'all' })).toEqual({
      status: 'valid',
      value: { templates: 'all' },
    });
    expect(normalizeCompletionConfig({ templates: [] })).toEqual({
      status: 'valid',
      value: { templates: [] },
    });
  });

  it.each([
    [false, 'completion-not-object'],
    [{ transport: 'sse' }, 'completion-invalid-transport'],
    [{ baseUrl: 42 }, 'completion-invalid-base-url'],
    [{ templates: 'fim' }, 'completion-invalid-templates'],
    [{ templates: ['fim', 'unknown'] }, 'completion-invalid-templates'],
    [{ templates: ['fim', 1] }, 'completion-invalid-templates'],
    [{ fimType: 'native' }, 'completion-unknown-field'],
    [{ fimBaseUrl: 'https://legacy.test' }, 'completion-unknown-field'],
    [{ fimTemplate: 'generic' }, 'completion-unknown-field'],
  ])('rejects invalid or legacy input %#', (raw, expectedCode) => {
    const result = normalizeCompletionConfig(raw);
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.issues.map((issue) => issue.code)).toContain(expectedCode);
    }
  });

  it('resolves fields independently with model precedence and defaults', () => {
    const provider = normalizeCompletionConfig({
      transport: 'native',
      baseUrl: 'https://provider.example.test/v1',
      templates: [],
    });
    const model = normalizeCompletionConfig({
      transport: 'compatible',
      templates: 'all',
    });

    expect(resolveCompletionConfig(provider, model)).toEqual({
      status: 'valid',
      value: {
        transport: 'compatible',
        baseUrl: 'https://provider.example.test/v1',
        templates: 'all',
      },
    });
    expect(
      resolveCompletionConfig(
        normalizeCompletionConfig(undefined),
        normalizeCompletionConfig(undefined),
      ),
    ).toEqual({
      status: 'valid',
      value: { transport: 'auto', templates: [] },
    });
  });

  it('lets provider invalidity dominate and scopes model invalidity locally', () => {
    const invalidProvider = normalizeCompletionConfig({ fimType: 'native' });
    const validModel = normalizeCompletionConfig({ templates: 'all' });
    expect(resolveCompletionConfig(invalidProvider, validModel)).toMatchObject({
      status: 'invalid',
      scope: 'provider',
    });

    const validProvider = normalizeCompletionConfig({ templates: 'all' });
    const invalidModel = normalizeCompletionConfig({ templates: ['unknown'] });
    expect(resolveCompletionConfig(validProvider, invalidModel)).toMatchObject({
      status: 'invalid',
      scope: 'model',
    });
  });

  it('uses compatible transport with all templates for external models', () => {
    expect(resolveExternalCompletionConfig()).toEqual({
      transport: 'compatible',
      templates: 'all',
    });
  });
});
