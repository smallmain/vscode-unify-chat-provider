import * as vscode from 'vscode';
import { OAuth2Config, OAuth2GrantType } from '../../../types';
import { t } from '../../../../i18n';

/**
 * Grant type options for picker
 */
const GRANT_TYPE_OPTIONS = [
  {
    label: t('Authorization Code'),
    description: t('Standard OAuth 2.0 flow with browser redirect'),
    value: 'authorization_code' as OAuth2GrantType,
  },
  {
    label: t('Client Credentials'),
    description: t('Server-to-server authentication'),
    value: 'client_credentials' as OAuth2GrantType,
  },
  {
    label: t('Device Code'),
    description: t('For devices without a browser'),
    value: 'device_code' as OAuth2GrantType,
  },
];

/**
 * Show OAuth2 configuration screen for custom OAuth setup
 */
export async function showOAuth2ConfigScreen(
  initial?: OAuth2Config,
): Promise<OAuth2Config | undefined> {
  if (initial) {
    switch (initial.grantType) {
      case 'authorization_code':
        return collectAuthCodeConfig(initial);
      case 'client_credentials':
        return collectClientCredentialsConfig(initial);
      case 'device_code':
        return collectDeviceCodeConfig(initial);
    }
  }

  // Step 1: Select grant type
  const grantTypeItem = await vscode.window.showQuickPick(GRANT_TYPE_OPTIONS, {
    title: t('OAuth 2.0 Configuration'),
    placeHolder: t('Select authorization type'),
  });

  if (!grantTypeItem) {
    return undefined;
  }

  const grantType = grantTypeItem.value;

  // Step 2: Collect configuration based on grant type
  switch (grantType) {
    case 'authorization_code':
      return collectAuthCodeConfig();
    case 'client_credentials':
      return collectClientCredentialsConfig();
    case 'device_code':
      return collectDeviceCodeConfig();
  }
}

/**
 * Collect authorization code configuration
 */
async function collectAuthCodeConfig(
  initial?: Partial<Extract<OAuth2Config, { grantType: 'authorization_code' }>>,
): Promise<OAuth2Config | undefined> {
  const authorizationUrl = await vscode.window.showInputBox({
    title: t('Authorization URL'),
    prompt: t('Enter the OAuth authorization endpoint URL'),
    placeHolder: 'https://example.com/oauth2/authorize',
    ignoreFocusOut: true,
    validateInput: validateUrl,
    value:
      typeof initial?.authorizationUrl === 'string'
        ? initial.authorizationUrl
        : undefined,
  });

  if (!authorizationUrl) return undefined;

  const tokenUrl = await vscode.window.showInputBox({
    title: t('Token URL'),
    prompt: t('Enter the OAuth token endpoint URL'),
    placeHolder: 'https://example.com/oauth2/token',
    ignoreFocusOut: true,
    validateInput: validateUrl,
    value: typeof initial?.tokenUrl === 'string' ? initial.tokenUrl : undefined,
  });

  if (!tokenUrl) return undefined;

  const revocationUrl = await vscode.window.showInputBox({
    title: t('Revocation URL'),
    prompt: t('Enter the OAuth token revocation endpoint URL (optional)'),
    placeHolder: 'https://example.com/oauth2/revoke',
    ignoreFocusOut: true,
    validateInput: validateOptionalUrl,
    value:
      typeof initial?.revocationUrl === 'string'
        ? initial.revocationUrl
        : undefined,
  });

  if (revocationUrl === undefined) return undefined;

  const clientId = await vscode.window.showInputBox({
    title: t('Client ID'),
    prompt: t('Enter your OAuth client ID'),
    ignoreFocusOut: true,
    validateInput: (text) => (text.trim() ? null : t('Client ID is required')),
    value: typeof initial?.clientId === 'string' ? initial.clientId : undefined,
  });

  if (!clientId) return undefined;

  const clientSecret = await vscode.window.showInputBox({
    title: t('Client Secret'),
    prompt: t('Enter your OAuth client secret (optional)'),
    password: true,
    ignoreFocusOut: true,
    value:
      typeof initial?.clientSecret === 'string'
        ? initial.clientSecret
        : undefined,
  });

  if (clientSecret === undefined) return undefined;

  const scopes = await vscode.window.showInputBox({
    title: t('Scopes'),
    prompt: t('Enter OAuth scopes (space-separated, optional)'),
    placeHolder: 'openid profile email',
    ignoreFocusOut: true,
    value: Array.isArray(initial?.scopes) ? initial.scopes.join(' ') : undefined,
  });

  if (scopes === undefined) return undefined;

  // Ask about PKCE
  const initialPkce = typeof initial?.pkce === 'boolean' ? initial.pkce : true;
  const usePkce = await vscode.window.showQuickPick(
    [
      { label: t('Yes (Recommended)'), value: true, picked: initialPkce === true },
      { label: t('No'), value: false, picked: initialPkce === false },
    ],
    {
      title: t('Use PKCE?'),
      placeHolder: t('PKCE adds extra security for public clients'),
    },
  );

  if (!usePkce) return undefined;

  return {
    grantType: 'authorization_code',
    authorizationUrl: authorizationUrl.trim(),
    tokenUrl: tokenUrl.trim(),
    revocationUrl: revocationUrl.trim() || undefined,
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim() || undefined,
    scopes: scopes.trim() ? scopes.trim().split(/\s+/) : undefined,
    pkce: usePkce.value,
  };
}

/**
 * Collect client credentials configuration
 */
