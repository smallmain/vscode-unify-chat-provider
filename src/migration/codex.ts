import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as toml from '@iarna/toml';
import type {
  ProviderMigrationCandidate,
  ProviderMigrationSource,
} from './types';
import { firstExistingFilePath } from './fs-utils';
import {
  WELL_KNOWN_MODELS,
  normalizeWellKnownConfigs,
} from '../well-known/models';
import {
  WELL_KNOWN_PROVIDERS,
  resolveProviderModels,
} from '../well-known/providers';
import { t } from '../i18n';
import type { ModelConfig, ProviderConfig } from '../types';
import { migrationLog } from '../logger';
import { CodexOAuthDetectedError } from './errors';

function normalizeBaseUrlForCompare(value: string): string {
  return value.replace(/\/+$/, '');
}

function findWellKnownProvider(
  type: ProviderConfig['type'],
  baseUrl: string,
): (typeof WELL_KNOWN_PROVIDERS)[number] | undefined {
  const normalized = normalizeBaseUrlForCompare(baseUrl);
  const exact = WELL_KNOWN_PROVIDERS.find(
    (p) =>
      p.type === type && normalizeBaseUrlForCompare(p.baseUrl) === normalized,
  );
  return exact ?? WELL_KNOWN_PROVIDERS.find((p) => p.type === type);
}

function getWellKnownBaseUrl(type: ProviderConfig['type']): string | undefined {
  return WELL_KNOWN_PROVIDERS.find((p) => p.type === type)?.baseUrl;
}

function getDefaultModelsFromWellKnown(
  type: ProviderConfig['type'],
  baseUrl: string,
): ModelConfig[] {
  const wk = findWellKnownProvider(type, baseUrl);
  if (!wk) return [];
  if (wk.models.length === 0) return [];
  return resolveProviderModels({ ...wk, baseUrl });
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

async function readAuthJsonApiKey(): Promise<string | undefined> {
  const home = os.homedir();
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(home, '.codex');
  const authJsonPath = path.join(codexHome, 'auth.json');

  try {
    const content = await fs.readFile(authJsonPath, 'utf-8');
    const parsed = JSON.parse(content);
    const apiKey = parsed?.OPENAI_API_KEY;
    return typeof apiKey === 'string' && apiKey.trim()
      ? apiKey.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

async function buildCodexProviderFromToml(
  parsed: Record<string, unknown>,
): Promise<ProviderMigrationCandidate> {
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

  // Built-in provider wire_api is not configurable in config.toml; assume responses for "openai".
  const providerWireApi =
    parseWireApi(providerConfig?.['wire_api']) ??
    (effectiveProviderId === 'openai' ? 'responses' : undefined);

  const providerType: ProviderConfig['type'] =
    providerWireApi === 'chat' ? 'openai-chat-completion' : 'openai-responses';

  // Per Codex docs:
  // - Custom providers should define base_url in config.toml.
  // - Built-in provider "openai" can be overridden via OPENAI_BASE_URL.
  const providerBaseUrl =
    getString(providerConfig?.['base_url']) ??
    (effectiveProviderId === 'openai'
      ? (getString(process.env.OPENAI_BASE_URL) ??
        getWellKnownBaseUrl(providerType) ??
        'https://api.openai.com')
      : undefined);

  // Priority order for API key resolution:
  // 1. Custom env_key from config.toml
  // 2. OPENAI_API_KEY from auth.json (for openai provider)
  // 3. OPENAI_API_KEY from environment variable
  const envKey = getString(providerConfig?.['env_key']);
  const apiKeyFromEnvKey = envKey ? getString(process.env[envKey]) : undefined;
  const apiKeyFromAuthJson = await readAuthJsonApiKey();
  const apiKeyFromOpenAI = getString(process.env.OPENAI_API_KEY);
  const apiKey = apiKeyFromEnvKey ?? apiKeyFromAuthJson ?? apiKeyFromOpenAI;

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

    if (effectiveProviderId === 'openai') {
      throw new CodexOAuthDetectedError();
    }

    throw new Error(
      t(
        'Missing APIKEY for Codex import: set [model_providers.{0}].env_key in ~/.codex/config.toml and export that environment variable.',
        effectiveProviderId,
      ),
    );
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

  const baseUrl = providerBaseUrl;

  const providerForMatching: ProviderConfig = {
    type: providerType,
    name: 'Codex',
    baseUrl,
    auth: {
      method: 'api-key',
      apiKey,
    },
    models: [],
  };

  const models: ModelConfig[] = [];
  if (modelId) {
    const known = WELL_KNOWN_MODELS.find((m) => m.id === modelId);
    if (known) {
      const declaredIds = new Map<string, string>();
      declaredIds.set(known.id, modelId);
      const [normalizedKnown] = normalizeWellKnownConfigs(
        [known],
        declaredIds,
        providerForMatching,
      );
      if (normalizedKnown) {
        models.push(normalizedKnown);
      }
    } else {
      models.push({ id: modelId });
    }
  }

  const defaults = getDefaultModelsFromWellKnown(providerType, baseUrl);
  for (const m of defaults) {
    if (!models.some((existing) => existing.id === m.id)) {
      models.push(m);
    }
  }

  const provider: Partial<ProviderConfig> = {
    ...providerForMatching,
    models,
  };

  return { provider };
}

export const codexMigrationSource: ProviderMigrationSource = {
  id: 'codex',
  displayName: 'Codex',
  async detectConfigFile(): Promise<string | undefined> {
    const home = os.homedir();
    const codexHome =
      typeof process.env.CODEX_HOME === 'string' &&
      process.env.CODEX_HOME.trim()
        ? process.env.CODEX_HOME.trim()
        : path.join(home, '.codex');

    return firstExistingFilePath([path.join(codexHome, 'config.toml')]);
  },
  async importFromConfigContent(
    content: string,
  ): Promise<readonly ProviderMigrationCandidate[]> {
    migrationLog.info('codex', 'Parsing config content');
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

    migrationLog.info('codex', 'Parsed TOML config', parsed);
    const candidate = await buildCodexProviderFromToml(parsed);
    migrationLog.info('codex', 'Built provider candidate', {
      type: candidate.provider.type,
      name: candidate.provider.name,
      baseUrl: candidate.provider.baseUrl,
      modelsCount: candidate.provider.models?.length,
    });
    return [candidate];
  },
};
