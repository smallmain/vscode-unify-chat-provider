const VERSION_URL =
  'https://antigravity-auto-updater-974169037036.us-central1.run.app';
const CHANGELOG_URL = 'https://antigravity.google/changelog';

export const ANTIGRAVITY_VERSION_FALLBACK = '1.20.6';

const FETCH_TIMEOUT_MS = 5000;
const CHANGELOG_SCAN_CHARS = 5000;
const VERSION_REGEX = /\d+\.\d+\.\d+/;

let currentVersion = ANTIGRAVITY_VERSION_FALLBACK;
let initPromise: Promise<void> | null = null;

function parseVersion(text: string): string | null {
  const match = text.match(VERSION_REGEX);
  const parsed = match?.[0]?.trim();
  return parsed ? parsed : null;
}

async function tryFetchVersion(
  url: string,
  options?: { maxChars?: number },
): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/plain, text/html;q=0.9, */*;q=0.8',
      },
    });
    if (!response.ok) {
      return null;
    }

    let text = await response.text();
    const maxChars = options?.maxChars;
    if (typeof maxChars === 'number' && maxChars > 0 && text.length > maxChars) {
      text = text.slice(0, maxChars);
    }

    return parseVersion(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function getAntigravityVersion(): Promise<string> {
  await initAntigravityVersion();
  return currentVersion;
}

export function initAntigravityVersion(): Promise<void> {
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    try {
      const apiVersion = await tryFetchVersion(VERSION_URL);
      if (apiVersion) {
        currentVersion = apiVersion;
        return;
      }

      const changelogVersion = await tryFetchVersion(CHANGELOG_URL, {
        maxChars: CHANGELOG_SCAN_CHARS,
      });
      if (changelogVersion) {
        currentVersion = changelogVersion;
        return;
      }
    } catch {
      // Ignore all errors and keep the fallback version.
    }
  })();

  return initPromise;
}
