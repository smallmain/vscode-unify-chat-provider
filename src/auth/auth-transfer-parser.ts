import type { AuthRuntimeConfig } from './types';
import {
  createAuthBindingId,
  isSessionAuthMethod,
  isValidAuthBindingId,
  parseOAuth2TokenData,
  parseSessionAuthConfig,
} from './local-auth-state';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyFields(
  record: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  const allowed = new Set(fields);
  return Object.keys(record).every((field) => allowed.has(field));
}

function hasOptionalStrings(
  record: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return fields.every(
    (field) =>
      record[field] === undefined || typeof record[field] === 'string',
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isValidSerializedOAuth2Token(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'string' || value.trim() === '') return false;

  try {
    const parsed: unknown = JSON.parse(value);
    return parseOAuth2TokenData(parsed) !== null;
  } catch {
    return false;
  }
}

function isStrictOAuthTransfer(value: unknown): boolean {
  if (!isRecord(value) || !isNonEmptyString(value['tokenUrl'])) return false;
  if (
    !hasOptionalStrings(value, ['revocationUrl']) ||
    (value['scopes'] !== undefined && !isStringArray(value['scopes']))
  ) {
    return false;
  }

  switch (value['grantType']) {
    case 'authorization_code':
      return (
        hasOnlyFields(value, [
          'grantType',
          'authorizationUrl',
          'tokenUrl',
          'revocationUrl',
          'clientId',
          'clientSecret',
          'redirectUri',
          'scopes',
          'pkce',
        ]) &&
        isNonEmptyString(value['authorizationUrl']) &&
        isNonEmptyString(value['clientId']) &&
        hasOptionalStrings(value, ['clientSecret', 'redirectUri']) &&
        (value['pkce'] === undefined || typeof value['pkce'] === 'boolean')
      );
    case 'client_credentials':
      return (
        hasOnlyFields(value, [
          'grantType',
          'tokenUrl',
          'revocationUrl',
          'clientId',
          'clientSecret',
          'scopes',
        ]) &&
        isNonEmptyString(value['clientId']) &&
        hasOptionalStrings(value, ['clientSecret'])
      );
    case 'device_code':
      return (
        hasOnlyFields(value, [
          'grantType',
          'deviceAuthorizationUrl',
          'tokenUrl',
          'revocationUrl',
          'clientId',
          'scopes',
        ]) &&
        isNonEmptyString(value['deviceAuthorizationUrl']) &&
        isNonEmptyString(value['clientId'])
      );
    default:
      return false;
  }
}

function hasValidSessionCommonFields(
  record: Record<string, unknown>,
): boolean {
  return (
    hasOptionalStrings(record, ['label', 'description', 'identityId']) &&
    isValidSerializedOAuth2Token(record['token']) &&
    (record['bindingId'] === undefined ||
      isValidAuthBindingId(record['bindingId']))
  );
}

function parseSessionTransfer(
  record: Record<string, unknown>,
): AuthRuntimeConfig | null {
  if (!isSessionAuthMethod(record['method'])) return null;
  const commonFields = [
    'method',
    'bindingId',
    'label',
    'description',
    'identityId',
    'token',
  ] as const;
  if (!hasValidSessionCommonFields(record)) return null;

  switch (record['method']) {
    case 'oauth2':
      if (
        !hasOnlyFields(record, [...commonFields, 'oauth']) ||
        !isStrictOAuthTransfer(record['oauth'])
      ) {
        return null;
      }
      break;
    case 'antigravity-oauth':
      if (
        !hasOnlyFields(record, [
          ...commonFields,
          'projectId',
          'managedProjectId',
          'tier',
          'tierId',
          'email',
        ]) ||
        !hasOptionalStrings(record, [
          'projectId',
          'managedProjectId',
          'tierId',
          'email',
        ]) ||
        (record['tier'] !== undefined &&
          record['tier'] !== 'free' &&
          record['tier'] !== 'paid')
      ) {
        return null;
      }
      break;
    case 'google-gemini-oauth':
      if (
        !hasOnlyFields(record, [
          ...commonFields,
          'oauthType',
          'projectId',
          'managedProjectId',
          'tier',
          'tierId',
          'email',
        ]) ||
        !hasOptionalStrings(record, [
          'projectId',
          'managedProjectId',
          'tierId',
          'email',
        ]) ||
        (record['oauthType'] !== undefined &&
          record['oauthType'] !== 'code_assist' &&
          record['oauthType'] !== 'ai_studio' &&
          record['oauthType'] !== 'google_one') ||
        (record['tier'] !== undefined &&
          record['tier'] !== 'free' &&
          record['tier'] !== 'paid')
      ) {
        return null;
      }
      break;
    case 'openai-codex':
      if (
        !hasOnlyFields(record, [...commonFields, 'accountId', 'email']) ||
        !hasOptionalStrings(record, ['accountId', 'email'])
      ) {
        return null;
      }
      break;
    case 'claude-code':
    case 'xai-grok-oauth':
      if (
        !hasOnlyFields(record, [...commonFields, 'email']) ||
        !hasOptionalStrings(record, ['email'])
      ) {
        return null;
      }
      break;
    case 'github-copilot':
      if (
        !hasOnlyFields(record, [...commonFields, 'enterpriseUrl']) ||
        !hasOptionalStrings(record, ['enterpriseUrl'])
      ) {
        return null;
      }
      break;
    case 'zed':
      if (
        !hasOnlyFields(record, [
          ...commonFields,
          'baseUrl',
          'organizationId',
          'dataCollection',
          'dataCollectionAllowed',
          'email',
        ]) ||
        !hasOptionalStrings(record, [
          'baseUrl',
          'organizationId',
          'email',
        ]) ||
        (record['dataCollection'] !== undefined &&
          typeof record['dataCollection'] !== 'boolean') ||
        (record['dataCollectionAllowed'] !== undefined &&
          typeof record['dataCollectionAllowed'] !== 'boolean')
      ) {
        return null;
      }
      break;
  }

  return parseSessionAuthConfig({
    ...record,
    bindingId: createAuthBindingId(),
  });
}

export function parseAuthTransferConfig(
  value: unknown,
): AuthRuntimeConfig | null {
  if (!isRecord(value)) return null;
  const commonFields = ['label', 'description'] as const;
  if (!hasOptionalStrings(value, commonFields)) return null;

  switch (value['method']) {
    case 'none':
      return hasOnlyFields(value, ['method']) ? { method: 'none' } : null;
    case 'api-key':
      return hasOnlyFields(value, [
        'method',
        ...commonFields,
        'apiKey',
      ]) && hasOptionalStrings(value, ['apiKey'])
        ? {
            method: 'api-key',
            ...(typeof value['label'] === 'string'
              ? { label: value['label'] }
              : {}),
            ...(typeof value['description'] === 'string'
              ? { description: value['description'] }
              : {}),
            ...(typeof value['apiKey'] === 'string'
              ? { apiKey: value['apiKey'] }
              : {}),
          }
        : null;
    case 'google-vertex-ai-auth': {
      const common = {
        ...(typeof value['label'] === 'string'
          ? { label: value['label'] }
          : {}),
        ...(typeof value['description'] === 'string'
          ? { description: value['description'] }
          : {}),
      };
      switch (value['subType']) {
        case 'adc':
          return hasOnlyFields(value, [
            'method',
            'subType',
            ...commonFields,
            'projectId',
            'location',
          ]) &&
            isNonEmptyString(value['projectId']) &&
            isNonEmptyString(value['location'])
            ? {
                method: 'google-vertex-ai-auth',
                subType: 'adc',
                ...common,
                projectId: value['projectId'],
                location: value['location'],
              }
            : null;
        case 'service-account':
          return hasOnlyFields(value, [
            'method',
            'subType',
            ...commonFields,
            'keyFilePath',
            'projectId',
            'location',
          ]) &&
            isNonEmptyString(value['keyFilePath']) &&
            isNonEmptyString(value['location']) &&
            hasOptionalStrings(value, ['projectId'])
            ? {
                method: 'google-vertex-ai-auth',
                subType: 'service-account',
                ...common,
                keyFilePath: value['keyFilePath'],
                ...(typeof value['projectId'] === 'string'
                  ? { projectId: value['projectId'] }
                  : {}),
                location: value['location'],
              }
            : null;
        case 'api-key':
          return hasOnlyFields(value, [
            'method',
            'subType',
            ...commonFields,
            'apiKey',
          ]) && hasOptionalStrings(value, ['apiKey'])
            ? {
                method: 'google-vertex-ai-auth',
                subType: 'api-key',
                ...common,
                ...(typeof value['apiKey'] === 'string'
                  ? { apiKey: value['apiKey'] }
                  : {}),
              }
            : null;
        default:
          return null;
      }
    }
    default:
      return parseSessionTransfer(value);
  }
}
