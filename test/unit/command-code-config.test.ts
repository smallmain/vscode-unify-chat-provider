import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  env: {
    clipboard: {
      readText: vi.fn(),
      writeText: vi.fn(),
    },
  },
  l10n: { t: (message: string) => message },
}));

vi.mock('../../src/config-ops', () => ({
  MODEL_CONFIG_KEYS: [],
  PROVIDER_CONFIG_KEYS: [],
  deepClone: <T>(value: T): T => structuredClone(value),
  mergePartialByKeys: vi.fn(),
  withoutKey: vi.fn(),
}));

import {
  decodeBase64ToObject,
  encodeConfigToBase64,
} from '../../src/ui/base64-config';
import type { ProviderConfig } from '../../src/types';

describe('Command Code configuration transfer', () => {
  it('round-trips one provider with shared defaults and model overrides', () => {
    const config: ProviderConfig = {
      type: 'command-code',
      name: 'Command Code',
      baseUrl: 'https://api.commandcode.ai/provider/v1',
      transport: 'sse',
      serviceTier: 'priority',
      auth: { method: 'api-key', apiKey: '' },
      extraBody: { shared_provider_option: true },
      models: [
        {
          id: 'opaque-id',
          name: 'Claude Model With Opaque ID',
          serviceTier: 'standard',
          extraBody: { model_option: 'override' },
        },
      ],
      autoFetchOfficialModels: true,
    };

    const encoded = encodeConfigToBase64(config);
    const decoded = decodeBase64ToObject<ProviderConfig>(encoded);

    expect(decoded).toEqual(config);
  });
});
