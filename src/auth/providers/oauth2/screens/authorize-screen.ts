import * as vscode from 'vscode';
import {
  OAuth2AuthCodeConfig,
  OAuth2ClientCredentialsConfig,
  OAuth2Config,
  OAuth2DeviceCodeConfig,
  OAuth2TokenData,
} from '../../../types';
import type { EventedUriHandler } from '../../../../uri-handler';
import {
  buildAuthorizationUrl,
  exchangeCodeForToken,
  generatePKCE,
  generateState,
  getClientCredentialsToken,
  pollDeviceCodeToken,
  startDeviceCodeFlow,
} from '../oauth2-client';
import { OAuth2AuthState } from '../types';
import { t } from '../../../../i18n';

const OAUTH_CALLBACK_PATH = '/oauth/callback';

/**
 * Handle the authorization flow based on grant type
 */
export async function performAuthorization(
  config: OAuth2Config,
  uriHandler: EventedUriHandler | undefined,
): Promise<OAuth2TokenData | undefined> {
  switch (config.grantType) {
    case 'authorization_code':
      return performAuthCodeFlow(config, uriHandler);
    case 'client_credentials':
      return performClientCredentialsFlow(config);
    case 'device_code':
      return performDeviceCodeFlow(config);
  }
}

/**
 * Perform authorization code flow
 */
async function performAuthCodeFlow(
  config: OAuth2AuthCodeConfig,
  uriHandler: EventedUriHandler | undefined,
): Promise<OAuth2TokenData | undefined> {
  if (!uriHandler) {
    vscode.window.showErrorMessage(
      t('URI handler not available for OAuth callback'),
    );
    return undefined;
  }

  // Generate state and PKCE
  const state = generateState();
  const pkce = config.pkce !== false ? generatePKCE() : undefined;
  const redirectUri = config.redirectUri ?? uriHandler.getOAuthRedirectUri(OAUTH_CALLBACK_PATH);

  const authState: OAuth2AuthState = {
    state,
    pkce,
    redirectUri,
  };

  // Build and open authorization URL
  const authUrl = buildAuthorizationUrl(
    { ...config, redirectUri },
    authState,
  );

  const callbackCancellation = new vscode.CancellationTokenSource();
  const codePromise = waitForAuthorizationCode(
    uriHandler,
    state,
    callbackCancellation.token,
  );

  // Open browser
  const opened = await vscode.env.openExternal(vscode.Uri.parse(authUrl));
  if (!opened) {
    callbackCancellation.cancel();
    callbackCancellation.dispose();
    vscode.window.showErrorMessage(t('Failed to open browser for authorization'));
    return undefined;
  }

  // Wait for callback
  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t('Waiting for authorization...'),
        cancellable: true,
      },
      async (progress, token) => {
        progress.report({ message: t('Complete authorization in your browser') });

        const cancelSubscription = token.onCancellationRequested(() => {
          callbackCancellation.cancel();
        });
        try {
          const code = await codePromise;

          if (token.isCancellationRequested) {
            return undefined;
          }

          if (!code) {
            return undefined;
          }

          progress.report({ message: t('Exchanging code for token...') });

          if (token.isCancellationRequested) {
            return undefined;
          }

          // Exchange code for token
          return await exchangeCodeForToken(
            { ...config, redirectUri },
            code,
            authState,
          );
        } finally {
          cancelSubscription.dispose();
        }
      },
    );

    if (result) {
      vscode.window.showInformationMessage(t('Authorization successful!'));
    }

    return result;
  } catch (error) {
    vscode.window.showErrorMessage(
      t('Authorization failed: {0}', (error as Error).message),
    );
    return undefined;
  } finally {
    callbackCancellation.dispose();
  }
}

/**
 * Wait for authorization code from URI callback.
 */
