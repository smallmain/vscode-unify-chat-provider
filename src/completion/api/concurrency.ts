import type * as vscode from 'vscode';

interface QueueEntry {
  readonly token: vscode.CancellationToken;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  subscription: vscode.Disposable;
}

interface LimiterState {
  active: number;
  readonly queue: QueueEntry[];
}

const states = new Map<string, LimiterState>();

async function acquire(
  key: string,
  limit: number,
  token: vscode.CancellationToken,
): Promise<void> {
  if (token.isCancellationRequested) {
    throw new Error('Completion request was cancelled.');
  }
  const state = states.get(key) ?? { active: 0, queue: [] };
  states.set(key, state);
  if (state.active < limit) {
    state.active += 1;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const entry: QueueEntry = {
      token,
      resolve,
      reject,
      subscription: { dispose: () => undefined },
    };
    entry.subscription = token.onCancellationRequested(() => {
      const index = state.queue.indexOf(entry);
      if (index >= 0) state.queue.splice(index, 1);
      entry.subscription.dispose();
      reject(new Error('Completion request was cancelled.'));
    });
    state.queue.push(entry);
  });
}

function release(key: string, limit: number): void {
  const state = states.get(key);
  if (!state) return;
  state.active = Math.max(0, state.active - 1);
  while (state.active < limit) {
    const next = state.queue.shift();
    if (!next) break;
    next.subscription.dispose();
    if (next.token.isCancellationRequested) {
      next.reject(new Error('Completion request was cancelled.'));
      continue;
    }
    state.active += 1;
    next.resolve();
  }
  if (state.active === 0 && state.queue.length === 0) states.delete(key);
}

export async function runWithCompletionConcurrency<T>(
  key: string,
  limit: number,
  token: vscode.CancellationToken,
  operation: () => Promise<T>,
): Promise<T> {
  await acquire(key, limit, token);
  try {
    return await operation();
  } finally {
    release(key, limit);
  }
}

export function clearCompletionConcurrencyForTests(): void {
  for (const state of states.values()) {
    for (const entry of state.queue) entry.subscription.dispose();
  }
  states.clear();
}
