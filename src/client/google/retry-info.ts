function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDurationSecondsToMs(value: string): number | null {
  // Common gRPC JSON encoding: "12.345s"
  const match = value.trim().match(/^([\d.]+)s$/);
  if (!match || !match[1]) {
    return null;
  }

  const seconds = Number.parseFloat(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }

  return Math.ceil(seconds * 1000);
}

function parseGoogleRpcRetryDelayMs(body: unknown): number | null {
  if (!isRecord(body)) {
    return null;
  }

  const error = body['error'];
  if (!isRecord(error)) {
    return null;
  }

  const details = error['details'];
  if (!Array.isArray(details)) {
    return null;
  }

  for (const detail of details) {
    if (!isRecord(detail)) {
      continue;
    }

    const typeValue = detail['@type'];
    const type =
      typeof typeValue === 'string' && typeValue.trim() ? typeValue : '';
    if (type !== 'type.googleapis.com/google.rpc.RetryInfo') {
      continue;
    }

    const retryDelay = detail['retryDelay'] ?? detail['retry_delay'];
    if (typeof retryDelay === 'string') {
      return parseDurationSecondsToMs(retryDelay);
    }

    if (isRecord(retryDelay)) {
      const secondsValue = retryDelay['seconds'];
      const nanosValue = retryDelay['nanos'];
      const seconds =
        typeof secondsValue === 'number'
          ? secondsValue
          : typeof secondsValue === 'string'
            ? Number.parseInt(secondsValue, 10)
            : NaN;
      const nanos =
        typeof nanosValue === 'number'
          ? nanosValue
          : typeof nanosValue === 'string'
            ? Number.parseInt(nanosValue, 10)
            : 0;

      if (!Number.isFinite(seconds) || seconds <= 0) {
        return null;
      }

      const extraMs = Math.ceil(
        (Number.isFinite(nanos) ? nanos : 0) / 1_000_000,
      );
      const ms = seconds * 1000 + extraMs;
      return ms > 0 ? ms : null;
    }
  }

  return null;
}

function parseRetryAfterHeaderMs(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (!header) {
    return null;
  }

  const trimmed = header.trim();
  if (!trimmed) {
    return null;
  }

  // Retry-After: <delay-seconds>
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1000;
    }
    return null;
  }

  // Retry-After: <http-date>
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  const delta = parsed - Date.now();
  return delta > 0 ? delta : null;
}

export async function extractServerSuggestedRetryDelayMs(
  response: Response,
  options?: { parseBody?: boolean },
): Promise<number | null> {
  const fromHeader = parseRetryAfterHeaderMs(response);

  if (!options?.parseBody) {
    return fromHeader;
  }

  const contentType = response.headers.get('content-type') ?? '';
  const canParseBody = /\bjson\b/i.test(contentType) || contentType === '';
  if (!canParseBody) {
    return fromHeader;
  }

  try {
    const text = await response.clone().text();
    if (!text.trim()) {
      return fromHeader;
    }
    if (text.length > 256_000) {
      return fromHeader;
    }

    const parsed: unknown = JSON.parse(text);
    const fromBody = parseGoogleRpcRetryDelayMs(parsed);
    if (fromHeader == null) {
      return fromBody;
    }
    if (fromBody == null) {
      return fromHeader;
    }
    return Math.max(fromHeader, fromBody);
  } catch {
    return fromHeader;
  }
}

