import * as vscode from 'vscode';
import { normalizeBaseUrlInput } from '../../utils';
import type { ProviderConfig } from '../../types';

export type BedrockConversePreference = 'always' | 'when-tools';

interface PersistedCacheEntry {
  preference: BedrockConversePreference;
  updatedAt: number;
}

interface PersistedCacheState {
  version: 1;
  entries: Record<string, PersistedCacheEntry>;
}

const STATE_KEY = 'bedrock.conversePreferenceCache';
const STATE_VERSION = 1;
const ENTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

class BedrockConversePreferenceCache implements vscode.Disposable {
  private extensionContext?: vscode.ExtensionContext;
  private readonly entries = new Map<string, PersistedCacheEntry>();
  private saveTimer?: ReturnType<typeof setTimeout>;

  async initialize(context: vscode.ExtensionContext): Promise<void> {
    this.extensionContext = context;

    const persisted = context.globalState.get<PersistedCacheState>(STATE_KEY);
    if (!persisted || persisted.version !== STATE_VERSION) {
      return;
    }

    const now = Date.now();
    let changed = false;

    for (const [key, entry] of Object.entries(persisted.entries ?? {})) {
      if (!this.isValidPersistedEntry(entry)) {
        changed = true;
        continue;
      }

      if (now - entry.updatedAt > ENTRY_TTL_MS) {
        changed = true;
        continue;
      }

      this.entries.set(key, entry);
    }

    if (changed) {
      this.scheduleSave();
    }
  }

  get(
    provider: ProviderConfig,
    modelId: string,
  ): BedrockConversePreference | undefined {
    const key = this.buildKey(provider, modelId);
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }

    if (Date.now() - entry.updatedAt > ENTRY_TTL_MS) {
      this.entries.delete(key);
      this.scheduleSave();
      return undefined;
    }

    return entry.preference;
  }

  set(
    provider: ProviderConfig,
    modelId: string,
    preference: BedrockConversePreference,
  ): void {
    const key = this.buildKey(provider, modelId);
    const current = this.entries.get(key);

    if (current?.preference === 'always') {
      return;
    }
    if (current?.preference === preference) {
      this.entries.set(key, {
        preference,
        updatedAt: Date.now(),
      });
      this.scheduleSave();
      return;
    }

    this.entries.set(key, {
      preference,
      updatedAt: Date.now(),
    });
    this.scheduleSave();
  }

  async clear(): Promise<void> {
    if (this.entries.size === 0) {
      return;
    }
    this.entries.clear();
    await this.saveNow();
  }

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    void this.saveNow();
  }

  private isValidPersistedEntry(value: unknown): value is PersistedCacheEntry {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }

    const record = value as Record<string, unknown>;
    const preference = record.preference;
    const updatedAt = record.updatedAt;

    return (
      (preference === 'always' || preference === 'when-tools') &&
      typeof updatedAt === 'number' &&
      Number.isFinite(updatedAt) &&
      updatedAt >= 0
    );
  }

  private buildKey(provider: ProviderConfig, modelId: string): string {
    const authMethod = provider.auth?.method ?? 'none';
    const normalizedBaseUrl = normalizeBaseUrlInput(provider.baseUrl);
    return [provider.name, provider.type, normalizedBaseUrl, authMethod, modelId].join(
      '::',
    );
  }

  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.saveNow();
    }, 500);
  }

  private async saveNow(): Promise<void> {
    if (!this.extensionContext) {
      return;
    }

    const entries: Record<string, PersistedCacheEntry> = {};
    for (const [key, entry] of this.entries) {
      entries[key] = entry;
    }

    const payload: PersistedCacheState = {
      version: STATE_VERSION,
      entries,
    };

    await this.extensionContext.globalState.update(STATE_KEY, payload);
  }
}

export const bedrockConversePreferenceCache =
  new BedrockConversePreferenceCache();
