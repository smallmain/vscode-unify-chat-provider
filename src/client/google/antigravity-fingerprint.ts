import * as crypto from 'node:crypto';

const OS_VERSIONS: Record<'darwin' | 'win32' | 'linux', readonly string[]> = {
  darwin: ['10.15.7', '11.6.8', '12.6.3', '13.5.2', '14.2.1', '14.5'],
  win32: [
    '10.0.19041',
    '10.0.19042',
    '10.0.19043',
    '10.0.22000',
    '10.0.22621',
    '10.0.22631',
  ],
  linux: ['5.15.0', '5.19.0', '6.1.0', '6.2.0', '6.5.0', '6.6.0'],
};

const ARCHITECTURES = ['x64', 'arm64'] as const;

const ANTIGRAVITY_VERSIONS = [
  '1.15.8',
] as const;

const IDE_TYPES = [
  'IDE_UNSPECIFIED',
  'VSCODE',
  'INTELLIJ',
  'ANDROID_STUDIO',
  'CLOUD_SHELL_EDITOR',
] as const;

const PLATFORMS = ['PLATFORM_UNSPECIFIED', 'WINDOWS', 'MACOS', 'LINUX'] as const;

const SDK_CLIENTS = [
  'google-cloud-sdk vscode_cloudshelleditor/0.1',
  'google-cloud-sdk vscode/1.86.0',
  'google-cloud-sdk vscode/1.87.0',
  'google-cloud-sdk intellij/2024.1',
  'google-cloud-sdk android-studio/2024.1',
  'gcloud-python/1.2.0 grpc-google-iam-v1/0.12.6',
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
  osVersion: string;
  arch: string;
  sqmId?: string;
}

export interface Fingerprint {
  deviceId: string;
  sessionToken: string;
  userAgent: string;
  apiClient: string;
  clientMetadata: ClientMetadata;
  quotaUser: string;
  createdAt: number;
}

export type FingerprintHeaders = {
  'User-Agent': string;
  'X-Goog-Api-Client': string;
  'Client-Metadata': string;
  'X-Goog-QuotaUser': string;
  'X-Client-Device-Id': string;
};

function generateFingerprint(): Fingerprint {
  const platform = randomFrom(['darwin', 'win32', 'linux'] as const);
  const arch = randomFrom(ARCHITECTURES);
  const osVersion = randomFrom(OS_VERSIONS[platform]);
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
      osVersion,
      arch,
      sqmId: `{${crypto.randomUUID().toUpperCase()}}`,
    },
    quotaUser: `device-${crypto.randomBytes(8).toString('hex')}`,
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
    'X-Goog-Api-Client': fingerprint.apiClient,
    'Client-Metadata': JSON.stringify(fingerprint.clientMetadata),
    'X-Goog-QuotaUser': fingerprint.quotaUser,
    'X-Client-Device-Id': fingerprint.deviceId,
  };
}
