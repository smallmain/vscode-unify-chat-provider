import * as vscode from 'vscode';
import { generateAutoVersionedId } from '../model-id-utils';
import {
  deepClone,
  mergePartialByKeys,
  MODEL_CONFIG_KEYS,
  PROVIDER_CONFIG_KEYS,
  withoutKey,
} from '../config-ops';
import { ProviderConfig, ModelConfig } from '../types';

export type ConfigArrayItem = Record<string, unknown> | string;
export type ConfigValue = Record<string, unknown> | ConfigArrayItem[];

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isConfigArray(value: unknown): value is ConfigArrayItem[] {
  if (!Array.isArray(value)) return false;
  return value.every((item) => typeof item === 'string' || isObjectRecord(item));
}

export function isValidHttpUrl(text: string): boolean {
  try {
    const url = new URL(text.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function fetchConfigFromUrl(
  url: string,
): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }

    const content = await response.text();
    return { ok: true, content };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, error: 'Request timeout' };
    }
    return { ok: false, error: 'Network error' };
  }
}

export function decodeConfigStringToValue(
  text: string,
  options?: { allowArray?: boolean },
): ConfigValue | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const allowArray = options?.allowArray ?? false;

  // 1) Try raw JSON first.
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isObjectRecord(parsed)) {
      return parsed;
    }
    if (allowArray && isConfigArray(parsed)) {
      return parsed;
    }
  } catch {
    // ignore and fall back to Base64
  }

  // 2) Fall back to Base64 / Base64-URL
  const decoded = decodeBase64ToValue(trimmed);
  if (isObjectRecord(decoded)) {
    return decoded;
  }
  if (allowArray && isConfigArray(decoded)) {
    return decoded;
  }
  return undefined;
}

function getInvalidConfigMessage(allowArray: boolean): string {
  if (allowArray) {
    return 'Invalid configuration. Paste a JSON object or array, or a Base64/Base64-URL encoded JSON object or array.';
  }
  return 'Invalid configuration. Paste a JSON object or a Base64/Base64-URL encoded JSON object.';
}

/**
 * Decode a config string to an object.
 *
 * Supports:
 * - Raw JSON object string
 * - Base64 / Base64-URL encoded JSON object string
 */
export function decodeConfigStringToObject<T extends object = object>(
  text: string,
): T | undefined {
  const decoded = decodeConfigStringToValue(text, { allowArray: false });
  if (decoded && isObjectRecord(decoded)) {
    return decoded as T;
  }
  return undefined;
}

/**
 * Encode a configuration object to Base64-URL string.
 * The object is serialized to JSON and then encoded.
 */
