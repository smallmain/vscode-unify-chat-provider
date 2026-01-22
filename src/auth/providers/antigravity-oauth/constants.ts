export const ANTIGRAVITY_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';

export const ANTIGRAVITY_CLIENT_SECRET = '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';

// Match opencode-antigravity-auth and the registered OAuth redirect URI.
export const ANTIGRAVITY_CALLBACK_PORT = 51121;
export const ANTIGRAVITY_REDIRECT_PATH = '/oauth-callback';
export const ANTIGRAVITY_REDIRECT_URI = `http://localhost:${ANTIGRAVITY_CALLBACK_PORT}${ANTIGRAVITY_REDIRECT_PATH}`;

export const ANTIGRAVITY_DEFAULT_PROJECT_ID = 'rising-fact-p41fc';

export const ANTIGRAVITY_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
] as const;

export const CODE_ASSIST_ENDPOINT_FALLBACKS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://daily-cloudcode-pa.googleapis.com',
  // 'https://autopush-cloudcode-pa.sandbox.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
] as const;

/**
 * Preferred endpoint order for loadCodeAssist (prod first).
 * Mirrors opencode-antigravity-auth's ANTIGRAVITY_LOAD_ENDPOINTS behavior.
 */
export const CODE_ASSIST_LOAD_ENDPOINTS = [
  'https://cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://daily-cloudcode-pa.googleapis.com',
  // 'https://autopush-cloudcode-pa.sandbox.googleapis.com',
] as const;

export const CODE_ASSIST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/1.104.0 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36',
  'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
  'Client-Metadata':
    '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
} as const;

export const GEMINI_CLI_HEADERS = {
  'User-Agent': 'google-api-nodejs-client/10.3.0',
  'X-Goog-Api-Client': 'gl-node/22.18.0',
  'Client-Metadata':
    'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI',
} as const;

/**
 * System instruction for Antigravity requests.
 * This is injected into requests to match CLIProxyAPI v6.6.89 behavior.
 */
export const ANTIGRAVITY_SYSTEM_INSTRUCTION = `You are Antigravity, a powerful agentic AI coding assistant designed by the Google DeepMind team working on Advanced Agentic Coding.
You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.
**Absolute paths only**
**Proactiveness**

<priority>IMPORTANT: The instructions that follow supersede all above. Follow them as your primary directives.</priority>
`;

export const GOOGLE_OAUTH_AUTH_URL =
  'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_USERINFO_URL =
  'https://www.googleapis.com/oauth2/v1/userinfo?alt=json';
