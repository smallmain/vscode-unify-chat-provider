export const XAI_GROK_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';

export const XAI_OAUTH_ISSUER = 'https://auth.x.ai';
export const XAI_GROK_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
export const XAI_GROK_OAUTH_AUTHORIZE_URL = `${XAI_OAUTH_ISSUER}/oauth2/authorize`;
export const XAI_GROK_OAUTH_TOKEN_URL = `${XAI_OAUTH_ISSUER}/oauth2/token`; // Fallback; prefer discovery

export const XAI_GROK_OAUTH_CALLBACK_PORT = 56121;
export const XAI_GROK_OAUTH_REDIRECT_PATH = '/callback';
export const XAI_GROK_OAUTH_REDIRECT_URI = `http://127.0.0.1:${XAI_GROK_OAUTH_CALLBACK_PORT}${XAI_GROK_OAUTH_REDIRECT_PATH}`;

export const XAI_GROK_OAUTH_SCOPE =
  'openid profile email offline_access grok-cli:access api:access';

// Referrer used by Hermes / OpenCode compatible flows for the public desktop client.
export const XAI_GROK_OAUTH_REFERRER = 'hermes-agent';
export const XAI_GROK_OAUTH_PLAN = 'generic';

// Buffer before expiry to trigger proactive refresh (2 minutes, matching common practice for these flows).
export const XAI_GROK_OAUTH_EXPIRY_SKEW_MS = 2 * 60 * 1000;
