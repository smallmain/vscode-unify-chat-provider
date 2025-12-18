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
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      return undefined;
    }

    return obj as T;
  } catch {
    return undefined;
  }
}

/**
 * Try to get a valid Base64 config from clipboard.
 * @returns The decoded object if valid, undefined otherwise.
 */
export async function tryGetBase64ConfigFromClipboard<T = object>(): Promise<
  T | undefined
> {
  try {
    const clipboardText = await vscode.env.clipboard.readText();
    if (!clipboardText || clipboardText.length > 100000) {
      return undefined;
    }
    return decodeBase64ToObject<T>(clipboardText.trim());
  } catch {
    return undefined;
  }
}

/**
 * Copy a configuration as Base64 string to clipboard.
 */
export async function copyConfigAsBase64(config: object): Promise<void> {
  const base64 = encodeConfigToBase64(config);
  await vscode.env.clipboard.writeText(base64);
}

/**
 * Show an input dialog to get Base64 config string.
 * Pre-fills with clipboard content if it's a valid Base64 config.
 */
export async function promptForBase64Config<T = object>(options: {
  title: string;
  placeholder?: string;
}): Promise<T | undefined> {
  const clipboardConfig = await tryGetBase64ConfigFromClipboard<T>();

  const inputBox = vscode.window.createInputBox();
  inputBox.title = options.title;
  inputBox.placeholder =
    options.placeholder ?? 'Paste Base64 configuration string...';
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
      const decoded = decodeBase64ToObject<T>(text.trim());
      if (!decoded) {
        inputBox.validationMessage =
          'Invalid Base64 string or not a valid configuration';
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

      const decoded = decodeBase64ToObject<T>(text);
      if (!decoded) {
        inputBox.validationMessage =
          'Invalid Base64 string or not a valid configuration';
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
 * Show a dialog displaying the Base64 config string (already copied to clipboard).
 */
export async function showCopiedBase64Config(config: object): Promise<void> {
  const base64 = encodeConfigToBase64(config);
  await vscode.env.clipboard.writeText(base64);
  vscode.window.showInformationMessage(
    'Base64 configuration has been copied to clipboard.',
  );

  const inputBox = vscode.window.createInputBox();
  inputBox.title = 'Base64 Configuration';
  inputBox.prompt = 'You can copy and share this configuration string';
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
