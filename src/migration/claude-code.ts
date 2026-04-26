import * as os from 'os';
import * as path from 'path';
import type {
  ProviderMigrationCandidate,
  ProviderMigrationSource,
} from './types';
import { ClaudeCodeOAuthDetectedError } from './errors';
import { firstExistingFilePath, isExistingFile } from './fs-utils';
import {
  WELL_KNOWN_PROVIDERS,
  resolveProviderModels,
} from '../well-known/providers';
import type { ProviderConfig } from '../types';
import { migrationLog } from '../logger';
import {
  extractQueryParamsFromUrlInput,
  normalizeBaseUrlInput,
} from '../utils';

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
  settings: ClaudeCodeSettings,
): ProviderMigrationCandidate {
  if (settings.authMethod === 'oauth') {
    throw new ClaudeCodeOAuthDetectedError(settings.oauthEmail);
  }

  const claudeCodeWellKnown = WELL_KNOWN_PROVIDERS.find(
    (p) => p.type === 'claude-code',
  );

  if (!claudeCodeWellKnown) {
    throw new Error('Claude Code provider not found in well-known providers');
  }

  const rawBaseUrl = settings.baseUrl ?? claudeCodeWellKnown.baseUrl;
  const baseUrl = normalizeBaseUrlInput(rawBaseUrl);
  const queryParams = extractQueryParamsFromUrlInput(rawBaseUrl);
  const models = resolveProviderModels(claudeCodeWellKnown);

  const provider: Partial<ProviderConfig> = {
    type: 'claude-code',
    name: claudeCodeWellKnown.name,
    baseUrl,
    models,
    ...(queryParams ? { queryParams } : {}),
  };

  if (settings.authMethod === 'api-key' && settings.apiKey) {
    provider.auth = {
      method: 'api-key',
      apiKey: settings.apiKey,
    };
  }

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
