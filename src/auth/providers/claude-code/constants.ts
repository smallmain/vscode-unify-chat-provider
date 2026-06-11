export const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const CLAUDE_CODE_AUTH_URL = 'https://claude.ai/oauth/authorize';
export const CLAUDE_CODE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

export const CLAUDE_CODE_CALLBACK_PORT = 54545;
export const CLAUDE_CODE_REDIRECT_PATH = '/callback';
export const CLAUDE_CODE_REDIRECT_URI = `http://localhost:${CLAUDE_CODE_CALLBACK_PORT}${CLAUDE_CODE_REDIRECT_PATH}`;

export const CLAUDE_CODE_SCOPE =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
