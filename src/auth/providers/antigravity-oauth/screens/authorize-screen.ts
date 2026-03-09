import * as vscode from 'vscode';
import { t } from '../../../../i18n';
import { ANTIGRAVITY_REDIRECT_PATH } from '../constants';
import { mainInstance } from '../../../../main-instance';
import {
  ensureMainInstanceCompatibility,
  showMainInstanceCompatibilityWarning,
} from '../../../../main-instance/compatibility';
import { isLeaderUnavailableError } from '../../../../main-instance/errors';

type CallbackResult =
  | { type: 'success'; code: string; state: string }
  | { type: 'error'; error: string };

function parseUrlOrNull(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function parseCallbackFromUrl(url: URL): CallbackResult {
  const code = url.searchParams.get('code')?.trim();
  const state = url.searchParams.get('state')?.trim();
  const error = url.searchParams.get('error')?.trim();
  const errorDescription = url.searchParams.get('error_description')?.trim();

  if (error) {
    return {
      type: 'error',
      error: errorDescription ? `${error}: ${errorDescription}` : error,
    };
  }

  if (!code || !state) {
    return { type: 'error', error: 'Missing code or state' };
  }

  return { type: 'success', code, state };
}

export async function performAntigravityAuthorization(
  createAuthorizationUrl: (redirectUri: string) => Promise<string> | string,
): Promise<CallbackResult | null> {
  if (!(await ensureMainInstanceCompatibility())) {
    return null;
  }

  const manualFallback = async (): Promise<CallbackResult | null> => {
    const pasted = await vscode.window.showInputBox({
      title: t('Authorization'),
      prompt: t('Paste the redirected URL from the browser address bar'),
      ignoreFocusOut: true,
    });

    if (!pasted) {
      return null;
    }

    const parsed = parseUrlOrNull(pasted.trim());
    if (!parsed) {
      vscode.window.showErrorMessage(t('Invalid URL'));
      return null;
    }

    return parseCallbackFromUrl(parsed);
  };

  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: t('Waiting for authorization...'),
      cancellable: true,
    },
    async (progress, cancellationToken) => {
      progress.report({ message: t('Complete authorization in your browser') });

      let sessionId: string | undefined;
      let authorizationUrl: string | undefined;
      let browserOpened = false;
      const startController = new AbortController();
      const ensureBrowserOpened = async (): Promise<boolean> => {
        if (!authorizationUrl) {
          return false;
        }
        if (browserOpened) {
          return true;
        }
        const opened = await vscode.env.openExternal(
          vscode.Uri.parse(authorizationUrl),
        );
        if (!opened) {
          return false;
        }
        browserOpened = true;
        return true;
      };
      const cancelSubscription = cancellationToken.onCancellationRequested(() => {
        startController.abort();
        if (!sessionId) {
          return;
        }
        void mainInstance
          .runInLeader('oauth.http.cancel', { sessionId })
          .catch(() => {
            // Best-effort.
          });
      });

      try {
        const started = await mainInstance.runInLeaderWhenAvailable<{
          sessionId: string;
          redirectUri: string;
        }>(
          'oauth.http.start',
          {
            port: 0,
            redirectPath: ANTIGRAVITY_REDIRECT_PATH,
          },
          { signal: startController.signal },
        );

        sessionId = started.sessionId;
        authorizationUrl = await Promise.resolve(
          createAuthorizationUrl(started.redirectUri),
        );

        try {
          if (!(await ensureBrowserOpened())) {
            void mainInstance
              .runInLeader('oauth.http.cancel', { sessionId })
              .catch(() => {
                // Best-effort.
              });
            return null;
          }

          const waitResult = await mainInstance.runInLeader<{
            type: 'success';
            url: string;
          } | { type: 'cancel' }>('oauth.http.wait', { sessionId });

          if (waitResult.type === 'cancel') {
            return null;
          }

          const parsed = parseUrlOrNull(waitResult.url);
          if (!parsed) {
            return { type: 'error', error: 'Invalid callback URL' };
          }

          return parseCallbackFromUrl(parsed);
        } finally {
          cancelSubscription.dispose();
        }
      } catch (error) {
        cancelSubscription.dispose();
        if (cancellationToken.isCancellationRequested) {
          return null;
        }
        if (await showMainInstanceCompatibilityWarning(error)) {
          return null;
        }
        if (isLeaderUnavailableError(error)) {
          if (await ensureBrowserOpened()) {
            return await manualFallback();
          }
          vscode.window.showWarningMessage(
            t(
              'Main instance window is temporarily unavailable; authorization has been cancelled. Please try again.',
            ),
          );
          return null;
        }

        if (sessionId) {
          void mainInstance
            .runInLeader('oauth.http.cancel', { sessionId })
            .catch(() => {
              // Best-effort.
            });
        }

        return await manualFallback();
      }
    },
  );
}
