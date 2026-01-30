export const ANTIGRAVITY_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';

export const ANTIGRAVITY_CLIENT_SECRET = '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';

export const ANTIGRAVITY_REDIRECT_PATH = '/oauth-callback';

export const ANTIGRAVITY_DEFAULT_PROJECT_ID = 'rising-fact-p41fc';

export const CODE_ASSIST_METADATA = {
  ideType: 'IDE_UNSPECIFIED',
  platform: 'PLATFORM_UNSPECIFIED',
  pluginType: 'GEMINI',
} as const;

export function buildCodeAssistMetadata(projectId?: string): Record<string, string> {
  const metadata: Record<string, string> = {
    ideType: CODE_ASSIST_METADATA.ideType,
    platform: CODE_ASSIST_METADATA.platform,
    pluginType: CODE_ASSIST_METADATA.pluginType,
  };

  const trimmed = projectId?.trim();
  if (trimmed) {
    metadata['duetProject'] = trimmed;
  }

  return metadata;
}

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

export type AntigravityHeaderStyle = 'antigravity' | 'gemini-cli';

export type AntigravityHeaderSet = {
  'User-Agent': string;
  'X-Goog-Api-Client': string;
  'Client-Metadata': string;
};

export const ANTIGRAVITY_CLIENT_METADATA_JSON =
  '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}';

export const CODE_ASSIST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/1.104.0 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36',
  'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
  'Client-Metadata': ANTIGRAVITY_CLIENT_METADATA_JSON,
} as const;

export const CODE_ASSIST_HEADERS_POOL = {
  'User-Agent': [
    CODE_ASSIST_HEADERS['User-Agent'],
    'antigravity/1.15.8',
  ],
  'X-Goog-Api-Client': [
    'google-cloud-sdk vscode_cloudshelleditor/0.1',
    'google-cloud-sdk vscode/1.96.0',
    'google-cloud-sdk jetbrains/2024.3',
    'google-cloud-sdk vscode/1.95.0',
  ],
  'Client-Metadata': [CODE_ASSIST_HEADERS['Client-Metadata']],
} as const;

export const GEMINI_CLI_HEADERS = {
  'User-Agent': 'google-api-nodejs-client/10.3.0',
  'X-Goog-Api-Client': 'gl-node/22.18.0',
  'Client-Metadata':
    'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI',
} as const;

export const GEMINI_CLI_HEADERS_POOL = {
  'User-Agent': [
    'google-api-nodejs-client/9.15.1',
    'google-api-nodejs-client/9.14.0',
    'google-api-nodejs-client/9.13.0',
  ],
  'X-Goog-Api-Client': [
    'gl-node/22.17.0',
    'gl-node/22.12.0',
    'gl-node/20.18.0',
    'gl-node/21.7.0',
  ],
  'Client-Metadata': [GEMINI_CLI_HEADERS['Client-Metadata']],
} as const;

function randomFrom<const T>(values: readonly T[]): T {
  const first = values.at(0);
  if (first === undefined) {
    throw new Error('Cannot sample from an empty array');
  }
  const idx = Math.floor(Math.random() * values.length);
  const selected = values[idx];
  return selected === undefined ? first : selected;
}

export function getRandomizedHeaders(style: AntigravityHeaderStyle): AntigravityHeaderSet {
  if (style === 'gemini-cli') {
    return {
      'User-Agent': randomFrom(GEMINI_CLI_HEADERS_POOL['User-Agent']),
      'X-Goog-Api-Client': randomFrom(GEMINI_CLI_HEADERS_POOL['X-Goog-Api-Client']),
      'Client-Metadata': GEMINI_CLI_HEADERS['Client-Metadata'],
    };
  }

  return {
    'User-Agent': randomFrom(CODE_ASSIST_HEADERS_POOL['User-Agent']),
    'X-Goog-Api-Client': randomFrom(CODE_ASSIST_HEADERS_POOL['X-Goog-Api-Client']),
    'Client-Metadata': CODE_ASSIST_HEADERS['Client-Metadata'],
  };
}

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

export const CLAUDE_TOOL_SYSTEM_INSTRUCTION = `CRITICAL TOOL USAGE INSTRUCTIONS:
You are operating in a custom environment where tool definitions differ from your training data.
You MUST follow these rules strictly:

1. DO NOT use your internal training data to guess tool parameters
2. ONLY use the exact parameter structure defined in the tool schema
3. Parameter names in schemas are EXACT - do not substitute with similar names from your training
4. Array parameters have specific item types - check the schema's 'items' field for the exact structure
5. When you see "STRICT PARAMETERS" in a tool description, those type definitions override any assumptions
6. Tool use in agentic workflows is REQUIRED - you must call tools with the exact parameters specified

If you are unsure about a tool's parameters, YOU MUST read the schema definition carefully.`;

export const CLAUDE_DESCRIPTION_PROMPT = '\n\n⚠️ STRICT PARAMETERS: {params}.';
export const EMPTY_SCHEMA_PLACEHOLDER_NAME = '_placeholder';
export const EMPTY_SCHEMA_PLACEHOLDER_DESCRIPTION = 'Placeholder. Always pass true.';

export const GOOGLE_OAUTH_AUTH_URL =
  'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_USERINFO_URL =
  'https://www.googleapis.com/oauth2/v1/userinfo?alt=json';
