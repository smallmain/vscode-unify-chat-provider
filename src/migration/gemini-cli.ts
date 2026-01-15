import * as os from 'os';
import * as path from 'path';
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

const GEMINI_CLI_DEFAULT_MODEL_IDS: WellKnownModelId[] = [
  'gemini-3-pro-preview',
  'gemini-3-flash-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
] as const;

function getGeminiCliDefaultModels(): ModelConfig[] {
  const models: ModelConfig[] = [];
  for (const id of GEMINI_CLI_DEFAULT_MODEL_IDS) {
    const model = WELL_KNOWN_MODELS.find((m) => m.id === id);
    if (!model) {
      throw new Error(t('Well-known model not found: {0}', id));
    }
    const { alternativeIds: _alternativeIds, ...withoutAlternativeIds } = model;
    models.push(withoutAlternativeIds);
  }
  return models;
}

function getString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type StringEntry = { key: string; value: string };

function collectStringEntries(
  value: unknown,
  out: StringEntry[],
  options: { maxDepth: number },
  depth = 0,
  seen = new Set<object>(),
): void {
  if (depth > options.maxDepth) return;

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringEntries(item, out, options, depth + 1, seen);
    }
    return;
  }

  if (!isObjectRecord(value)) return;
  if (seen.has(value)) return;
  seen.add(value);

  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === 'string') {
      out.push({ key, value: nested });
      continue;
    }
    collectStringEntries(nested, out, options, depth + 1, seen);
  }
}

function tryParseJson(content: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed;
  } catch {
    return undefined;
  }
}

function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const trimmedLine = rawLine.trim();
    if (!trimmedLine) continue;
    if (trimmedLine.startsWith('#')) continue;
    if (trimmedLine.startsWith('//')) continue;

    const line = trimmedLine.startsWith('export ')
      ? trimmedLine.slice('export '.length).trim()
      : trimmedLine;

    const equalsIndex = line.indexOf('=');
    if (equalsIndex <= 0) continue;

    const rawKey = line.slice(0, equalsIndex).trim();
    if (!rawKey) continue;

    const normalizedKey = rawKey.toUpperCase();
    const rawValue = line.slice(equalsIndex + 1).trim();
    if (!rawValue) continue;

    let value = rawValue;
    const firstChar = value[0];
    if (firstChar === '"' || firstChar === "'") {
      const quote = firstChar;
      let endIndex = -1;
      for (let i = 1; i < value.length; i++) {
        const ch = value[i];
        if (ch === quote && value[i - 1] !== '\\') {
          endIndex = i;
          break;
        }
      }
      if (endIndex > 0) {
        value = value.slice(1, endIndex);
      } else {
        value = value.slice(1);
      }
    } else {
      const hashIndex = value.indexOf('#');
      if (hashIndex >= 0) {
        value = value.slice(0, hashIndex).trim();
      }
    }

    const finalValue = value.trim();
    if (!finalValue) continue;
    result[normalizedKey] = finalValue;
  }

  return result;
}

function extractGeminiCliEnv(content: string): Record<string, string> {
  const entries: StringEntry[] = [];

  const json = tryParseJson(content.trim());
  if (json !== undefined) {
    collectStringEntries(json, entries, { maxDepth: 12 });
  }

  for (const [key, value] of Object.entries(parseDotEnv(content))) {
    entries.push({ key, value });
  }

  const relevantEnvKeys = [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_PROJECT_ID',
    'GOOGLE_CLOUD_LOCATION',
    'GOOGLE_GENAI_USE_VERTEXAI',
  ] as const;

  for (const key of relevantEnvKeys) {
    const fromProcessEnv = getString(process.env[key]);
    if (fromProcessEnv) {
      entries.push({ key, value: fromProcessEnv });
    }
  }

  const out: Record<string, string> = {};
  for (const entry of entries) {
    const key = entry.key.trim().toUpperCase();
    const value = entry.value.trim();
    if (!key || !value) continue;
    if (!(key in out)) {
      out[key] = value;
    }
  }

  return out;
}

