/**
 * PKCE challenge data
 */
export interface PKCEChallenge {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

/**
 * OAuth 2.0 authorization state
 */
export interface OAuth2AuthState {
  state: string;
  pkce?: PKCEChallenge;
  redirectUri: string;
}

/**
 * Device code response
 */
export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

/**
 * Token response from OAuth server
 */
export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}
