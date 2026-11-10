import * as vscode from 'vscode';

interface PendingCredentialRequest<T> {
  readonly source: vscode.CancellationTokenSource;
  readonly token: vscode.CancellationToken;
  readonly promise: Promise<T>;
  waiters: number;
  settled: boolean;
}

export class CredentialRequestCoordinator<T> implements vscode.Disposable {
  private readonly pending = new Map<string, PendingCredentialRequest<T>>();
  private readonly cancelWaiters = new Set<() => void>();
  private disposed = false;

  async run(
    key: string,
    token: vscode.CancellationToken,
    work: (token: vscode.CancellationToken) => Promise<T>,
  ): Promise<T> {
    if (this.disposed || token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    let request = this.pending.get(key);
    if (request?.token.isCancellationRequested) {
      // A modal cannot be dismissed through the public API. Wait for it to close
      // before starting another interaction for the same authentication target.
      await this.wait(request, token, false).catch((error: unknown) => {
        if (this.disposed || token.isCancellationRequested) throw error;
      });
      return this.run(key, token, work);
    }
    if (!request) {
      const source = new vscode.CancellationTokenSource();
      const operationToken = source.token;
      request = {
        source,
        token: operationToken,
        promise: Promise.resolve().then(() => {
          if (operationToken.isCancellationRequested) throw new vscode.CancellationError();
          return work(operationToken);
        }),
        waiters: 0,
        settled: false,
      };
      const current = request;
      this.pending.set(key, current);
      const finish = (): void => {
        current.settled = true;
        if (this.pending.get(key) === current) this.pending.delete(key);
        source.dispose();
      };
      void current.promise.then(finish, finish);
    }
    return this.wait(request, token);
  }

  private wait(
    request: PendingCredentialRequest<T>,
    token: vscode.CancellationToken,
    observeOperationCancellation = true,
  ): Promise<T> {
    request.waiters++;
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      let cancellation: vscode.Disposable | undefined;
      let operationCancellation: vscode.Disposable | undefined;
      const finish = (complete: () => void): void => {
        if (finished) return;
        finished = true;
        cancellation?.dispose();
        operationCancellation?.dispose();
        this.cancelWaiters.delete(cancel);
        request.waiters--;
        if (request.waiters === 0 && !request.settled) request.source.cancel();
        complete();
      };
      const cancel = (): void => finish(() => reject(new vscode.CancellationError()));
      this.cancelWaiters.add(cancel);
      cancellation = token.onCancellationRequested(cancel);
      if (observeOperationCancellation) {
        operationCancellation = request.token.onCancellationRequested(cancel);
      }
      if (
        token.isCancellationRequested ||
        (observeOperationCancellation && request.token.isCancellationRequested)
      ) cancel();
      if (finished) {
        cancellation.dispose();
        operationCancellation?.dispose();
      }
      void request.promise.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const cancel of [...this.cancelWaiters]) cancel();
    for (const request of this.pending.values()) request.source.cancel();
    this.pending.clear();
  }
}
