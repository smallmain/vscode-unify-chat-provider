/**
 * Constants for Gemini CLI OAuth authentication.
 *
 * These constants are derived from the official Google Gemini CLI project:
 * https://github.com/google-gemini/gemini-cli
 *
 * The Client ID and Secret are publicly embedded in the gemini-cli source code
 * and are intended for use with Google's OAuth system for the Gemini CLI.
 */

export const GEMINI_CLI_CLIENT_ID =
  '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';

export const GEMINI_CLI_CLIENT_SECRET = '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';

export const GEMINI_CLI_REDIRECT_PATH = '/oauth-callback';

/**
 * OAuth scopes required for Gemini CLI.
 * These are the minimal scopes needed for Code Assist API access.
 */
export const GEMINI_CLI_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
] as const;

export const GEMINI_CLI_AI_STUDIO_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/generative-language.retriever',
] as const;

export type GeminiCliOAuthType = 'code_assist' | 'ai_studio' | 'google_one';

export function normalizeGeminiCliOAuthType(
  oauthType: string | undefined,
): GeminiCliOAuthType {
  if (oauthType === 'ai_studio' || oauthType === 'google_one') {
    return oauthType;
  }
  return 'code_assist';
}

export function getGeminiCliOAuthScopes(
  oauthType: string | undefined,
): readonly string[] {
  const normalized = normalizeGeminiCliOAuthType(oauthType);
  if (normalized === 'ai_studio') {
    return GEMINI_CLI_AI_STUDIO_SCOPES;
  }
  return GEMINI_CLI_SCOPES;
}

/**
 * Default project ID for Gemini CLI.
 * This is used when no specific project is provided.
 */
export const GEMINI_CLI_DEFAULT_PROJECT_ID = 'gemini-cli-project';

/**
 * Code Assist API endpoints for Gemini CLI.
 */
export const GEMINI_CLI_ENDPOINT = 'https://cloudcode-pa.googleapis.com';

export const GEMINI_CLI_ENDPOINT_FALLBACKS = [
  'https://cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://autopush-cloudcode-pa.sandbox.googleapis.com',
  'https://daily-cloudcode-pa.googleapis.com',
] as const;

/**
 * HTTP Headers for Gemini CLI API requests.
 * These mimic the official gemini-cli behavior.
 */
export const GEMINI_CLI_API_HEADERS = {
  'User-Agent': 'GeminiCLI/0.1.5 (Windows; AMD64)',
  'X-Goog-Api-Client': 'gl-node/22.18.0',
  'Client-Metadata':
    'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI',
} as const;

/**
 * Headers used for Code Assist account provisioning endpoints (loadCodeAssist/onboardUser).
 *
 * Empirically, these endpoints are more reliable with Cloud SDK-style headers and
 * JSON client metadata, even for Gemini CLI OAuth.
 */
export const GEMINI_CLI_CODE_ASSIST_PROVISION_HEADERS = {
  'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
  'Client-Metadata': JSON.stringify({
    ideType: 'IDE_UNSPECIFIED',
    platform: 'PLATFORM_UNSPECIFIED',
    pluginType: 'GEMINI',
  }),
} as const;

export type GeminiCliApiHeaderSet = {
  'User-Agent': string;
  'X-Goog-Api-Client': string;
  'Client-Metadata': string;
};

/**
 * Get fixed Gemini CLI API headers.
 */
export function getGeminiCliRandomizedHeaders(): GeminiCliApiHeaderSet {
  return {
    'User-Agent': GEMINI_CLI_API_HEADERS['User-Agent'],
    'X-Goog-Api-Client': GEMINI_CLI_API_HEADERS['X-Goog-Api-Client'],
    'Client-Metadata': GEMINI_CLI_API_HEADERS['Client-Metadata'],
  };
}

export function buildGeminiCliCodeAssistMetadata(
  projectId?: string,
): Record<string, string> {
  const metadata: Record<string, string> = {
    ideType: 'IDE_UNSPECIFIED',
    platform: 'PLATFORM_UNSPECIFIED',
    pluginType: 'GEMINI',
  };

  const trimmed = projectId?.trim();
  if (trimmed) {
    metadata['duetProject'] = trimmed;
  }

  return metadata;
}

/**
 * OAuth endpoints for Google.
 */
export const GOOGLE_OAUTH_AUTH_URL =
  'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_USERINFO_URL =
  'https://www.googleapis.com/oauth2/v1/userinfo?alt=json';
