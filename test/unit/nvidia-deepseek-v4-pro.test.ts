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
  mergeWithWellKnownModel,
  normalizeWellKnownConfigs,
  WELL_KNOWN_MODELS,
} from '../../src/well-known/models';
import type { ProviderConfig } from '../../src/types';

const NVIDIA_PROVIDER: ProviderConfig = {
  name: 'Nvidia',
  type: 'openai-chat-completion',
  baseUrl: 'https://integrate.api.nvidia.com',
  models: [],
};

describe('NVIDIA DeepSeek V4 Pro catalog override', () => {
  it('uses the NVIDIA API output limit for the built-in model', () => {
    const deepSeekV4Pro = WELL_KNOWN_MODELS.filter(
      (model) => model.id === 'deepseek-v4-pro',
    );

    expect(
      normalizeWellKnownConfigs(deepSeekV4Pro, undefined, NVIDIA_PROVIDER),
    ).toMatchObject([
      {
        id: 'deepseek-ai/deepseek-v4-pro',
        maxOutputTokens: 16384,
      },
    ]);
  });

  it('applies the same limit to an API-discovered NVIDIA model', () => {
    expect(
      mergeWithWellKnownModel(
        { id: 'deepseek-ai/deepseek-v4-pro' },
        NVIDIA_PROVIDER,
      ),
    ).toMatchObject({
      id: 'deepseek-ai/deepseek-v4-pro',
      maxOutputTokens: 16384,
    });
  });
});
