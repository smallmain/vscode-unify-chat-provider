import { ModelConfig } from './types';

/**
 * Delimiter used to separate base model ID from version.
 * Example: "claude-sonnet-4-5#thinking" -> base="claude-sonnet-4-5", version="thinking"
 */
export const MODEL_VERSION_DELIMITER = '#';
export const VSCODE_MODEL_ID_SEPARATOR = '/';

export interface VSCodeModelIdParts {
  providerName: string;
  modelName: string;
}

/**
 * Parse a model ID into base ID and optional version.
 * @example
 * parseModelIdParts('claude-sonnet-4-5#thinking') => { baseId: 'claude-sonnet-4-5', version: 'thinking' }
 * parseModelIdParts('claude-sonnet-4-5') => { baseId: 'claude-sonnet-4-5', version: undefined }
 */
export function parseModelIdParts(id: string): {
  baseId: string;
  version?: string;
} {
  const delimiterIndex = id.indexOf(MODEL_VERSION_DELIMITER);
  if (delimiterIndex === -1) {
    return { baseId: id };
  }

  const baseId = id.slice(0, delimiterIndex);
  const version = id.slice(delimiterIndex + 1);

  // Empty version is invalid, treat as no version
  if (!version) {
    return { baseId: id };
  }

  return { baseId, version };
}

/**
 * Get the base model ID (for API requests).
 * Strips any version delimiter and version string.
 * @example
 * getBaseModelId('claude-sonnet-4-5#thinking') => 'claude-sonnet-4-5'
 * getBaseModelId('claude-sonnet-4-5') => 'claude-sonnet-4-5'
 */
export function getBaseModelId(id: string): string {
  return parseModelIdParts(id).baseId;
}

/**
 * Check if a model ID has a version suffix.
 * @example
 * hasVersion('claude-sonnet-4-5#thinking') => true
 * hasVersion('claude-sonnet-4-5') => false
 * hasVersion('claude-sonnet-4-5#') => false (empty version)
 */
export function hasVersion(id: string): boolean {
  return parseModelIdParts(id).version !== undefined;
}

/**
 * Create a versioned model ID.
 * @example
 * createVersionedModelId('claude-sonnet-4-5', 'thinking') => 'claude-sonnet-4-5#thinking'
 * createVersionedModelId('claude-sonnet-4-5', '1') => 'claude-sonnet-4-5#1'
 */
export function createVersionedModelId(
  baseId: string,
  version: string,
): string {
  return `${baseId}${MODEL_VERSION_DELIMITER}${version}`;
}

/**
 * Generate the next available auto version number for a base model ID.
 * Looks at existing models and finds the next available numeric version.
 * @returns The version string (e.g., "1", "2", "3")
 * @example
 * // If existing models have: claude-sonnet-4-5, claude-sonnet-4-5#1
 * generateAutoVersion('claude-sonnet-4-5', existingModels) => '2'
 */
export function generateAutoVersion(
  baseModelId: string,
  existingModels: ModelConfig[],
): string {
  let maxVersion = 0;

  for (const model of existingModels) {
    const { baseId, version } = parseModelIdParts(model.id);

    if (baseId === baseModelId) {
      if (version !== undefined) {
        // Try to parse as number
        const numVersion = parseInt(version, 10);
        if (!isNaN(numVersion) && numVersion > maxVersion) {
          maxVersion = numVersion;
        }
      }
    }
  }

  return String(maxVersion + 1);
}

/**
 * Generate a full model ID with auto-generated version.
 * @example
 * // If existing models have: claude-sonnet-4-5, claude-sonnet-4-5#1
 * generateAutoVersionedId('claude-sonnet-4-5', existingModels) => 'claude-sonnet-4-5#2'
 */
export function generateAutoVersionedId(
  baseModelId: string,
  existingModels: ModelConfig[],
): string {
  const version = generateAutoVersion(baseModelId, existingModels);
  return createVersionedModelId(baseModelId, version);
}

/**
 * Check if the base model ID (ignoring version) already exists in the list.
 */
export function isBaseModelIdUsed(
  baseModelId: string,
  existingModels: ModelConfig[],
  excludeId?: string,
): boolean {
  return existingModels.some((m) => {
    if (m.id === excludeId) return false;
    return getBaseModelId(m.id) === baseModelId;
  });
}

export function encodeVsCodeProviderSegment(providerName: string): string {
  return providerName.replace(/%/g, '%25').replace(/\//g, '%2F');
}

export function decodeVsCodeProviderSegment(segment: string): string | null {
  let decoded = '';

  for (let index = 0; index < segment.length; index++) {
    const char = segment[index];
    if (char !== '%') {
      decoded += char;
      continue;
    }

    const escape = segment.slice(index, index + 3).toUpperCase();
    if (escape === '%25') {
      decoded += '%';
      index += 2;
      continue;
    }
    if (escape === '%2F') {
      decoded += '/';
      index += 2;
      continue;
    }

    return null;
  }

  return decoded;
}

export function createVsCodeModelId(
  providerName: string,
  modelId: string,
): string {
  return `${encodeVsCodeProviderSegment(providerName)}${VSCODE_MODEL_ID_SEPARATOR}${modelId}`;
}

export function parseVsCodeModelId(
  modelId: string,
): VSCodeModelIdParts | null {
  const separatorIndex = modelId.indexOf(VSCODE_MODEL_ID_SEPARATOR);
  if (separatorIndex === -1) {
    return null;
  }

  const providerSegment = modelId.slice(0, separatorIndex);
  const providerName = decodeVsCodeProviderSegment(providerSegment);
  if (providerName === null) {
    return null;
  }

  return {
    providerName,
    modelName: modelId.slice(separatorIndex + 1),
  };
}

export function createLegacyVsCodeModelId(
  providerName: string,
  modelId: string,
): string {
  return `${encodeURIComponent(providerName)}${VSCODE_MODEL_ID_SEPARATOR}${modelId}`;
}
