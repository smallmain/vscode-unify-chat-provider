import * as vscode from 'vscode';
import type { ConfigStore } from '../config-store';
import type { ModelConfig } from '../types';
import {
  getBaseModelId,
  generateAutoVersion,
  createVersionedModelId,
} from '../model-id-utils';

/**
 * Conflict resolution options
 */
export type ConflictResolution = 'overwrite' | 'rename' | 'cancel';

/**
 * Conflict information for prompting user
 */
export interface ConflictInfo {
  kind: 'provider' | 'model';
  conflicts: string[];
}

/**
 * Prompt user to resolve conflicts with existing configurations.
 */
export async function promptConflictResolution(
  info: ConflictInfo,
): Promise<ConflictResolution> {
  const itemType = info.kind === 'provider' ? 'provider' : 'model';
  const itemField = info.kind === 'provider' ? 'name' : 'ID';
  const conflictList = info.conflicts.map((c) => `• ${c}`).join('\n');

  const message = `The following ${itemType} ${itemField}s already exist:\n${conflictList}`;

  const choice = await vscode.window.showWarningMessage(
    message,
    { modal: true },
    'Overwrite All',
    'Rename All',
  );

  if (choice === 'Overwrite All') return 'overwrite';
  if (choice === 'Rename All') return 'rename';
  return 'cancel';
}

/**
 * Generate a unique provider name by appending (copy), (copy 2), etc.
 * Reuses the duplicate logic from provider-ops.ts.
 */
export function generateUniqueProviderName(
  baseName: string,
  store: ConfigStore,
): string {
  if (!store.getProvider(baseName)) {
    return baseName;
  }

  let newName = `${baseName} (copy)`;
  let counter = 2;

  while (store.getProvider(newName)) {
    newName = `${baseName} (copy ${counter})`;
    counter++;
  }

  return newName;
}

/**
 * Result of generating unique model ID and name.
 */
export interface UniqueModelResult {
  id: string;
  name?: string;
}

/**
 * Generate a unique model ID and name.
 * ID uses #1, #2 suffix, name uses (1), (2) suffix with matching version.
 * Example: model#1 -> model (1)
 */
export function generateUniqueModelIdAndName(
  modelId: string,
  modelName: string | undefined,
  existingModels: ModelConfig[],
): UniqueModelResult {
  const baseId = getBaseModelId(modelId);
  const version = generateAutoVersion(baseId, existingModels);
  const newId = createVersionedModelId(baseId, version);

  let newName: string | undefined;
  if (modelName) {
    newName = `${modelName} (${version})`;
  }

  return { id: newId, name: newName };
}
