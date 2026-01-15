import * as vscode from 'vscode';
import { SecretStore } from './secret-store';
import {
  isSecretRef,
  extractUuidFromStorageKey,
  buildRefFromUuid,
  SECRET_KEY_PREFIXES,
} from './constants';

const CONFIG_NAMESPACE = 'unifyChatProvider';

function collectSecretRefsFromAny(raw: unknown, refs: Set<string>): void {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed && isSecretRef(trimmed)) {
      refs.add(trimmed);
    }
    return;
  }

  if (!raw || typeof raw !== 'object') {
    return;
  }

  if (Array.isArray(raw)) {
    for (const item of raw) {
      collectSecretRefsFromAny(item, refs);
    }
    return;
  }

  for (const value of Object.values(raw as Record<string, unknown>)) {
    collectSecretRefsFromAny(value, refs);
  }
}

function collectUsedSecretRefsFromAllScopes(): Set<string> {
  const refs = new Set<string>();

  const addFromRaw = (raw: unknown): void => {
    collectSecretRefsFromAny(raw, refs);
  };

  const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  const inspection = config.inspect<unknown[]>('endpoints');

  addFromRaw(inspection?.globalValue);
  addFromRaw(inspection?.workspaceValue);
  addFromRaw(inspection?.workspaceFolderValue);

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const folderConfig = vscode.workspace.getConfiguration(
      CONFIG_NAMESPACE,
      folder.uri,
    );
    const folderInspection = folderConfig.inspect<unknown[]>('endpoints');
    addFromRaw(folderInspection?.workspaceFolderValue);
  }

  return refs;
}

export async function cleanupUnusedSecrets(
  secretStore: SecretStore,
): Promise<void> {
  const allKeys = await secretStore.getAllKeys();
  if (allKeys.length === 0) {
    return;
  }

  const usedRefs = collectUsedSecretRefsFromAllScopes();

  const toDelete: string[] = [];

  for (const key of allKeys) {
    const isSupportedKey =
      key.startsWith(SECRET_KEY_PREFIXES.apiKey) ||
      key.startsWith(SECRET_KEY_PREFIXES.oauth2ClientSecret) ||
      key.startsWith(SECRET_KEY_PREFIXES.oauth2Token);

    if (!isSupportedKey) {
      continue;
    }

    const uuid = extractUuidFromStorageKey(key);
    if (!uuid) {
      toDelete.push(key);
      continue;
    }

    const ref = buildRefFromUuid(uuid);
    if (!isSecretRef(ref)) {
      toDelete.push(key);
      continue;
    }

    if (!usedRefs.has(ref)) {
      toDelete.push(key);
    }
  }

  if (toDelete.length === 0) {
    return;
  }

  await Promise.all(toDelete.map((key) => secretStore.deleteByKey(key)));
}
