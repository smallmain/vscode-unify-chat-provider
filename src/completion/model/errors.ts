import type * as vscode from 'vscode';

export type CompletionErrorCode =
  | 'completion-model-not-found'
  | 'completion-provider-not-found'
  | 'completion-invalid-model-reference'
  | 'completion-invalid-config'
  | 'completion-no-template'
  | 'completion-transport-unsupported'
  | 'completion-cursor-prediction-unsupported';

export class CompletionConfigurationError extends Error {
  constructor(
    readonly code: CompletionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CompletionConfigurationError';
  }
}

export type CompletionRuntimeErrorCode =
  | 'completion-http-error'
  | 'completion-invalid-response'
  | 'completion-request-failed';

export class CompletionRuntimeError extends Error {
  constructor(
    readonly code: CompletionRuntimeErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CompletionRuntimeError';
  }
}

export class CompletionInvariantError extends Error {
  readonly code = 'completion-invariant-violation';

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CompletionInvariantError';
  }
}

export function toCompletionRequestError(
  error: unknown,
  token: vscode.CancellationToken,
): unknown {
  if (
    error instanceof CompletionConfigurationError ||
    error instanceof CompletionInvariantError ||
    error instanceof CompletionRuntimeError ||
    token.isCancellationRequested
  ) {
    return error;
  }
  return new CompletionRuntimeError(
    'completion-request-failed',
    error instanceof Error ? error.message : String(error),
    error,
  );
}

export async function withCompletionRequestErrorBoundary<T>(
  token: vscode.CancellationToken,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toCompletionRequestError(error, token);
  }
}
