import * as os from 'os';
import * as path from 'path';
import type {
  ProviderMigrationCandidate,
  ProviderMigrationSource,
} from './types';
import { firstExistingFilePath, isExistingFile } from './fs-utils';
import {
  WELL_KNOWN_MODELS,
  WellKnownModelId,
  normalizeWellKnownConfigs,
} from '../well-known/models';
import { t } from '../i18n';
import type { ModelConfig, ProviderConfig } from '../types';
import { migrationLog } from '../logger';

const CLAUDE_CODE_DEFAULT_MODEL_IDS: WellKnownModelId[] = [
  'claude-sonnet-4-5',
  'claude-opus-4-5',
  'claude-haiku-4-5',
] as const;

function getClaudeCodeDefaultModels(provider: ProviderConfig): ModelConfig[] {
  const models: (typeof WELL_KNOWN_MODELS)[number][] = [];
  for (const id of CLAUDE_CODE_DEFAULT_MODEL_IDS) {
    const model = WELL_KNOWN_MODELS.find((m) => m.id === id);
    if (!model) {
      throw new Error(t('Well-known model not found: {0}', id));
    }
    models.push(model);
  }
  return normalizeWellKnownConfigs(models, undefined, provider);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type ClaudeCodeAuthMethod = 'api-key' | 'oauth' | 'unknown';

interface ClaudeCodeSettings {
  authMethod: ClaudeCodeAuthMethod;
  apiKey?: string;
  baseUrl?: string;
  oauthEmail?: string;
}

function tryParseJson(content: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed;
  } catch {
    // ignore
  }
  return undefined;
}

function normalizeUrlCandidate(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const withScheme = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return withScheme;
  } catch {
    return undefined;
  }
}

function extractSettingsFromJson(json: unknown): ClaudeCodeSettings {
  if (!isObjectRecord(json)) {
    return { authMethod: 'unknown' };
  }

  let apiKey: string | undefined;
  let authToken: string | undefined;
  let baseUrl: string | undefined;
  let oauthEmail: string | undefined;
  let hasOAuthSession = false;

  const env = json['env'];
  if (isObjectRecord(env)) {
    const rawApiKey = env['ANTHROPIC_API_KEY'];
    if (typeof rawApiKey === 'string' && rawApiKey.trim()) {
      apiKey = rawApiKey.trim();
    }

    const rawAuthToken = env['ANTHROPIC_AUTH_TOKEN'];
    if (typeof rawAuthToken === 'string' && rawAuthToken.trim()) {
      authToken = rawAuthToken.trim();
    }

    const rawBaseUrl = env['ANTHROPIC_BASE_URL'];
    if (typeof rawBaseUrl === 'string' && rawBaseUrl.trim()) {
      baseUrl = normalizeUrlCandidate(rawBaseUrl) ?? rawBaseUrl.trim();
    }
  }

  const oauthSession = json['oauthSession'];
  if (isObjectRecord(oauthSession)) {
    hasOAuthSession = true;
    const email = oauthSession['email'];
    if (typeof email === 'string' && email.trim()) {
      oauthEmail = email.trim();
    }
  }

  let authMethod: ClaudeCodeAuthMethod = 'unknown';
  if (apiKey || authToken) {
    authMethod = 'api-key';
  } else if (hasOAuthSession) {
    authMethod = 'oauth';
  }

  return {
    authMethod,
    apiKey: apiKey ?? authToken,
    baseUrl,
    oauthEmail,
  };
}

function extractClaudeCodeSettings(content: string): ClaudeCodeSettings {
  const json = tryParseJson(content.trim());
  if (json !== undefined) {
    return extractSettingsFromJson(json);
  }
  return { authMethod: 'unknown' };
}

function buildClaudeCodeProvider(
  settings: ReturnType<typeof extractClaudeCodeSettings>,
): ProviderMigrationCandidate {
  const baseUrl = settings.baseUrl;
  const apiKey = settings.apiKey;

  if (!baseUrl || !apiKey) {
    const missing: string[] = [];
    if (!baseUrl) missing.push('URL');
    if (!apiKey) missing.push('TOKEN/APIKEY');
    throw new Error(
      t(
        'Claude Code config is missing required field(s): {0}',
        missing.join(', '),
      ),
    );
  }

  const providerForMatching: ProviderConfig = {
    type: 'anthropic',
    name: 'Claude Code',
    baseUrl,
    auth: {
      method: 'api-key',
      apiKey,
    },
    models: [],
  };

  const provider: Partial<ProviderConfig> = {
    ...providerForMatching,
    models: getClaudeCodeDefaultModels(providerForMatching),
  };

  return { provider };
}

function getClaudeCodeConfigPaths(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.claude', 'settings.local.json'),
    path.join(home, '.claude.json'),
  ];
}

export async function detectAllConfigFiles(): Promise<string[]> {
  const candidates = getClaudeCodeConfigPaths();
  const existing: string[] = [];
  for (const candidate of candidates) {
    if (await isExistingFile(candidate)) {
      existing.push(candidate);
    }
  }
  return existing;
}

export const claudeCodeMigrationSource: ProviderMigrationSource = {
  id: 'claude-code',
  displayName: 'Claude Code',
  async detectConfigFile(): Promise<string | undefined> {
    const candidates = getClaudeCodeConfigPaths();
    return firstExistingFilePath(candidates);
  },
  async importFromConfigContent(
    content: string,
  ): Promise<readonly ProviderMigrationCandidate[]> {
    migrationLog.info('claude-code', 'Parsing config content');
    const settings = extractClaudeCodeSettings(content);
    migrationLog.info('claude-code', 'Extracted settings', {
      authMethod: settings.authMethod,
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey ? '***' : undefined,
      oauthEmail: settings.oauthEmail,
    });
    const candidate = buildClaudeCodeProvider(settings);
    migrationLog.info('claude-code', 'Built provider candidate', {
      type: candidate.provider.type,
      name: candidate.provider.name,
      baseUrl: candidate.provider.baseUrl,
      modelsCount: candidate.provider.models?.length,
    });
    return [candidate];
  },
};
