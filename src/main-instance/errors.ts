import { t } from '../i18n';

export type MainInstanceErrorCode =
  | 'LEADER_GONE'
  | 'NO_LEADER'
  | 'INCOMPATIBLE_VERSION'
  | 'UNAUTHORIZED'
  | 'BAD_REQUEST'
  | 'PORT_IN_USE'
  | 'BUSY'
  | 'NOT_IMPLEMENTED'
  | 'CANCELLED'
  | 'INTERNAL_ERROR';

export type RpcError = {
  code: MainInstanceErrorCode;
  message: string;
};

export class MainInstanceError extends Error {
  readonly code: MainInstanceErrorCode;

  constructor(code: MainInstanceErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'MainInstanceError';
  }
}

export function isLeaderUnavailableError(
  error: unknown,
): error is MainInstanceError {
  return (
    error instanceof MainInstanceError &&
    (error.code === 'NO_LEADER' || error.code === 'LEADER_GONE')
  );
}

export function isVersionIncompatibleError(
  error: unknown,
): error is MainInstanceError {
  return (
    error instanceof MainInstanceError && error.code === 'INCOMPATIBLE_VERSION'
  );
}

export function buildVersionMismatchMessage(
  localVersion: string | undefined,
  peerVersion: string | undefined,
): string {
  if (localVersion && peerVersion) {
    return t(
      'Detected another VS Code window running Unify Chat Provider {0} while this window is using {1}. Please reload or update all VS Code windows to the latest version, then try again.',
      peerVersion,
      localVersion,
    );
  }

  if (localVersion) {
    return t(
      'Detected another VS Code window running an older or incompatible version of Unify Chat Provider while this window is using {0}. Please reload or update all VS Code windows to the latest version, then try again.',
      localVersion,
    );
  }

  return t(
    'Detected another VS Code window running an incompatible version of Unify Chat Provider. Please reload or update all VS Code windows to the latest version, then try again.',
  );
}

export function asRpcError(value: unknown): RpcError {
  if (
    value instanceof MainInstanceError &&
    typeof value.code === 'string' &&
    value.code.trim() !== ''
  ) {
    return { code: value.code, message: value.message };
  }

  if (value instanceof Error) {
    return { code: 'INTERNAL_ERROR', message: value.message };
  }

  return { code: 'INTERNAL_ERROR', message: String(value) };
}
