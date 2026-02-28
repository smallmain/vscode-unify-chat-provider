import * as vscode from 'vscode';
import { createServer } from 'node:http';
import { t } from '../../../../i18n';
import {
  OPENAI_CODEX_CALLBACK_PORT,
  OPENAI_CODEX_REDIRECT_PATH,
} from '../constants';

type CallbackResult =
  | { type: 'success'; code: string }
  | { type: 'cancel' }
  | { type: 'error'; error: string };

function parseUrlOrNull(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function renderHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  return `<!doctype html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>Authentication</title></head><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:24px;"><h2>${escaped}</h2></body></html>`;
}

function parseCallbackFromUrl(
  url: URL,
  expectedState: string,
): CallbackResult {
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

export async function performOpenAICodexAuthorization(options: {
  url: string;
  expectedState: string;
  cancellationToken?: vscode.CancellationToken;
}): Promise<CallbackResult | null> {
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

    if (parsed.pathname !== OPENAI_CODEX_REDIRECT_PATH) {
      vscode.window.showErrorMessage(t('Invalid callback URL path'));
      return null;
    }

    return parseCallbackFromUrl(parsed, options.expectedState);
  };

  return await new Promise<CallbackResult | null>((resolve) => {
    let resolved = false;
    let cancelSubscription: vscode.Disposable | undefined;

    const doResolve = (result: CallbackResult | null): void => {
      if (resolved) return;
      resolved = true;
      cancelSubscription?.dispose();
      resolve(result);
    };

    cancelSubscription = options.cancellationToken?.onCancellationRequested(() => {
      server.close(() => doResolve({ type: 'cancel' }));
    });

    const server = createServer((req, res) => {
      const reqUrl = req.url ?? '';
      const parsed = parseUrlOrNull(`http://localhost${reqUrl}`);
      if (!parsed) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Bad Request');
        return;
      }

      if (parsed.pathname === '/cancel') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Login cancelled');
        server.close(() => doResolve({ type: 'cancel' }));
        return;
      }

      if (parsed.pathname !== OPENAI_CODEX_REDIRECT_PATH) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Not Found');
        return;
      }

      const result = parseCallbackFromUrl(parsed, options.expectedState);

      res.statusCode = result.type === 'success' ? 200 : 400;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        renderHtml(
          result.type === 'success'
            ? 'Authentication complete. You may close this tab.'
            : 'Authentication failed. You may close this tab.',
        ),
      );

      server.close(() => doResolve(result));
    });

    server.on('error', async () => {
      server.close();
      doResolve(await manualFallback());
    });

    server.listen(OPENAI_CODEX_CALLBACK_PORT, 'localhost', async () => {
      const opened = await vscode.env.openExternal(
        vscode.Uri.parse(options.url),
      );
      if (!opened) {
        server.close();
        vscode.window.showErrorMessage(
          t('Failed to open browser for authorization'),
        );
        doResolve(null);
      }
    });
  });
}
