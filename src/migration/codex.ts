import * as os from 'os';
import * as path from 'path';
import * as toml from '@iarna/toml';
import type {
  ProviderMigrationCandidate,
  ProviderMigrationSource,
} from './types';
import {
  firstExistingFilePath,
  normalizeConfigFilePathInput,
} from './fs-utils';
import { WELL_KNOWN_MODELS, WellKnownModelId } from '../well-known/models';
import { t } from '../i18n';
import type { ModelConfig, ProviderConfig } from '../types';

const CODEX_DEFAULT_MODEL_IDS: WellKnownModelId[] = [
  'gpt-5.2-codex',
  'gpt-5.1-codex-mini',
  'gpt-5.1-codex-max',
  'gpt-5.2',
] as const;

function getCodexDefaultModels(): ModelConfig[] {
  const models: ModelConfig[] = [];
  for (const id of CODEX_DEFAULT_MODEL_IDS) {
    const model = WELL_KNOWN_MODELS.find((m) => m.id === id);
    if (!model) {
      throw new Error(t('Well-known model not found: {0}', id));
    }
    const { alternativeIds: _alternativeIds, ...withoutAlternativeIds } = model;
    models.push(withoutAlternativeIds);
  }
  return models;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return isObjectRecord(value) ? value : undefined;
}

function getRecordByKey(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  if (!record) return undefined;
  return getRecord(record[key]);
}

type CodexWireApi = 'chat' | 'responses';

function parseWireApi(value: unknown): CodexWireApi | undefined {
  const s = getString(value);
  if (!s) return undefined;
  if (s === 'chat' || s === 'responses') return s;
  return undefined;
}

function isLikelyOpenAIModelId(modelId: string): boolean {
  return /^(gpt-|o\d|o-|codex)/i.test(modelId);
}

