import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  env: { language: 'en' },
  l10n: {
    t: (message: string | { message: string }) =>
      typeof message === 'string' ? message : message.message,
  },
}));

vi.mock('../../src/client/utils', () => ({
  buildBaseUrl: (baseUrl: string) => baseUrl,
  matchProvider: (url: string, pattern: string | RegExp) =>
    typeof pattern === 'string'
      ? url.includes(pattern.replaceAll('*', ''))
      : pattern.test(url),
}));

vi.mock('../../src/client/definitions', () => ({
  FeatureId: {},
}));

vi.mock('../../src/logger', () => ({
  createSimpleHttpLogger: () => undefined,
}));

vi.mock('../../src/utils', () => ({
  isRawBaseUrlEnabled: () => false,
}));

import { OpenAIChatCompletionProvider } from '../../src/client/openai/chat-completion-client';
import {
  applyPresetTemplateSelections,
  buildPresetTemplateConfigurationSchema,
} from '../../src/preset-templates';
import type { ModelConfig } from '../../src/types';
import { WELL_KNOWN_MODELS } from '../../src/well-known/models';
import {
  resolveProviderModels,
  WELL_KNOWN_PROVIDERS,
} from '../../src/well-known/providers';

const GLM_5_3_REASONING_TYPE = 'forced_thinking_with_reasoning_effort';

function requireModel(model: ModelConfig | undefined): ModelConfig {
  if (model === undefined) {
    throw new Error('GLM-5.3 model was not found');
  }
  return model;
}

function callPrivateBuilder(
  provider: OpenAIChatCompletionProvider,
  methodName: 'buildReasoningParams' | 'buildReasoningExtraBody',
  model: ModelConfig,
): unknown {
  const builder: unknown = Reflect.get(provider, methodName);
  if (typeof builder !== 'function') {
    throw new Error(`${methodName} was not found`);
  }
  return Reflect.apply(builder, provider, [model, GLM_5_3_REASONING_TYPE]);
}

function getFeatureBlock(source: string, featureId: string): string {
  const marker = `[FeatureId.${featureId}]: {`;
  const start = source.indexOf(marker);
  if (start < 0) {
    throw new Error(`Feature ${featureId} was not found`);
  }

  const rest = source.slice(start);
  const end = rest.indexOf('\n  },\n  [FeatureId.');
  return end < 0 ? rest : rest.slice(0, end);
}

describe('GLM-5.3 catalog support', () => {
  const model = WELL_KNOWN_MODELS.find(
    (candidate) => candidate.id === 'glm-5.3',
  );
  const provider = new OpenAIChatCompletionProvider({
    type: 'openai-chat-completion',
    name: 'GLM-5.3 test',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    models: [],
  });

  it('declares mandatory reasoning and the official limits', () => {
    expect(model).toMatchObject({
      id: 'glm-5.3',
      name: 'GLM-5.3',
      maxInputTokens: 1000000,
      maxOutputTokens: 128000,
      stream: true,
      thinking: {
        type: 'enabled',
        effort: 'max',
      },
      capabilities: {
        toolCalling: true,
        imageInput: false,
      },
    });
  });

  it('generates only the three supported reasoning effort choices', () => {
    const glm53 = requireModel(model);
    const effortTemplate = glm53.presetTemplates?.find(
      (template) => template.id === 'reasoningEffort',
    );

    expect(effortTemplate?.default).toBe('max');
    expect(effortTemplate?.presets.map((preset) => preset.id)).toEqual([
      'max',
      'high',
      'low',
    ]);
    expect(
      buildPresetTemplateConfigurationSchema(glm53)?.properties?.[
        'reasoningEffort'
      ],
    ).toMatchObject({
      enum: ['max', 'high', 'low'],
      default: 'max',
    });
    expect(
      applyPresetTemplateSelections(glm53, { reasoningEffort: 'low' }).thinking,
    ).toEqual({ type: 'enabled', effort: 'low' });
  });

  it.each(['ZhiPu AI', 'ZhiPu AI (Coding Plan)', 'Z.AI', 'Z.AI (Coding Plan)'])(
    'generates the corrected model for the %s built-in provider',
    (providerName) => {
      const definition = WELL_KNOWN_PROVIDERS.find(
        (candidate) => candidate.name === providerName,
      );
      if (definition === undefined) {
        throw new Error(`${providerName} provider was not found`);
      }

      const generated = resolveProviderModels(definition).find(
        (candidate) => candidate.id === 'glm-5.3',
      );
      const template = generated?.presetTemplates?.find(
        (candidate) => candidate.id === 'reasoningEffort',
      );

      expect(generated?.thinking).toEqual({ type: 'enabled', effort: 'max' });
      expect(template?.presets.map((preset) => preset.id)).toEqual([
        'max',
        'high',
        'low',
      ]);
    },
  );

  it.each(['max', 'high', 'low'] as const)(
    'sends mandatory thinking with %s reasoning effort',
    (effort) => {
      const configured = applyPresetTemplateSelections(requireModel(model), {
        reasoningEffort: effort,
      });

      expect(
        callPrivateBuilder(provider, 'buildReasoningParams', configured),
      ).toEqual({ thinking: { type: 'enabled' } });
      expect(
        callPrivateBuilder(provider, 'buildReasoningExtraBody', configured),
      ).toEqual({ reasoning_effort: effort });
    },
  );

  it('converts a stale disabled configuration to enabled low reasoning', () => {
    const configured = {
      ...requireModel(model),
      thinking: { type: 'disabled' as const },
    };

    expect(
      callPrivateBuilder(provider, 'buildReasoningParams', configured),
    ).toEqual({ thinking: { type: 'enabled' } });
    expect(
      callPrivateBuilder(provider, 'buildReasoningExtraBody', configured),
    ).toEqual({ reasoning_effort: 'low' });
  });

  it('enables the GLM-5.3 thinking and reasoning effort feature gates', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/client/definitions.ts'),
      'utf8',
    );

    expect(getFeatureBlock(source, 'OpenAIUseThinkingParam')).toContain(
      "modelFamilyIncludes(model, 'glm-5.3')",
    );
    expect(
      getFeatureBlock(source, 'OpenAIUseGlm53ReasoningEffortParam'),
    ).toContain("modelFamilyIncludes(model, 'glm-5.3')");
  });
});
