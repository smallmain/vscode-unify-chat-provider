/**
 * Types for Gemini CLI OAuth authentication.
 */

export type GeminiCliTier = 'free' | 'paid';

/**
 * State encoded in the OAuth authorization URL.
 */
export interface GeminiCliAuthState {
  /** PKCE code verifier */
  verifier: string;
  /** Redirect URI used for this authorization */
  redirectUri: string;
}

/**
 * Authorization URL and related data.
 */
export interface GeminiCliAuthorization {
  /** Full authorization URL to open in browser */
  url: string;
  /** PKCE code verifier (to be stored for token exchange) */
  verifier: string;
  /** Redirect URI used for this authorization */
  redirectUri: string;
}

/**
 * Result of token exchange.
 */
export type GeminiCliTokenExchangeResult =
  | {
      type: 'success';
      accessToken: string;
      refreshToken: string;
      expiresAt?: number;
      email?: string;
    }
  | {
      type: 'failed';
      error: string;
    };

/**
 * Account information retrieved after authentication.
 */
export interface GeminiCliAccountInfo {
  tier: GeminiCliTier;
  tierId?: string;
  managedProjectId?: string;
}
