import { describe, expect, it } from 'vitest';
import {
  captureProviderSourceGuard,
  isProviderSourceGuardCurrent,
  parseProviderSourceGuard,
} from '../../src/auth/provider-source-guard';
import type { ProviderConfig } from '../../src/types';

function provider(apiKey: string): ProviderConfig {
  return {
    type: 'openai-chat-completion',
    name: 'provider',
    baseUrl: 'https://api.example.test/v1/',
    models: [],
    auth: { method: 'api-key', apiKey },
  };
}

describe('provider source guard', () => {
  it('contains only names, expectations, and SHA-256 signatures', () => {
    const guard = captureProviderSourceGuard([
      { providerName: 'provider', provider: provider('private-api-key') },
      { providerName: 'renamed-provider', provider: undefined },
    ]);

    expect(JSON.stringify(guard)).not.toContain('private-api-key');
    expect(guard).toEqual({
      expectations: [
        {
          providerName: 'provider',
          expected: 'present',
          authTargetSignature: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        { providerName: 'renamed-provider', expected: 'absent' },
      ],
    });
    expect(parseProviderSourceGuard(guard)).toEqual(guard);
  });

  it('detects changed, deleted, and newly created sources', () => {
    const current = new Map<string, ProviderConfig>([
      ['provider', provider('old-key')],
    ]);
    const guard = captureProviderSourceGuard([
      { providerName: 'provider', provider: current.get('provider') },
      { providerName: 'renamed-provider', provider: undefined },
    ]);
    const getProvider = (name: string): ProviderConfig | undefined =>
      current.get(name);

    expect(isProviderSourceGuardCurrent(guard, getProvider)).toBe(true);
    current.set('provider', provider('new-key'));
    expect(isProviderSourceGuardCurrent(guard, getProvider)).toBe(false);
    current.set('provider', provider('old-key'));
    current.set('renamed-provider', {
      ...provider('target-key'),
      name: 'renamed-provider',
    });
    expect(isProviderSourceGuardCurrent(guard, getProvider)).toBe(false);
    current.delete('renamed-provider');
    current.delete('provider');
    expect(isProviderSourceGuardCurrent(guard, getProvider)).toBe(false);
  });

  it('detects raw base URL mode changes', () => {
    const configured = provider('old-key');
    const current = new Map<string, ProviderConfig>([
      [configured.name, configured],
    ]);
    const guard = captureProviderSourceGuard([
      { providerName: configured.name, provider: configured },
    ]);

    current.set(configured.name, { ...configured, useRawBaseUrl: true });

    expect(
      isProviderSourceGuardCurrent(guard, (name) => current.get(name)),
    ).toBe(false);
  });

  it('uses the session fingerprint URL semantics without duplicate checks', () => {
    const configured: ProviderConfig = {
      ...provider('unused'),
      baseUrl: 'https://api.example.test/v1?region=one',
      auth: {
        method: 'openai-codex',
        bindingId: '00000000-0000-4000-8000-000000000801',
      },
    };
    const current = new Map<string, ProviderConfig>([
      [configured.name, configured],
    ]);
    const guard = captureProviderSourceGuard([
      { providerName: configured.name, provider: configured },
    ]);

    current.set(configured.name, {
      ...configured,
      baseUrl: 'https://api.example.test/v1?region=two',
    });
    expect(
      isProviderSourceGuardCurrent(guard, (name) => current.get(name)),
    ).toBe(true);

    const rawConfigured = { ...configured, useRawBaseUrl: true };
    current.set(configured.name, rawConfigured);
    const rawGuard = captureProviderSourceGuard([
      { providerName: rawConfigured.name, provider: rawConfigured },
    ]);
    current.set(configured.name, {
      ...rawConfigured,
      baseUrl: 'https://api.example.test/v1?region=two',
    });
    expect(
      isProviderSourceGuardCurrent(rawGuard, (name) => current.get(name)),
    ).toBe(false);
  });
});
