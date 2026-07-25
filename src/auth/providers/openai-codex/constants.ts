export const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const OPENAI_CODEX_ISSUER = 'https://auth.openai.com';

export const OPENAI_CODEX_CALLBACK_PORT = 1455;
export const OPENAI_CODEX_REDIRECT_PATH = '/auth/callback';
export const OPENAI_CODEX_REDIRECT_URI = `http://localhost:${OPENAI_CODEX_CALLBACK_PORT}${OPENAI_CODEX_REDIRECT_PATH}`;

// Align with CLIProxyAPI internal/auth/codex/openai_auth.go GenerateAuthURL.
export const OPENAI_CODEX_SCOPE = 'openid email profile offline_access';
export const OPENAI_CODEX_REFRESH_SCOPE = 'openid profile email';

export const OPENAI_CODEX_API_ENDPOINT =
  'https://chatgpt.com/backend-api/codex/responses';
