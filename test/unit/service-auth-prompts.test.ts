import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  prompt: vi.fn<(...args: unknown[]) => Promise<string | undefined>>(),
}));

vi.mock('vscode', () => {
  class CancellationError extends Error {}
  class CancellationTokenSource {
    private readonly listeners = new Set<() => void>();
    readonly token = {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => {
        this.listeners.add(listener);
        return { dispose: () => { this.listeners.delete(listener); } };
      },
    };
    cancel(): void {
      if (this.token.isCancellationRequested) return;
      this.token.isCancellationRequested = true;
      for (const listener of [...this.listeners]) listener();
    }
    dispose(): void { this.listeners.clear(); }
  }
  return {
    CancellationError, CancellationTokenSource,
    env: { language: 'en' }, l10n: { t: (message: string) => message },
    window: { showErrorMessage: state.prompt },
  };
});
vi.mock('../../src/client/definitions', () => ({ PROVIDER_TYPES: {} }));
vi.mock('../../src/client/utils', () => ({}));
vi.mock('../../src/logger', () => ({}));
vi.mock('../../src/utils', () => ({}));
vi.mock('../../src/ui/form-utils', () => ({}));
vi.mock('../../src/ui/router/stack-router', () => ({ runUiStack: vi.fn() }));
vi.mock('../../src/tokenizer/tokenizers', () => ({}));
vi.mock('../../src/balance', () => ({}));

import * as vscode from 'vscode';
import { UnifyChatService } from '../../src/service';
import { CredentialRequestCoordinator } from '../../src/auth/credential-request';
import type { AuthTokenInfo } from '../../src/auth/types';

function fixture(): {
  resolve: (token: vscode.CancellationToken) => Promise<unknown>;
  configure: ReturnType<typeof vi.fn>;
  dispose: () => void;
} {
  let authenticated = false;
  const configure = vi.fn(async () => { authenticated = true; return { success: true }; });
  const coordinator = new CredentialRequestCoordinator<AuthTokenInfo>();
  const interactive: unknown = Reflect.get(UnifyChatService.prototype, 'resolveCredentialInteractively');
  const resolve: unknown = Reflect.get(UnifyChatService.prototype, 'resolveCredential');
  if (typeof interactive !== 'function' || typeof resolve !== 'function') throw new Error('Missing credential resolver');
  const receiver = {
    credentialRequests: coordinator,
    configStore: { getProvider: () => ({ name: 'test', type: 'openai-chat-completion', baseUrl: 'https://example.test', auth: { method: 'api-key', apiKey: 'synthetic' } }) },
    authManager: {
      getCredential: async () => authenticated ? { value: 'synthetic' } : undefined,
      getLastError: () => undefined,
      getProvider: () => ({ configure }),
    },
    resolveCredentialInteractively: async (provider: string, token: vscode.CancellationToken): Promise<unknown> =>
      await Reflect.apply(interactive, receiver, [provider, token]),
  };
  return {
    resolve: async (token) => await Reflect.apply(resolve, receiver, ['test', token]),
    configure,
    dispose: () => coordinator.dispose(),
  };
}

beforeEach(() => { state.prompt.mockReset(); });

describe('service authentication interactions', () => {
  it('uses a single prompt and login for three simultaneous requests', async () => {
    const test = fixture();
    const source = new vscode.CancellationTokenSource();
    state.prompt.mockResolvedValue('Authenticate');
    const results = await Promise.all([test.resolve(source.token), test.resolve(source.token), test.resolve(source.token)]);
    expect(state.prompt).toHaveBeenCalledTimes(1);
    expect(test.configure).toHaveBeenCalledTimes(1);
    expect(results).toEqual(Array.from({ length: 3 }, () => ({ kind: 'token', token: 'synthetic' })));
    test.dispose();
    source.dispose();
  });

  it('does not authenticate after all waiting requests cancel while a modal is open', async () => {
    const test = fixture();
    const source = new vscode.CancellationTokenSource();
    let closePrompt = (_value: string): void => { throw new Error('Prompt not open'); };
    state.prompt.mockImplementation(() => new Promise((resolve) => { closePrompt = resolve; }));
    const request = test.resolve(source.token);
    const rejection = expect(request).rejects.toBeInstanceOf(vscode.CancellationError);
    await vi.waitFor(() => expect(state.prompt).toHaveBeenCalledTimes(1));
    source.cancel();
    await rejection;
    closePrompt('Authenticate');
    await Promise.resolve();
    await Promise.resolve();
    expect(test.configure).not.toHaveBeenCalled();
    test.dispose();
    source.dispose();
  });

  it('does not open a prompt for an already cancelled chat request', async () => {
    const test = fixture();
    const source = new vscode.CancellationTokenSource();
    source.cancel();
    await expect(test.resolve(source.token)).rejects.toBeInstanceOf(vscode.CancellationError);
    expect(state.prompt).not.toHaveBeenCalled();
    test.dispose();
    source.dispose();
  });
});