function buildCodexProviderFromToml(
  parsed: Record<string, unknown>,
): ProviderMigrationCandidate {
  const profileName = getString(parsed['profile']);
  const profiles = getRecord(parsed['profiles']);
  const profile = profileName
    ? getRecordByKey(profiles, profileName)
    : undefined;

  const modelId = getString(profile?.['model']) ?? getString(parsed['model']);
  const modelProviderId =
    getString(profile?.['model_provider']) ??
    getString(parsed['model_provider']);

  // Defaults per Codex docs: model_provider defaults to "openai".
  const effectiveProviderId = modelProviderId ?? 'openai';

  const modelProviders = getRecord(parsed['model_providers']);
  const providerConfig = getRecordByKey(modelProviders, effectiveProviderId);

  const providerDisplayName =
    getString(providerConfig?.['name']) ??
    (effectiveProviderId === 'openai'
      ? 'Codex'
      : `Codex (${effectiveProviderId})`);

  // Per Codex docs:
  // - Custom providers should define base_url in config.toml.
  // - Built-in provider "openai" can be overridden via OPENAI_BASE_URL.
  const providerBaseUrl =
    getString(providerConfig?.['base_url']) ??
    (effectiveProviderId === 'openai'
      ? getString(process.env.OPENAI_BASE_URL)
      : undefined);

  // Built-in provider wire_api is not configurable in config.toml; assume responses for "openai".
  const providerWireApi =
    parseWireApi(providerConfig?.['wire_api']) ??
    (effectiveProviderId === 'openai' ? 'responses' : undefined);

  const envKey = getString(providerConfig?.['env_key']);
  const apiKeyFromEnvKey = envKey ? getString(process.env[envKey]) : undefined;
  const apiKeyFromOpenAI =
    effectiveProviderId === 'openai'
      ? getString(process.env.OPENAI_API_KEY)
      : undefined;
  const apiKey = apiKeyFromEnvKey ?? apiKeyFromOpenAI;

  const providerType: ProviderConfig['type'] =
    providerWireApi === 'chat' ? 'openai-chat-completion' : 'openai-responses';

  const models: ModelConfig[] = [];
  if (modelId) {
    const known = WELL_KNOWN_MODELS.find((m) => m.id === modelId);
    if (known) {
      const { alternativeIds: _alternativeIds, ...withoutAlternativeIds } =
        known;
      models.push(withoutAlternativeIds);
    } else {
      models.push({ id: modelId });
    }
  }

  // Only add OpenAI/Codex defaults when it looks like the user is using OpenAI models.
  const shouldAddCodexDefaults =
    effectiveProviderId === 'openai' ||
    (modelId ? isLikelyOpenAIModelId(modelId) : false) ||
    (providerBaseUrl ? providerBaseUrl.includes('openai.com') : false);

  if (shouldAddCodexDefaults) {
    const defaults = getCodexDefaultModels();
    for (const m of defaults) {
      if (!models.some((existing) => existing.id === m.id)) {
        models.push(m);
      }
    }
  }

  if (!providerBaseUrl) {
    throw new Error(
      effectiveProviderId === 'openai'
        ? t(
            'Missing APIURL for Codex import: set OPENAI_BASE_URL or define a custom model provider with base_url in ~/.codex/config.toml.',
          )
        : t(
            'Missing APIURL for Codex import: set [model_providers.{0}].base_url in ~/.codex/config.toml.',
            effectiveProviderId,
          ),
    );
  }

  if (!apiKey) {
    if (envKey) {
      throw new Error(
        t(
          'Missing APIKEY for Codex import: environment variable {0} is not set (referenced by [model_providers.{1}].env_key).',
          envKey,
          effectiveProviderId,
        ),
      );
    }

    throw new Error(
      effectiveProviderId === 'openai'
        ? t(
            'Missing APIKEY for Codex import: set OPENAI_API_KEY in your environment (Codex uses env vars for keys).',
          )
        : t(
            'Missing APIKEY for Codex import: set [model_providers.{0}].env_key in ~/.codex/config.toml and export that environment variable.',
            effectiveProviderId,
          ),
    );
  }

  const baseUrl = providerBaseUrl;

  const provider: Partial<ProviderConfig> = {
    type: providerType,
    name: providerDisplayName,
    baseUrl,
    apiKey,
    models,
  };

  return { provider };
}

export const codexMigrationSource: ProviderMigrationSource = {
  id: 'codex',
  displayName: 'Codex',
  async detectConfigFile(): Promise<string | undefined> {
    const home = os.homedir();

    // Official: config lives at $CODEX_HOME/config.toml, where CODEX_HOME defaults to ~/.codex.
    const codexHome =
      typeof process.env.CODEX_HOME === 'string' &&
      process.env.CODEX_HOME.trim()
        ? process.env.CODEX_HOME.trim()
        : path.join(home, '.codex');

    const envCandidates = [
      // Non-official, but cheap compatibility knobs.
      process.env.CODEX_CONFIG_PATH,
      process.env.OPENAI_CODEX_CONFIG_PATH,
      process.env.CODEX_SETTINGS_PATH,
    ]
      .filter(
        (value): value is string =>
          typeof value === 'string' && value.trim().length > 0,
      )
      .map((value) => normalizeConfigFilePathInput(value));

    const candidates: string[] = [
      ...envCandidates,
      path.join(codexHome, 'config.toml'),
      path.join(home, '.codex', 'config.toml'),
    ];

    return firstExistingFilePath(candidates);
  },
  async importFromConfigContent(
    content: string,
  ): Promise<readonly ProviderMigrationCandidate[]> {
    let parsed: unknown;
    try {
      parsed = toml.parse(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(t('Failed to parse Codex config.toml: {0}', message));
    }

    if (!isObjectRecord(parsed)) {
      throw new Error(t('Codex config.toml must be a TOML table/object.'));
    }

    return [buildCodexProviderFromToml(parsed)];
  },
};