function buildGeminiCliProvider(
  env: Record<string, string>,
): ProviderMigrationCandidate {
  const geminiApiKey = getString(env['GEMINI_API_KEY']);
  const googleApiKey = getString(env['GOOGLE_API_KEY']);
  const applicationCredentials = getString(
    env['GOOGLE_APPLICATION_CREDENTIALS'],
  );
  const project =
    getString(env['GOOGLE_CLOUD_PROJECT']) ??
    getString(env['GOOGLE_CLOUD_PROJECT_ID']);
  const location = getString(env['GOOGLE_CLOUD_LOCATION']);
  const useVertexFromEnv =
    getString(env['GOOGLE_GENAI_USE_VERTEXAI'])?.toLowerCase() === 'true';

  const enabledAuthMethods = [
    geminiApiKey ? 'gemini-api-key' : undefined,
    googleApiKey ? 'google-cloud-api-key' : undefined,
    applicationCredentials ? 'service-account-json' : undefined,
  ].filter((value): value is string => value !== undefined);

  if (enabledAuthMethods.length > 1) {
    throw new Error(
      t(
        'Gemini CLI config has multiple authentication variables set ({0}). Keep only one of GEMINI_API_KEY, GOOGLE_API_KEY, or GOOGLE_APPLICATION_CREDENTIALS.',
        enabledAuthMethods.join(', '),
      ),
    );
  }

  if (applicationCredentials) {
    if (!project || !location) {
      const missing: string[] = [];
      if (!project) missing.push('GOOGLE_CLOUD_PROJECT');
      if (!location) missing.push('GOOGLE_CLOUD_LOCATION');
      throw new Error(
        t(
          'Vertex AI (service account JSON key) is missing required env var(s): {0}.',
          missing.join(', '),
        ),
      );
    }

    const provider: Partial<ProviderConfig> = {
      type: 'google-vertex-ai',
      name: 'Gemini CLI',
      baseUrl: `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}`,
      auth: {
        method: 'api-key',
        apiKey: applicationCredentials,
      },
      models: getGeminiCliDefaultModels(),
    };

    return { provider };
  }

  if (googleApiKey) {
    const provider: Partial<ProviderConfig> = {
      type: 'google-vertex-ai',
      name: 'Gemini CLI',
      baseUrl: 'https://aiplatform.googleapis.com',
      auth: {
        method: 'api-key',
        apiKey: googleApiKey,
      },
      models: getGeminiCliDefaultModels(),
    };
    return { provider };
  }

  if (geminiApiKey) {
    const provider: Partial<ProviderConfig> = {
      type: 'google-ai-studio',
      name: 'Gemini CLI',
      baseUrl: 'https://generativelanguage.googleapis.com',
      auth: {
        method: 'api-key',
        apiKey: geminiApiKey,
      },
      models: getGeminiCliDefaultModels(),
    };
    return { provider };
  }

  if (project || location || useVertexFromEnv) {
    throw new Error(
      t(
        'Gemini CLI appears to be configured for Vertex AI without API keys (ADC / Login with Google). This migration only supports GEMINI_API_KEY, GOOGLE_API_KEY, or GOOGLE_APPLICATION_CREDENTIALS.',
      ),
    );
  }

  throw new Error(
    t(
      'No supported Gemini CLI authentication variables found. Set one of GEMINI_API_KEY (Gemini API key), GOOGLE_API_KEY (Google Cloud API key), or GOOGLE_APPLICATION_CREDENTIALS (Vertex service account JSON key).',
    ),
  );
}

export const geminiCliMigrationSource: ProviderMigrationSource = {
  id: 'gemini-cli',
  displayName: 'Gemini CLI',
  async detectConfigFile(): Promise<string | undefined> {
    const envCandidates = [
      process.env.GEMINI_CLI_ENV_PATH,
      process.env.GEMINI_DOTENV_PATH,
      process.env.GEMINI_ENV_PATH,
      process.env.GEMINI_CONFIG_PATH,
    ]
      .filter(
        (value): value is string =>
          typeof value === 'string' && value.trim().length > 0,
      )
      .map((value) => normalizeConfigFilePathInput(value));

    const home = os.homedir();
    const candidates: string[] = [
      ...envCandidates,
      path.join(home, '.gemini', '.env'),
      path.join(home, '.env'),
      path.join(process.cwd(), '.gemini', '.env'),
      path.join(process.cwd(), '.env'),
    ];

    return firstExistingFilePath(candidates);
  },
  async importFromConfigContent(
    content: string,
  ): Promise<readonly ProviderMigrationCandidate[]> {
    const env = extractGeminiCliEnv(content);
    return [buildGeminiCliProvider(env)];
  },
};
