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
  'https://daily-cloudcode-pa.googleapis.com',
] as const;

/**
 * HTTP Headers for Gemini CLI API requests.
 * These mimic the official gemini-cli behavior.
 */
export const GEMINI_CLI_API_HEADERS = {
  'User-Agent': 'google-api-nodejs-client/10.3.0',
  'X-Goog-Api-Client': 'gl-node/22.18.0',
  'Client-Metadata':
    'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI',
} as const;

/**
 * Randomized header pools for Gemini CLI API requests.
 * Used to vary headers slightly across requests.
 */
export const GEMINI_CLI_API_HEADERS_POOL = {
  'User-Agent': [
    'google-api-nodejs-client/10.3.0',
    'google-api-nodejs-client/9.15.1',
    'google-api-nodejs-client/9.14.0',
    'google-api-nodejs-client/9.13.0',
  ],
  'X-Goog-Api-Client': [
    'gl-node/22.18.0',
    'gl-node/22.17.0',
    'gl-node/22.12.0',
    'gl-node/20.18.0',
    'gl-node/21.7.0',
  ],
  'Client-Metadata': [GEMINI_CLI_API_HEADERS['Client-Metadata']],
} as const;

export type GeminiCliApiHeaderSet = {
  'User-Agent': string;
  'X-Goog-Api-Client': string;
  'Client-Metadata': string;
};

function randomFrom<const T>(values: readonly T[]): T {
  const first = values.at(0);
  if (first === undefined) {
    throw new Error('Cannot sample from an empty array');
  }
  const idx = Math.floor(Math.random() * values.length);
  const selected = values[idx];
  return selected === undefined ? first : selected;
}

/**
 * Get randomized headers for Gemini CLI API requests.
 */
export function getGeminiCliRandomizedHeaders(): GeminiCliApiHeaderSet {
  return {
    'User-Agent': randomFrom(GEMINI_CLI_API_HEADERS_POOL['User-Agent']),
    'X-Goog-Api-Client': randomFrom(GEMINI_CLI_API_HEADERS_POOL['X-Goog-Api-Client']),
    'Client-Metadata': GEMINI_CLI_API_HEADERS['Client-Metadata'],
  };
}

/**
 * OAuth endpoints for Google.
 */
export const GOOGLE_OAUTH_AUTH_URL =
  'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_USERINFO_URL =
  'https://www.googleapis.com/oauth2/v1/userinfo?alt=json';
