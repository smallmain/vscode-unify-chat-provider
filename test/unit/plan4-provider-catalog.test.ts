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
  matchProvider: (url: string, pattern: string | RegExp) =>
    typeof pattern === 'string'
      ? url.includes(pattern.replaceAll('*', ''))
      : pattern.test(url),
}));

import {
  getAlternativeIds,
  WELL_KNOWN_MODELS,
} from '../../src/well-known/models';
import { WELL_KNOWN_PROVIDERS } from '../../src/well-known/providers';

function getModel(id: string) {
  const model = WELL_KNOWN_MODELS.find((candidate) => candidate.id === id);
  expect(model).toBeDefined();
  return model!;
}

describe('Plan 4 provider definitions', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/client/definitions.ts'),
    'utf8',
  );

  it('does not declare Inception or Mistral chat provider types', () => {
    expect(source).not.toMatch(/^\s*\| 'inception'$/m);
    expect(source).not.toMatch(/^\s*\| 'mistral'$/m);
  });

  it('gates max_tokens-only behavior by provider base URL', () => {
    const featureBlock = source.match(
      /\[FeatureId\.OpenAIOnlyMaxTokens\]: \{([\s\S]*?)\n  \},\n  \[FeatureId\.OpenAICacheControl\]/,
    )?.[1];

    expect(featureBlock).toContain("'api.inceptionlabs.ai'");
    expect(featureBlock).toContain("'api.mistral.ai'");
  });
});

describe('Plan 4 well-known catalog', () => {
  it('declares FIM completion for every DeepSeek model and the beta endpoint', () => {
    const deepSeekModels = WELL_KNOWN_MODELS.filter((model) =>
      model.id.startsWith('deepseek-'),
    );
    expect(deepSeekModels.length).toBeGreaterThan(0);
    for (const model of deepSeekModels) {
      expect(model.completion?.templates).toEqual(['fim']);
    }
    expect(
      WELL_KNOWN_PROVIDERS.find((provider) => provider.name === 'DeepSeek'),
    ).toMatchObject({
      baseUrl: 'https://api.deepseek.com',
      completion: { baseUrl: '../beta' },
    });
  });

  it('declares Zeta primary IDs, aliases, and only completion templates', () => {
    expect(getModel('zeta')).toMatchObject({
      completion: { templates: ['zeta1'] },
    });
    expect(getAlternativeIds(getModel('zeta'))).toEqual([
      'zed-industries/zeta',
    ]);
    expect(getAlternativeIds(getModel('zeta-2'))).toEqual([
      'zed-industries/zeta-2',
      'zeta2',
    ]);
    expect(getAlternativeIds(getModel('zeta-2.1'))).toEqual([
      'zed-industries/zeta-2.1',
      'zeta2.1',
    ]);
    expect(getModel('zeta-cloud')).toMatchObject({
      completion: { templates: ['zeta3-internal'] },
    });

    for (const id of ['zeta', 'zeta-2', 'zeta-2.1', 'zeta-cloud']) {
      const model = getModel(id);
      expect(model.capabilities).toBeUndefined();
      expect(model.maxInputTokens).toBeUndefined();
      expect(model.maxOutputTokens).toBeUndefined();
      expect(model.thinking).toBeUndefined();
    }
  });

  it('declares exact Inception and Mistral model capabilities', () => {
    expect(getModel('mercury-2')).toMatchObject({
      maxInputTokens: 128000,
      maxOutputTokens: 50000,
      stream: true,
      thinking: { type: 'enabled', effort: 'high' },
      capabilities: { toolCalling: true, imageInput: false },
    });
    expect(getModel('mercury-2').presetTemplates?.[0]).toMatchObject({
      id: 'reasoningEffort',
      default: 'high',
    });
    expect(
      getModel('mercury-2').presetTemplates?.[0].presets.map(
        (preset) => preset.id,
      ),
    ).toEqual(['high', 'medium', 'low']);
    expect(getModel('mercury-edit-2')).toMatchObject({
      maxInputTokens: 32000,
      maxOutputTokens: 8192,
      stream: false,
      capabilities: { toolCalling: false, imageInput: false },
      completion: { templates: ['mercury-edit-2'] },
    });
    expect(getModel('mercury-edit-2').thinking).toBeUndefined();

    for (const id of ['mistral-medium-3-5', 'mistral-small-2603']) {
      expect(getModel(id)).toMatchObject({
        maxInputTokens: 256000,
        maxOutputTokens: 65536,
        stream: true,
        thinking: { type: 'enabled', effort: 'xhigh' },
        capabilities: { toolCalling: true, imageInput: true },
      });
      expect(getModel(id).presetTemplates?.[0]).toMatchObject({
        id: 'reasoningEffort',
        default: 'xhigh',
      });
      expect(
        getModel(id).presetTemplates?.[0].presets.map((preset) => preset.id),
      ).toEqual(['xhigh', 'high', 'medium', 'low', 'minimal', 'none']);
    }
    expect(getModel('codestral-2508')).toMatchObject({
      maxInputTokens: 128000,
      maxOutputTokens: 65536,
      stream: true,
      capabilities: { toolCalling: true, imageInput: false },
      completion: { templates: ['codestral'] },
    });
    expect(getModel('codestral-2508').thinking).toBeUndefined();
  });

  it('uses fixed provider model lists without automatic discovery', () => {
    expect(
      WELL_KNOWN_PROVIDERS.find((provider) => provider.name === 'Inception'),
    ).toMatchObject({
      type: 'openai-chat-completion',
      baseUrl: 'https://api.inceptionlabs.ai/v1',
      completion: { baseUrl: './edit' },
      authTypes: ['api-key'],
      models: ['mercury-2', 'mercury-edit-2'],
    });
    expect(
      WELL_KNOWN_PROVIDERS.find((provider) => provider.name === 'Mistral AI'),
    ).toMatchObject({
      type: 'openai-chat-completion',
      baseUrl: 'https://api.mistral.ai/v1',
      completion: { baseUrl: './fim' },
      authTypes: ['api-key'],
      models: [
        'mistral-medium-3-5',
        'mistral-small-2603',
        'codestral-2508',
      ],
    });
    expect(
      WELL_KNOWN_PROVIDERS.filter((provider) =>
        ['Inception', 'Mistral AI'].includes(provider.name),
      ).every((provider) => provider.autoFetchOfficialModels !== true),
    ).toBe(true);
  });

  it('keeps Zed static models out of the well-known provider config', () => {
    expect(
      WELL_KNOWN_PROVIDERS.find((provider) => provider.name === 'Zed'),
    ).toMatchObject({
      type: 'zed',
      models: [],
      autoFetchOfficialModels: true,
    });
  });
});
