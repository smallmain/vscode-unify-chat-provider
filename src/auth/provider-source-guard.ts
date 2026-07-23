import { createHash } from 'node:crypto';
import type { AuthConfig } from './types';
import type { ProviderConfig } from '../types';
import {
  computeStaticAuthFingerprint,
  isSessionAuthConfig,
  stableAuthStateStringify,
} from './local-auth-state';

export type ProviderSourceExpectation =
  | { providerName: string; expected: 'absent' }
  | {
      providerName: string;
      expected: 'present';
      authTargetSignature: string;
    };

export interface ProviderSourceGuard {
  expectations: ProviderSourceExpectation[];
}

interface ProviderSourceCapture {
  providerName: string;
  provider: ProviderConfig | undefined;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString().replace(/\/$/, '');
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

function normalizeProviderBaseUrl(provider: ProviderConfig): string {
  return provider.useRawBaseUrl === true
    ? provider.baseUrl.trim()
    : normalizeUrl(provider.baseUrl);
}

function staticNonSessionAuth(auth: AuthConfig | undefined): unknown {
  if (!auth || auth.method === 'none') return { method: 'none' };
  if (auth.method === 'api-key') {
    return { method: auth.method, apiKey: auth.apiKey };
  }
  if (auth.method === 'google-vertex-ai-auth') {
    switch (auth.subType) {
      case 'adc':
        return {
          method: auth.method,
          subType: auth.subType,
          projectId: auth.projectId,
          location: auth.location,
        };
      case 'service-account':
        return {
          method: auth.method,
          subType: auth.subType,
          keyFilePath: auth.keyFilePath,
          projectId: auth.projectId,
          location: auth.location,
        };
      case 'api-key':
        return {
          method: auth.method,
          subType: auth.subType,
          apiKey: auth.apiKey,
        };
    }
  }
  return undefined;
}

export function computeProviderAuthTargetSignature(
  provider: ProviderConfig,
): string {
  const auth = provider.auth;
  const target =
    auth && isSessionAuthConfig(auth)
      ? {
          bindingId: auth.bindingId,
          staticConfigFingerprint: computeStaticAuthFingerprint(
            {
              providerType: provider.type,
              baseUrl: provider.baseUrl,
              useRawBaseUrl: provider.useRawBaseUrl,
            },
            auth,
          ),
        }
      : {
          providerType: provider.type.trim().toLowerCase(),
          baseUrl: normalizeProviderBaseUrl(provider),
          ...(provider.useRawBaseUrl === true ? { useRawBaseUrl: true } : {}),
          auth: staticNonSessionAuth(auth),
        };
  return createHash('sha256')
    .update(stableAuthStateStringify(target))
    .digest('hex');
}

export function captureProviderSourceGuard(
  captures: readonly ProviderSourceCapture[],
): ProviderSourceGuard {
  const expectations: ProviderSourceExpectation[] = [];
  const seen = new Set<string>();
  for (const capture of captures) {
    if (seen.has(capture.providerName)) continue;
    seen.add(capture.providerName);
    expectations.push(
      capture.provider
        ? {
            providerName: capture.providerName,
            expected: 'present',
            authTargetSignature: computeProviderAuthTargetSignature(
              capture.provider,
            ),
          }
        : { providerName: capture.providerName, expected: 'absent' },
    );
  }
  return { expectations };
}

export function isProviderSourceGuardCurrent(
  guard: ProviderSourceGuard,
  getProvider: (providerName: string) => ProviderConfig | undefined,
): boolean {
  return guard.expectations.every((expectation) => {
    const current = getProvider(expectation.providerName);
    if (expectation.expected === 'absent') return current === undefined;
    return (
      current !== undefined &&
      computeProviderAuthTargetSignature(current) ===
        expectation.authTargetSignature
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const fields = new Set(allowed);
  return Object.keys(value).every((field) => fields.has(field));
}

export function parseProviderSourceGuard(
  value: unknown,
): ProviderSourceGuard | null {
  if (!isRecord(value) || !hasOnlyFields(value, ['expectations'])) return null;
  const rawExpectations = value['expectations'];
  if (!Array.isArray(rawExpectations) || rawExpectations.length === 0) {
    return null;
  }

  const expectations: ProviderSourceExpectation[] = [];
  const seen = new Set<string>();
  for (const raw of rawExpectations) {
    if (!isRecord(raw)) return null;
    const providerName = raw['providerName'];
    const expected = raw['expected'];
    if (
      typeof providerName !== 'string' ||
      providerName.trim() === '' ||
      seen.has(providerName)
    ) {
      return null;
    }
    seen.add(providerName);

    if (expected === 'absent') {
      if (!hasOnlyFields(raw, ['providerName', 'expected'])) return null;
      expectations.push({ providerName, expected });
      continue;
    }
    const signature = raw['authTargetSignature'];
    if (
      expected !== 'present' ||
      !hasOnlyFields(raw, [
        'providerName',
        'expected',
        'authTargetSignature',
      ]) ||
      typeof signature !== 'string' ||
      !SHA256_HEX.test(signature)
    ) {
      return null;
    }
    expectations.push({
      providerName,
      expected,
      authTargetSignature: signature,
    });
  }
  return { expectations };
}
