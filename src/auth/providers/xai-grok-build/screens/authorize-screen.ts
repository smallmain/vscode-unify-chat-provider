import * as vscode from 'vscode';
import { t } from '../../../../i18n';
import {
  XAI_GROK_OAUTH_CALLBACK_PORT,
  XAI_GROK_OAUTH_REDIRECT_PATH,
} from '../constants';
import { mainInstance } from '../../../../main-instance';
import {
  ensureMainInstanceCompatibility,
  showMainInstanceCompatibilityWarning,
} from '../../../../main-instance/compatibility';
import { isLeaderUnavailableError } from '../../../../main-instance/errors';
import { parseXaiGrokCallbackInput, type CallbackResult } from '../oauth-client';

function parseUrlOrNull(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function parseCallbackFromUrl(url: URL, expectedState: string): CallbackResult {
  const state = url.searchParams.get('state')?.trim();
  if (!state || state !== expectedState) {
    return { type: 'error', error: 'Invalid state' };
  }

  const error = url.searchParams.get('error')?.trim();
  const errorDescription = url.searchParams.get('error_description')?.trim();
  if (error) {
    return {
      type: 'error',
      error: errorDescription ? `${error}: ${errorDescription}` : error,
    };
  }

  const code = url.searchParams.get('code')?.trim();
  if (!code) {
    return { type: 'error', error: 'Missing authorization code' };
  }

  return { type: 'success', code };
}

export async function performXaiGrokAuthorization(options: {
  url: string;
  expectedState: string;
  cancellationToken?: vscode.CancellationToken;
}): Promise<CallbackResult | null> {
  if (!(await ensureMainInstanceCompatibility())) {
    return null;
  }

  let browserOpened = false;
  const ensureBrowserOpened = async (): Promise<boolean> => {
    if (browserOpened) {
      return true;
    }
    const opened = await vscode.env.openExternal(vscode.Uri.parse(options.url));
    if (!opened) {
      vscode.window.showErrorMessage(t('Failed to open browser for authorization'));
      return false;
    }
    browserOpened = true;
    return true;
  };

  const manualFallback = async (): Promise<CallbackResult | null> => {
    const pasted = await vscode.window.showInputBox({
      title: t('Authorization'),
      prompt: t('Paste the redirected URL from the browser address bar'),
      ignoreFocusOut: true,
    });

    if (!pasted) {
      return null;
    }

    const input = pasted.trim();

    // Give the robust parser first chance (bare code, ?code=... fragment, or full URL).
    // This is the code path needed when xAI shows a bare code in remote/browser-only consoles.
    const robust = parseXaiGrokCallbackInput(input, options.expectedState);
    if (robust.type === 'success') {
      return robust;
    }

    const parsed = parseUrlOrNull(input);
    if (!parsed) {
      vscode.window.showErrorMessage(robust.type === 'error' ? robust.error : t('Invalid URL'));
      return null;
    }

    if (parsed.pathname !== XAI_GROK_OAUTH_REDIRECT_PATH) {
      vscode.window.showErrorMessage(t('Invalid callback URL path'));
      return null;
    }

    // Correct path but parser saw a problem (state, code, error param) — surface the detail.
    if (robust.type === 'error') {
      vscode.window.showErrorMessage(robust.error);
      return null;
    }

    return parseCallbackFromUrl(parsed, options.expectedState);
  };

  let sessionId: string | undefined;
  const startController = new AbortController();
  const cancelSubscription = options.cancellationToken?.onCancellationRequested(() => {
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
        port: XAI_GROK_OAUTH_CALLBACK_PORT,
        redirectPath: XAI_GROK_OAUTH_REDIRECT_PATH,
        expectedState: options.expectedState,
      },
      { signal: startController.signal },
    );

    sessionId = started.sessionId;

    try {
      if (!(await ensureBrowserOpened())) {
        void mainInstance
          .runInLeader('oauth.http.cancel', { sessionId })
          .catch(() => {
            // Best-effort.
          });
        return null;
      }

      const waitResult = await mainInstance.runInLeader<
        { type: 'success'; url: string } | { type: 'cancel' }
      >('oauth.http.wait', { sessionId }, {
        signal: startController.signal,
      });

      if (waitResult.type === 'cancel') {
        return { type: 'cancel' };
      }

      const parsed = parseUrlOrNull(waitResult.url);
      if (!parsed) {
        return { type: 'error', error: 'Invalid callback URL' };
      }

      if (parsed.pathname !== XAI_GROK_OAUTH_REDIRECT_PATH) {
        // Try the robust parser (handles bare code / full URL)
        const robust = parseXaiGrokCallbackInput(waitResult.url, options.expectedState);
        if (robust.type === 'success') {
          return robust;
        }
        return { type: 'error', error: 'Invalid callback URL path' };
      }

      return parseCallbackFromUrl(parsed, options.expectedState);
    } finally {
      cancelSubscription?.dispose();
    }
  } catch (error) {
    cancelSubscription?.dispose();
    if (options.cancellationToken?.isCancellationRequested) {
      return { type: 'cancel' };
    }
    if (await showMainInstanceCompatibilityWarning(error)) {
      return null;
    }
    if (isLeaderUnavailableError(error)) {
      if (!(await ensureBrowserOpened())) {
        return null;
      }
      return await manualFallback();
    }

    if (!(await ensureBrowserOpened())) {
      return null;
    }
    return await manualFallback();
  }
}
