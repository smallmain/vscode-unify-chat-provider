/**
 * Authorization screen for Gemini CLI OAuth.
 *
 * This module handles the OAuth authorization flow by:
 * 1. Starting a local HTTP server to receive the callback
 * 2. Opening the browser for user authorization
 * 3. Capturing the authorization code and state from the callback
 */

import * as vscode from 'vscode';
import { createServer } from 'node:http';
import { t } from '../../../../i18n';
import { GEMINI_CLI_REDIRECT_PATH } from '../constants';
import type { AddressInfo } from 'node:net';

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

function renderHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  return `<!doctype html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>Gemini CLI Authentication</title></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:24px;"><h2>${escaped}</h2></body></html>`;
}

/**
 * Perform the Gemini CLI OAuth authorization flow.
 *
 * @param createAuthorizationUrl - Function that generates the authorization URL given a redirect URI
 * @returns The callback result containing code and state, or null if cancelled
 */
export async function performGeminiCliAuthorization(
  createAuthorizationUrl: (redirectUri: string) => Promise<string> | string,
): Promise<CallbackResult | null> {
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

      return await new Promise<CallbackResult | null>((resolve) => {
        let resolved = false;
        const doResolve = (result: CallbackResult | null): void => {
          if (resolved) return;
          resolved = true;
          cancelSubscription.dispose();
          resolve(result);
        };

        const cancelSubscription = cancellationToken.onCancellationRequested(
          () => {
            server.close(() => {
              doResolve(null);
            });
          },
        );

        const tryListen = async (host: string): Promise<{
          origin: string;
          redirectUri: string;
        } | null> => {
          try {
            await new Promise<void>((resolveListen, rejectListen) => {
              const handleError = (error: unknown): void => {
                server.off('error', handleError);
                rejectListen(
                  error instanceof Error ? error : new Error(String(error)),
                );
              };
              server.once('error', handleError);
              server.listen(0, host, () => {
                server.off('error', handleError);
                resolveListen();
              });
            });

            const address = server.address();
            const info =
              address && typeof address === 'object' && 'port' in address
                ? (address as AddressInfo)
                : null;
            if (!info) {
              throw new Error('Failed to resolve OAuth callback port');
            }

            const hostForUrl = host === '::1' ? '[::1]' : host;
            const origin = `http://${hostForUrl}:${info.port}`;
            return {
              origin,
              redirectUri: `${origin}${GEMINI_CLI_REDIRECT_PATH}`,
            };
          } catch {
            return null;
          }
        };

        const server = createServer((req, res) => {
          const reqUrl = req.url ?? '';
          const parsed = parseUrlOrNull(`${origin}${reqUrl}`);
          if (!parsed || parsed.pathname !== GEMINI_CLI_REDIRECT_PATH) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end('Not Found');
            return;
          }

          const result = parseCallbackFromUrl(parsed);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(
            renderHtml(
              result.type === 'success'
                ? 'Authentication complete. You may close this tab.'
                : 'Authentication failed. You may close this tab.',
            ),
          );

          // Close server and resolve immediately
          setImmediate(() => {
            server.close();
            doResolve(result);
          });
        });

        let origin = 'http://127.0.0.1';
        const start = async (): Promise<void> => {
          const listener =
            (await tryListen('127.0.0.1')) ?? (await tryListen('::1'));
          if (!listener) {
            server.close();
            doResolve(await manualFallback());
            return;
          }

          origin = listener.origin;
          const url = await Promise.resolve(
            createAuthorizationUrl(listener.redirectUri),
          );

          const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
          if (!opened) {
            server.close(() => {
              doResolve(null);
            });
          }
        };

        void start();

        server.on('error', async () => {
          server.close();
          doResolve(await manualFallback());
        });
      });
    },
  );
}
