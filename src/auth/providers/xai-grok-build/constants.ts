export const XAI_GROK_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';

export const XAI_OAUTH_ISSUER = 'https://auth.x.ai';
export const XAI_GROK_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
export const XAI_GROK_OAUTH_AUTHORIZE_URL = `${XAI_OAUTH_ISSUER}/oauth2/authorize`;
export const XAI_GROK_OAUTH_TOKEN_URL = `${XAI_OAUTH_ISSUER}/oauth2/token`; // Fallback; prefer discovery

export const XAI_GROK_OAUTH_CALLBACK_PORT = 56121;
export const XAI_GROK_OAUTH_REDIRECT_PATH = '/callback';
// IMPORTANT: Must be exactly 127.0.0.1 (IPv4 loopback). xAI's public client registration
// (used by Hermes, this extension, and similar tools) only allows this form.
// Using "localhost" will be rejected with "redirect_uri does not match any registered URI".
export const XAI_GROK_OAUTH_REDIRECT_URI = `http://127.0.0.1:${XAI_GROK_OAUTH_CALLBACK_PORT}${XAI_GROK_OAUTH_REDIRECT_PATH}`;

export const XAI_GROK_OAUTH_SCOPE =
  'openid profile email offline_access grok-cli:access api:access';

// Referrer used by Hermes / OpenCode compatible flows for the public desktop client.
export const XAI_GROK_OAUTH_REFERRER = 'hermes-agent';
export const XAI_GROK_OAUTH_PLAN = 'generic';

// Buffer before expiry to trigger proactive refresh (2 minutes, matching common practice for these flows).
export const XAI_GROK_OAUTH_EXPIRY_SKEW_MS = 2 * 60 * 1000;

// --- CLIProxyAPI / Grok Build Chat-Proxy constants ---
// These match the reference implementation in CLIProxyAPI's internal/auth/xai/types.go
// and internal/runtime/executor/xai_executor.go.

/** Default xAI API base URL (used for WebSocket and non-OAuth HTTP). */
export const XAI_DEFAULT_API_BASE_URL = 'https://api.x.ai/v1';

/** CLI chat-proxy base URL used by Grok Build for OAuth-authenticated HTTP chat requests. */
export const XAI_CLI_CHAT_PROXY_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';

/** Token auth header name used to identify as a Grok CLI client to chat-proxy. */
export const XAI_TOKEN_AUTH_HEADER = 'X-XAI-Token-Auth';

/** Token auth header value — must match what the Grok CLI sends. */
export const XAI_TOKEN_AUTH_VALUE = 'xai-grok-cli';

/** Client version header name sent to chat-proxy. */
export const XAI_CLIENT_VERSION_HEADER = 'x-grok-client-version';

/** Client version value — keep in sync with the current Grok CLI client version. */
export const XAI_CLIENT_VERSION_VALUE = '0.2.93';

/** User-Agent string for chat-proxy requests. */
export const XAI_USER_AGENT = `xai-grok-workspace/${XAI_CLIENT_VERSION_VALUE}`;

/** Conversation ID header sent to chat-proxy and WebSocket. */
export const XAI_CONV_ID_HEADER = 'x-grok-conv-id';
