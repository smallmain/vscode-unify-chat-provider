import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getExtension: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('vscode', () => ({
  extensions: { getExtension: mocks.getExtension },
  Disposable: class {
    constructor(private readonly cleanup: () => void) {}
    dispose(): void { this.cleanup(); }
  },
}));
vi.mock('../../src/logger', () => ({ authLog: { warn: mocks.warn } }));

import { activateCopilotChatInBackground } from '../../src/copilot-chat-activation';

beforeEach(() => vi.resetAllMocks());

function deferredActivation() {
  let resolve = (): void => { throw new Error('Promise not initialized'); };
  let reject = (_error: Error): void => { throw new Error('Promise not initialized'); };
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('opportunistic Copilot Chat activation', () => {
  it('returns immediately while Copilot activation remains pending', async () => {
    const activation = deferredActivation();
    const activate = vi.fn(() => activation.promise);
    mocks.getExtension.mockReturnValue({ activate });
    const refresh = vi.fn();

    const disposable = activateCopilotChatInBackground(refresh);
    expect(disposable).toBeDefined();
    expect(activate).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(refresh).not.toHaveBeenCalled();

    activation.resolve();
    await activation.promise;
    expect(refresh).toHaveBeenCalledOnce();
    disposable.dispose();
  });

  it('does nothing when Copilot Chat is not installed', () => {
    const refresh = vi.fn();
    activateCopilotChatInBackground(refresh).dispose();
    expect(mocks.getExtension).toHaveBeenCalledWith('github.copilot-chat');
    expect(refresh).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('handles rejected activation without an unhandled rejection', async () => {
    const activation = deferredActivation();
    mocks.getExtension.mockReturnValue({ activate: () => activation.promise });
    const refresh = vi.fn();
    const disposable = activateCopilotChatInBackground(refresh);
    activation.reject(new Error('Authentication unavailable'));
    await Promise.resolve();
    expect(mocks.warn).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
    disposable.dispose();
  });

  it('handles synchronous lookup failures', () => {
    mocks.getExtension.mockImplementation(() => { throw new Error('Unavailable'); });
    const refresh = vi.fn();
    expect(() => activateCopilotChatInBackground(refresh).dispose()).not.toThrow();
    expect(mocks.warn).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)('ignores late %s after disposal', async (outcome) => {
    const activation = deferredActivation();
    mocks.getExtension.mockReturnValue({ activate: () => activation.promise });
    const refresh = vi.fn();
    activateCopilotChatInBackground(refresh).dispose();
    if (outcome === 'resolve') activation.resolve();
    else activation.reject(new Error('Late activation error'));
    await Promise.resolve();
    expect(refresh).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});
