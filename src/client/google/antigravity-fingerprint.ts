import * as crypto from 'node:crypto';

const ARCHITECTURES = ['x64', 'arm64'] as const;

const ANTIGRAVITY_VERSIONS = ['1.15.8'] as const;

const IDE_TYPES = ['ANTIGRAVITY', 'IDE_UNSPECIFIED'] as const;

const PLATFORMS = [
  'PLATFORM_UNSPECIFIED',
  'WINDOWS',
  'MACOS',
  'LINUX',
] as const;

const SDK_CLIENTS = [
  'google-cloud-sdk vscode_cloudshelleditor/0.1',
  'google-cloud-sdk vscode/1.86.0',
  'google-cloud-sdk vscode/1.87.0',
  'google-cloud-sdk vscode/1.96.0',
] as const;

function randomFrom<const T>(arr: readonly T[]): T {
  const first = arr.at(0);
  if (first === undefined) {
    throw new Error('Cannot sample from an empty array');
  }
  const idx = Math.floor(Math.random() * arr.length);
  const selected = arr[idx];
  return selected === undefined ? first : selected;
}

export interface ClientMetadata {
  ideType: string;
  platform: string;
  pluginType: string;
}

export interface Fingerprint {
  deviceId: string;
  sessionToken: string;
  userAgent: string;
  apiClient: string;
  clientMetadata: ClientMetadata;
  createdAt: number;
  /** @deprecated Kept for backward compatibility. */
  quotaUser?: string;
}

export type FingerprintHeaders = {
  'User-Agent': string;
};

function generateFingerprint(): Fingerprint {
  const platform = randomFrom(['darwin', 'win32', 'linux'] as const);
  const arch = randomFrom(ARCHITECTURES);
  const antigravityVersion = randomFrom(ANTIGRAVITY_VERSIONS);

  const matchingPlatform =
    platform === 'darwin'
      ? 'MACOS'
      : platform === 'win32'
        ? 'WINDOWS'
        : platform === 'linux'
          ? 'LINUX'
          : randomFrom(PLATFORMS);

  return {
    deviceId: crypto.randomUUID(),
    sessionToken: crypto.randomBytes(16).toString('hex'),
    userAgent: `antigravity/${antigravityVersion} ${platform}/${arch}`,
    apiClient: randomFrom(SDK_CLIENTS),
    clientMetadata: {
      ideType: randomFrom(IDE_TYPES),
      platform: matchingPlatform,
      pluginType: 'GEMINI',
    },
    createdAt: Date.now(),
  };
}

let sessionFingerprint: Fingerprint | null = null;

export function getSessionFingerprint(): Fingerprint {
  if (!sessionFingerprint) {
    sessionFingerprint = generateFingerprint();
  }
  return sessionFingerprint;
}

export function regenerateSessionFingerprint(): Fingerprint {
  sessionFingerprint = generateFingerprint();
  return sessionFingerprint;
}

export function buildFingerprintHeaders(
  fingerprint: Fingerprint | null,
): Partial<FingerprintHeaders> {
  if (!fingerprint) {
    return {};
  }

  return {
    'User-Agent': fingerprint.userAgent,
  };
}