export function encodeConfigToBase64(config: object): string {
  const json = JSON.stringify(config);
  // Use Buffer for Node.js environment
  const base64 = Buffer.from(json, 'utf-8').toString('base64');
  // Convert to base64url: replace + with -, / with _, and remove trailing =
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode a Base64 or Base64-URL string to an object.
 * Supports both standard Base64 and Base64-URL formats.
 * @returns The decoded object, or undefined if decoding fails.
 */
export function decodeBase64ToObject<T = object>(
  base64String: string,
): T | undefined {
  try {
    // Normalize base64url to base64
    let normalized = base64String.replace(/-/g, '+').replace(/_/g, '/');
    // Add padding if needed
    const pad = normalized.length % 4;
    if (pad === 2) {
      normalized += '==';
    } else if (pad === 3) {
      normalized += '=';
    }

    const json = Buffer.from(normalized, 'base64').toString('utf-8');
    const obj = JSON.parse(json);

    // Basic validation: must be an object
    if (!isObjectRecord(obj)) {
      return undefined;
    }

    return obj as T;
  } catch {
    return undefined;
  }
}

function decodeBase64ToValue(base64String: string): unknown | undefined {
  try {
    let normalized = base64String.replace(/-/g, '+').replace(/_/g, '/');
    const pad = normalized.length % 4;
    if (pad === 2) {
      normalized += '==';
    } else if (pad === 3) {
      normalized += '=';
    }

    const json = Buffer.from(normalized, 'base64').toString('utf-8');
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/**
 * Try to get a valid config string from clipboard.
 * Supports JSON object string and Base64/Base64-URL encoded JSON.
 *
 * @returns The decoded object if valid, undefined otherwise.
 */
export async function tryGetBase64ConfigFromClipboard<
  T extends object = object,
>(): Promise<T | undefined> {
  try {
    const clipboardText = await vscode.env.clipboard.readText();
    if (!clipboardText || clipboardText.length > 100000) {
      return undefined;
    }
    return decodeConfigStringToObject<T>(clipboardText.trim());
  } catch {
    return undefined;
  }
}

/**
 * Try to get a valid config from clipboard.
 * Supports JSON object string and Base64/Base64-URL encoded JSON.
 */
export async function tryGetConfigFromClipboard<
  T extends object = object,
>(): Promise<T | undefined> {
  try {
    const clipboardText = await vscode.env.clipboard.readText();
    if (!clipboardText || clipboardText.length > 100000) {
      return undefined;
    }
    return decodeConfigStringToObject<T>(clipboardText.trim());
  } catch {
    return undefined;
  }
}

/**
 * Try to get a valid config value from clipboard.
 * Supports JSON object/array string and Base64/Base64-URL encoded JSON.
 */
export async function tryGetConfigValueFromClipboard(): Promise<
  ConfigValue | undefined
> {
  try {
    const clipboardText = await vscode.env.clipboard.readText();
    if (!clipboardText || clipboardText.length > 100000) {
      return undefined;
    }
    return decodeConfigStringToValue(clipboardText.trim(), {
      allowArray: true,
    });
  } catch {
    return undefined;
  }
}

/**
 * Export a configuration as Base64 string to clipboard.
 */
export async function copyConfigAsBase64(config: object): Promise<void> {
  const base64 = encodeConfigToBase64(config);
  await vscode.env.clipboard.writeText(base64);
}

/**
 * Show an input dialog to get a config string.
 * Pre-fills with clipboard content if it's a valid config.
 */
export async function promptForBase64Config<
  T extends object = object,
>(options: { title: string; placeholder?: string }): Promise<T | undefined> {
  const clipboardConfig = await tryGetConfigFromClipboard<T>();

  const inputBox = vscode.window.createInputBox();
  inputBox.title = options.title;
  inputBox.placeholder =
    options.placeholder ?? 'Paste configuration JSON or Base64 string...';
  inputBox.ignoreFocusOut = true;

  // Pre-fill with clipboard if valid
  if (clipboardConfig) {
    const clipboardText = await vscode.env.clipboard.readText();
    inputBox.value = clipboardText.trim();
    inputBox.validationMessage = undefined;
  }

  return new Promise<T | undefined>((resolve) => {
    let resolved = false;

    const finish = (result: T | undefined) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    inputBox.onDidChangeValue((text) => {
      if (!text.trim()) {
        inputBox.validationMessage = undefined;
        return;
      }
      const decoded = decodeConfigStringToObject<T>(text.trim());
      if (!decoded) {
        inputBox.validationMessage = getInvalidConfigMessage(false);
      } else {
        inputBox.validationMessage = undefined;
      }
    });

    inputBox.onDidAccept(() => {
      const text = inputBox.value.trim();
      if (!text) {
        finish(undefined);
        inputBox.hide();
        return;
      }

      const decoded = decodeConfigStringToObject<T>(text);
      if (!decoded) {
        inputBox.validationMessage = getInvalidConfigMessage(false);
        return;
      }

      finish(decoded);
      inputBox.hide();
    });

    inputBox.onDidHide(() => {
      finish(undefined);
      inputBox.dispose();
    });

    inputBox.show();
  });
}

/**
 * Show an input dialog to get a config value (object or array).
 * Pre-fills with clipboard content if it's a valid config.
 */
export async function promptForConfigValue(options: {
  title: string;
  placeholder?: string;
  validate?: (value: ConfigValue) => string | null;
}): Promise<ConfigValue | undefined> {
  const clipboardConfig = await tryGetConfigValueFromClipboard();

  const inputBox = vscode.window.createInputBox();
  inputBox.title = options.title;
  inputBox.placeholder =
    options.placeholder ?? 'Paste URL, JSON, or Base64 configuration...';
  inputBox.ignoreFocusOut = true;

  const validateDecoded = (decoded: ConfigValue | undefined): string | null => {
    if (!decoded) return null;
    return options.validate ? options.validate(decoded) : null;
  };

  // Pre-fill with clipboard if valid
  if (clipboardConfig) {
    const clipboardText = await vscode.env.clipboard.readText();
    inputBox.value = clipboardText.trim();
    const validation = validateDecoded(clipboardConfig);
    inputBox.validationMessage = validation ?? undefined;
  }

  return new Promise<ConfigValue | undefined>((resolve) => {
    let resolved = false;

    const finish = (result: ConfigValue | undefined) => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    inputBox.onDidChangeValue((text) => {
      const trimmed = text.trim();
      if (!trimmed) {
        inputBox.validationMessage = undefined;
        return;
      }

      // URL input: no validation message during typing
      if (isValidHttpUrl(trimmed)) {
        inputBox.validationMessage = undefined;
        return;
      }

      const decoded = decodeConfigStringToValue(trimmed, {
        allowArray: true,
      });
      if (!decoded) {
        inputBox.validationMessage = getInvalidConfigMessage(true);
      } else {
        const validation = validateDecoded(decoded);
        inputBox.validationMessage = validation ?? undefined;
      }
    });

    inputBox.onDidAccept(async () => {
      const text = inputBox.value.trim();
      if (!text) {
        finish(undefined);
        inputBox.hide();
        return;
      }

      // Handle URL input
      if (isValidHttpUrl(text)) {
        inputBox.busy = true;
        inputBox.enabled = false;

        const result = await fetchConfigFromUrl(text);

        inputBox.busy = false;
        inputBox.enabled = true;

        if (!result.ok) {
          inputBox.validationMessage = `Failed to fetch: ${result.error}`;
          return;
        }

        const decoded = decodeConfigStringToValue(result.content, {
          allowArray: true,
        });
        if (!decoded) {
          inputBox.validationMessage = getInvalidConfigMessage(true);
          return;
        }

        const validation = validateDecoded(decoded);
        if (validation) {
          inputBox.validationMessage = validation;
          return;
        }

        finish(decoded);
        inputBox.hide();
        return;
      }

      const decoded = decodeConfigStringToValue(text, { allowArray: true });
      if (!decoded) {
        inputBox.validationMessage = getInvalidConfigMessage(true);
        return;
      }

      const validation = validateDecoded(decoded);
      if (validation) {
        inputBox.validationMessage = validation;
        return;
      }

      finish(decoded);
      inputBox.hide();
    });

    inputBox.onDidHide(() => {
      finish(undefined);
      inputBox.dispose();
    });

    inputBox.show();
  });
}

/**
 * Show a dialog displaying the config string (already copied to clipboard).
 */
export async function showCopiedBase64Config(config: object): Promise<void> {
  const base64 = encodeConfigToBase64(config);
  await vscode.env.clipboard.writeText(base64);
  vscode.window.showInformationMessage(
    'Configuration string has been exported to clipboard.',
  );

  const inputBox = vscode.window.createInputBox();
  inputBox.title = 'Base64 Configuration';
  inputBox.prompt = 'You can copy and share this exported configuration string.';
  inputBox.value = base64;
  inputBox.ignoreFocusOut = false;

  return new Promise<void>((resolve) => {
    inputBox.onDidAccept(() => {
      inputBox.hide();
    });
    inputBox.onDidHide(() => {
      inputBox.dispose();
      resolve();
    });
    inputBox.show();
  });
}

/**
 * Merge partial config into a provider draft.
 * Only copies properties that exist in the source.
 */
export function mergePartialProviderConfig(
  draft: Partial<ProviderConfig>,
  source: Partial<ProviderConfig>,
): void {
  mergePartialByKeys(draft, source, withoutKey(PROVIDER_CONFIG_KEYS, 'models'));

  const models = source.models;
  if (models !== undefined && Array.isArray(models)) {
    draft.models = deepClone(models);
  }
}

/**
 * Merge partial config into a model draft.
 * Only copies properties that exist in the source.
 */
export function mergePartialModelConfig(
  draft: Partial<ModelConfig>,
  source: Partial<ModelConfig>,
): void {
  mergePartialByKeys(draft, source, MODEL_CONFIG_KEYS);
}

/**
 * Duplicate a model with auto-incremented ID.
 */
export function duplicateModel(
  model: ModelConfig,
  existingModels: ModelConfig[],
): ModelConfig {
  const newId = generateAutoVersionedId(model.id, existingModels);
  const cloned = deepClone(model);
  cloned.id = newId;
  return cloned;
}
