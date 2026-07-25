import type * as vscode from 'vscode';

type CancellationListener = (event: unknown) => unknown;

export class LinkedCancellationTokenSource implements vscode.Disposable {
  private readonly listeners = new Set<() => void>();
  private readonly parentSubscription: vscode.Disposable;
  private cancelled = false;
  private disposeRequested = false;
  private parentDetached = false;

  readonly token: vscode.CancellationToken;

  constructor(parent: vscode.CancellationToken) {
    const owner = this;
    this.token = {
      get isCancellationRequested(): boolean {
        return owner.cancelled;
      },
      onCancellationRequested: (
        listener: CancellationListener,
        thisArgs?: unknown,
        disposables?: vscode.Disposable[],
      ): vscode.Disposable => {
        const callback = (): void => {
          listener.call(thisArgs, undefined);
        };
        const disposable: vscode.Disposable = {
          dispose: () => owner.releaseListener(callback),
        };

        if (owner.disposeRequested) {
          // A disposed source keeps existing listener leases only.
        } else if (owner.cancelled) {
          queueMicrotask(callback);
        } else {
          owner.listeners.add(callback);
        }
        disposables?.push(disposable);
        return disposable;
      },
    };

    this.parentSubscription = parent.onCancellationRequested(() => {
      this.cancel();
    });
    if (parent.isCancellationRequested) {
      this.cancel();
    }
  }

  cancel(): void {
    if (this.cancelled || this.parentDetached) {
      return;
    }
    this.cancelled = true;
    const listeners = [...this.listeners];
    this.listeners.clear();
    for (const listener of listeners) {
      listener();
    }
    this.detachParentIfReady();
  }

  dispose(): void {
    if (this.disposeRequested) {
      return;
    }
    this.disposeRequested = true;
    this.detachParentIfReady();
  }

  private releaseListener(listener: () => void): void {
    this.listeners.delete(listener);
    this.detachParentIfReady();
  }

  private detachParentIfReady(): void {
    if (
      this.parentDetached ||
      !this.disposeRequested ||
      this.listeners.size > 0
    ) {
      return;
    }
    this.parentDetached = true;
    this.parentSubscription.dispose();
  }
}
