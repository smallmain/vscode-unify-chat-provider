import { t } from '../../../i18n';

/**
 * OAuth2 error types for classification
 */
export type OAuth2ErrorType = 'auth_error' | 'transient_error' | 'unknown_error';

/**
 * OAuth2 error with classification
 */
export class OAuth2Error extends Error {
  constructor(
    message: string,
    public readonly type: OAuth2ErrorType,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'OAuth2Error';
  }
}

/**
 * OAuth2 error codes that indicate authentication/authorization issues
 */
const AUTH_ERROR_CODES = new Set([
  'invalid_grant',
  'invalid_token',
  'access_denied',
  'unauthorized_client',
  'invalid_client',
  'unauthorized',
]);

/**
 * HTTP status codes that indicate authentication/authorization issues
 */
const AUTH_ERROR_STATUS_CODES = new Set([401, 403]);

/**
 * HTTP status codes that indicate transient/retryable issues
 */
const TRANSIENT_ERROR_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Classify an error based on HTTP status code and OAuth2 error code
 */
export function classifyError(
  status: number,
  errorCode?: string,
): OAuth2ErrorType {
  // Check OAuth2 error code first
  if (errorCode && AUTH_ERROR_CODES.has(errorCode.toLowerCase())) {
    return 'auth_error';
  }

  // Check HTTP status code
  if (AUTH_ERROR_STATUS_CODES.has(status)) {
    return 'auth_error';
  }

  if (TRANSIENT_ERROR_STATUS_CODES.has(status)) {
    return 'transient_error';
  }

  // 5xx errors are generally transient
  if (status >= 500 && status < 600) {
    return 'transient_error';
  }

  return 'unknown_error';
}

/**
 * Parse OAuth2 error response body
 */
export function parseOAuth2ErrorBody(body: string): {
  error?: string;
  errorDescription?: string;
} {
  try {
    const data = JSON.parse(body);
    return {
      error: data.error,
      errorDescription: data.error_description,
    };
  } catch {
    return {};
  }
}

/**
 * Create an OAuth2Error from a fetch response
 */
export async function createOAuth2ErrorFromResponse(
  response: Response,
  defaultMessage: string,
): Promise<OAuth2Error> {
  const body = await response.text();
  const { error: errorCode, errorDescription } = parseOAuth2ErrorBody(body);

  const errorType = classifyError(response.status, errorCode);
  const retryable = errorType === 'transient_error';

  const message =
    errorDescription ?? errorCode ?? body ?? defaultMessage;

  return new OAuth2Error(
    t('{0} (HTTP {1})', message, response.status),
    errorType,
    retryable,
  );
}

/**
 * Create an OAuth2Error from a network/timeout error
 */
export function createOAuth2ErrorFromNetworkError(error: unknown): OAuth2Error {
  const message =
    error instanceof Error ? error.message : t('Network error');

  // Network errors and timeouts are transient
  const isTimeout =
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError');

  return new OAuth2Error(
    isTimeout ? t('Request timeout') : message,
    'transient_error',
    true,
  );
}