function waitForAuthorizationCode(
  uriHandler: EventedUriHandler,
  expectedState: string,
  cancellationToken: vscode.CancellationToken,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    let done = false;

    let uriSubscription: vscode.Disposable | undefined;
    let cancelSubscription: vscode.Disposable | undefined;

    const cleanup = (): void => {
      if (done) return;
      done = true;
      uriSubscription?.dispose();
      cancelSubscription?.dispose();
    };

    uriSubscription = uriHandler.onDidReceiveUri((uri) => {
      if (uri.path !== OAUTH_CALLBACK_PATH) {
        return;
      }

      const query = new URLSearchParams(uri.query);
      const returnedState = query.get('state');
      if (returnedState !== expectedState) {
        return;
      }

      const error = query.get('error');
      if (error) {
        const description = query.get('error_description');
        cleanup();
        reject(new Error(description ? `${error}: ${description}` : error));
        return;
      }

      const code = query.get('code');
      cleanup();
      resolve(code?.trim() || undefined);
    });

    if (done) {
      uriSubscription.dispose();
      return;
    }

    cancelSubscription = cancellationToken.onCancellationRequested(() => {
      cleanup();
      resolve(undefined);
    });

    if (done) {
      cancelSubscription.dispose();
    }
  });
}

/**
 * Perform client credentials flow
 */
async function performClientCredentialsFlow(
  config: OAuth2ClientCredentialsConfig,
): Promise<OAuth2TokenData | undefined> {
  try {
    const token = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t('Obtaining access token...'),
        cancellable: false,
      },
      async () => {
        return await getClientCredentialsToken(config);
      },
    );

    vscode.window.showInformationMessage(t('Authorization successful!'));
    return token;
  } catch (error) {
    vscode.window.showErrorMessage(
      t('Failed to obtain token: {0}', (error as Error).message),
    );
    return undefined;
  }
}

/**
 * Perform device code flow
 */
async function performDeviceCodeFlow(
  config: OAuth2DeviceCodeConfig,
): Promise<OAuth2TokenData | undefined> {
  try {
    // Start device code flow
    const deviceResponse = await startDeviceCodeFlow(config);

    // Show user the code and verification URL
    const copyAction = t('Copy Code');
    const openAction = t('Open URL');

    const message = t(
      'Enter code {0} at {1}',
      deviceResponse.userCode,
      deviceResponse.verificationUri,
    );

    // Copy code to clipboard
    await vscode.env.clipboard.writeText(deviceResponse.userCode);

    // Show notification and open browser
    vscode.window
      .showInformationMessage(message, copyAction, openAction)
      .then((action) => {
        if (action === copyAction) {
          vscode.env.clipboard.writeText(deviceResponse.userCode);
        } else if (action === openAction) {
          const url = deviceResponse.verificationUriComplete || deviceResponse.verificationUri;
          vscode.env.openExternal(vscode.Uri.parse(url));
        }
      });

    // Open browser automatically
    const url = deviceResponse.verificationUriComplete || deviceResponse.verificationUri;
    await vscode.env.openExternal(vscode.Uri.parse(url));

    // Poll for token
    const token = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t('Waiting for authorization...'),
        cancellable: true,
      },
      async (progress, cancellationToken) => {
        progress.report({
          message: t('Enter code {0} in your browser', deviceResponse.userCode),
        });

        const expiresAt = Date.now() + deviceResponse.expiresIn * 1000;
        let interval = deviceResponse.interval * 1000;

        while (Date.now() < expiresAt) {
          if (cancellationToken.isCancellationRequested) {
            return undefined;
          }

          // Wait before polling
          await new Promise((resolve) => setTimeout(resolve, interval));

          try {
            const result = await pollDeviceCodeToken(
              config,
              deviceResponse.deviceCode,
              cancellationToken,
            );

            if (result) {
              return result;
            }
          } catch (error) {
            // Check if it's a slow_down error
            if ((error as Error).message.includes('slow_down')) {
              interval += 5000; // Increase interval
            } else {
              throw error;
            }
          }
        }

        throw new Error(t('Device code expired'));
      },
    );

    if (token) {
      vscode.window.showInformationMessage(t('Authorization successful!'));
    }

    return token;
  } catch (error) {
    if ((error as Error).message !== 'cancelled') {
      vscode.window.showErrorMessage(
        t('Device authorization failed: {0}', (error as Error).message),
      );
    }
    return undefined;
  }
}
