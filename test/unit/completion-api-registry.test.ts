import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  Disposable: class Disposable {
    dispose(): void {}
  },
  EventEmitter: class EventEmitter {
    readonly event = (): { dispose(): void } => ({ dispose() {} });
    dispose(): void {}
  },
  LanguageModelChatMessage: class LanguageModelChatMessage {},
  LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
  ThemeIcon: class ThemeIcon {},
  env: { language: 'en' },
  extensions: { getExtension: () => undefined },
  l10n: { t: (message: string) => message },
  workspace: {
    getConfiguration: () => ({ get: () => undefined }),
  },
}));
import {
  OLLAMA_GENERATE_CAPABILITIES,
  OLLAMA_GENERATE_PROVIDER_DEFINITION,
} from '../../src/completion/api/ollama-generate-provider';
import {
  NativeCompletionApiProviderRegistry,
  nativeCompletionApiProviderRegistry,
} from '../../src/completion/api/registry';
import type { NativeCompletionApiContext } from '../../src/completion/api/provider';
import type { CompletionTemplates } from '../../src/types';

function context(templates: CompletionTemplates): NativeCompletionApiContext {
  const model = { id: 'test-model' };
  return {
    provider: {
      type: 'openai-chat-completion',
      name: 'test-provider',
      baseUrl: 'https://example.test/v1',
      models: [model],
    },
    model,
    completion: { transport: 'native', templates },
    resolveCredential: async () => ({ kind: 'none' }),
  };
}

describe('native Completion API Provider registry', () => {
  it('registers the exact built-in native provider types', () => {
    expect(nativeCompletionApiProviderRegistry.listProviderTypes()).toEqual([
      'openai-chat-completion',
      'openai-responses',
      'ollama',
      'zed',
    ]);
    expect(nativeCompletionApiProviderRegistry.listTemplates()).toEqual([
      'mercury-edit-2',
      'codestral',
    ]);
  });

  it('selects native operations by completion template', () => {
    const mercury = nativeCompletionApiProviderRegistry.create(
      context(['mercury-edit-2']),
    );
    expect(mercury?.operations['mercury-edit-2']).toBeDefined();
    expect(mercury?.operations.codestral).toBeUndefined();

    const codestral = nativeCompletionApiProviderRegistry.create(
      context(['codestral']),
    );
    expect(codestral?.operations.codestral).toBeDefined();
    expect(codestral?.operations['mercury-edit-2']).toBeUndefined();

    const all = nativeCompletionApiProviderRegistry.create(context('all'));
    expect(all?.operations['mercury-edit-2']).toBeDefined();
    expect(all?.operations.codestral).toBeDefined();
  });

  it('rejects duplicate and empty registrations at startup', () => {
    expect(
      () =>
        new NativeCompletionApiProviderRegistry([
          {
            providerTypes: ['ollama'],
            definition: OLLAMA_GENERATE_PROVIDER_DEFINITION,
          },
          {
            providerTypes: ['ollama'],
            definition: OLLAMA_GENERATE_PROVIDER_DEFINITION,
          },
        ]),
    ).toThrow('type "ollama" is already registered');
    expect(
      () =>
        new NativeCompletionApiProviderRegistry([
          {
            providerTypes: [],
            definition: OLLAMA_GENERATE_PROVIDER_DEFINITION,
          },
        ]),
    ).toThrow('registration is empty');
    expect(
      () =>
        new NativeCompletionApiProviderRegistry([
          {
            templates: ['fim'],
            definition: OLLAMA_GENERATE_PROVIDER_DEFINITION,
          },
          {
            templates: ['fim'],
            definition: OLLAMA_GENERATE_PROVIDER_DEFINITION,
          },
        ]),
    ).toThrow('template "fim" is already registered');
  });

  it('validates static descriptors and commits multi-type registrations atomically', () => {
    expect(
      () =>
        new NativeCompletionApiProviderRegistry([
          {
            providerTypes: ['ollama'],
            definition: {
              capabilities: OLLAMA_GENERATE_CAPABILITIES,
              operationFactories: {
                fim: OLLAMA_GENERATE_PROVIDER_DEFINITION.operationFactories.fim,
              },
            },
          },
        ]),
    ).toThrow('capability "codegemma" has no implementation');

    const registry = new NativeCompletionApiProviderRegistry([
      {
        providerTypes: ['ollama'],
        definition: OLLAMA_GENERATE_PROVIDER_DEFINITION,
      },
    ]);
    expect(() =>
      registry.register({
        providerTypes: ['openai-chat-completion', 'ollama'],
        definition: OLLAMA_GENERATE_PROVIDER_DEFINITION,
      }),
    ).toThrow('type "ollama" is already registered');
    expect(registry.listProviderTypes()).toEqual(['ollama']);
  });
});
