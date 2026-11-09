import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import { WebSocketServer } from 'ws';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ ignoreSSLErrors: false }));
vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({
    get: (key: string, fallback: unknown) => key === 'networkSettings' ? settings : fallback,
  }) },
}));
vi.mock('../../src/i18n', () => ({ t: (message: string) => message }));
vi.mock('../../src/official-models-manager', () => ({ officialModelsManager: {} }));

import { fetchWithRetry } from '../../src/utils';
import { OpenAIResponsesWebSocketTransport } from '../../src/client/openai/responses-websocket-transport';

describe('global API TLS policy', () => {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  let directory: string;
  let url: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ucp-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-subj', '/CN=localhost'], { stdio: 'ignore' });
    server.setSecureContext({ key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) });
    server.on('request', (_request, response) => { response.end('ok'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    url = `https://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    settings.ignoreSSLErrors = false;
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  it.each(['direct', 'vscode'] as const)('applies changes to %s HTTPS requests', async (type) => {
    const options = { proxy: { type }, retryConfig: { maxRetries: 0 } };
    settings.ignoreSSLErrors = false;
    await expect(fetchWithRetry(url, options)).rejects.toThrow();
    settings.ignoreSSLErrors = true;
    expect(await (await fetchWithRetry(url, options)).text()).toBe('ok');
    settings.ignoreSSLErrors = false;
    await expect(fetchWithRetry(url, options)).rejects.toThrow();
  });

  it.each([false, true])('applies the global policy to Responses WebSockets (beta=%s)', async (beta) => {
    const client = new OpenAI({ apiKey: 'test-key', baseURL: url });
    for (const ignore of [false, true, false]) {
      settings.ignoreSSLErrors = ignore;
      const transport = new OpenAIResponsesWebSocketTransport(client, {}, beta);
      const result = await new Promise<'open' | 'error'>((resolve) => {
        transport.onOpen(() => resolve('open'));
        transport.onError(() => resolve('error'));
      });
      expect(result).toBe(ignore ? 'open' : 'error');
      transport.close();
    }
  });
});