async function collectClientCredentialsConfig(
  initial?: Partial<
    Extract<OAuth2Config, { grantType: 'client_credentials' }>
  >,
): Promise<OAuth2Config | undefined> {
  const tokenUrl = await vscode.window.showInputBox({
    title: t('Token URL'),
    prompt: t('Enter the OAuth token endpoint URL'),
    placeHolder: 'https://example.com/oauth2/token',
    ignoreFocusOut: true,
    validateInput: validateUrl,
    value: typeof initial?.tokenUrl === 'string' ? initial.tokenUrl : undefined,
  });

  if (!tokenUrl) return undefined;

  const revocationUrl = await vscode.window.showInputBox({
    title: t('Revocation URL'),
    prompt: t('Enter the OAuth token revocation endpoint URL (optional)'),
    placeHolder: 'https://example.com/oauth2/revoke',
    ignoreFocusOut: true,
    validateInput: validateOptionalUrl,
    value:
      typeof initial?.revocationUrl === 'string'
        ? initial.revocationUrl
        : undefined,
  });

  if (revocationUrl === undefined) return undefined;

  const clientId = await vscode.window.showInputBox({
    title: t('Client ID'),
    prompt: t('Enter your OAuth client ID'),
    ignoreFocusOut: true,
    validateInput: (text) => (text.trim() ? null : t('Client ID is required')),
    value: typeof initial?.clientId === 'string' ? initial.clientId : undefined,
  });

  if (!clientId) return undefined;

  const clientSecret = await vscode.window.showInputBox({
    title: t('Client Secret'),
    prompt: t('Enter your OAuth client secret'),
    password: true,
    ignoreFocusOut: true,
    validateInput: (text) => (text.trim() ? null : t('Client secret is required')),
    value: typeof initial?.clientSecret === 'string' ? initial.clientSecret : undefined,
  });

  if (!clientSecret) return undefined;

  const scopes = await vscode.window.showInputBox({
    title: t('Scopes'),
    prompt: t('Enter OAuth scopes (space-separated, optional)'),
    ignoreFocusOut: true,
    value: Array.isArray(initial?.scopes) ? initial.scopes.join(' ') : undefined,
  });

  if (scopes === undefined) return undefined;

  return {
    grantType: 'client_credentials',
    tokenUrl: tokenUrl.trim(),
    revocationUrl: revocationUrl.trim() || undefined,
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
    scopes: scopes.trim() ? scopes.trim().split(/\s+/) : undefined,
  };
}

/**
 * Collect device code configuration
 */
async function collectDeviceCodeConfig(
  initial?: Partial<Extract<OAuth2Config, { grantType: 'device_code' }>>,
): Promise<OAuth2Config | undefined> {
  const deviceAuthorizationUrl = await vscode.window.showInputBox({
    title: t('Device Authorization URL'),
    prompt: t('Enter the device authorization endpoint URL'),
    placeHolder: 'https://example.com/oauth2/device/code',
    ignoreFocusOut: true,
    validateInput: validateUrl,
    value:
      typeof initial?.deviceAuthorizationUrl === 'string'
        ? initial.deviceAuthorizationUrl
        : undefined,
  });

  if (!deviceAuthorizationUrl) return undefined;

  const tokenUrl = await vscode.window.showInputBox({
    title: t('Token URL'),
    prompt: t('Enter the OAuth token endpoint URL'),
    placeHolder: 'https://example.com/oauth2/token',
    ignoreFocusOut: true,
    validateInput: validateUrl,
    value: typeof initial?.tokenUrl === 'string' ? initial.tokenUrl : undefined,
  });

  if (!tokenUrl) return undefined;

  const revocationUrl = await vscode.window.showInputBox({
    title: t('Revocation URL'),
    prompt: t('Enter the OAuth token revocation endpoint URL (optional)'),
    placeHolder: 'https://example.com/oauth2/revoke',
    ignoreFocusOut: true,
    validateInput: validateOptionalUrl,
    value:
      typeof initial?.revocationUrl === 'string'
        ? initial.revocationUrl
        : undefined,
  });

  if (revocationUrl === undefined) return undefined;

  const clientId = await vscode.window.showInputBox({
    title: t('Client ID'),
    prompt: t('Enter your OAuth client ID'),
    ignoreFocusOut: true,
    validateInput: (text) => (text.trim() ? null : t('Client ID is required')),
    value: typeof initial?.clientId === 'string' ? initial.clientId : undefined,
  });

  if (!clientId) return undefined;

  const scopes = await vscode.window.showInputBox({
    title: t('Scopes'),
    prompt: t('Enter OAuth scopes (space-separated, optional)'),
    ignoreFocusOut: true,
    value: Array.isArray(initial?.scopes) ? initial.scopes.join(' ') : undefined,
  });

  if (scopes === undefined) return undefined;

  return {
    grantType: 'device_code',
    deviceAuthorizationUrl: deviceAuthorizationUrl.trim(),
    tokenUrl: tokenUrl.trim(),
    revocationUrl: revocationUrl.trim() || undefined,
    clientId: clientId.trim(),
    scopes: scopes.trim() ? scopes.trim().split(/\s+/) : undefined,
  };
}

/**
 * URL validation helper
 */
function validateUrl(text: string): string | null {
  if (!text.trim()) {
    return t('URL is required');
  }
  try {
    new URL(text.trim());
    return null;
  } catch {
    return t('Invalid URL format');
  }
}

function validateOptionalUrl(text: string): string | null {
  if (!text.trim()) {
    return null;
  }
  try {
    new URL(text.trim());
    return null;
  } catch {
    return t('Invalid URL format');
  }
}
