import * as vscode from 'vscode';
import { normalizeBaseUrlInput } from '../../utils';
import type { ProviderConfig } from '../../types';

interface PersistedCacheEntry {
  maxOutputTokens: number;
  updatedAt: number;
}

interface PersistedCacheState {
  version: 1;
  entries: Record<string, PersistedCacheEntry>;
}

const STATE_KEY = 'bedrock.modelLimitCache';
const STATE_VERSION = 1;
const ENTRY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

class BedrockModelLimitCache implements vscode.Disposable {
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
      if (!this.isValidEntry(entry)) {
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

  get(provider: ProviderConfig, modelId: string): number | undefined {
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
    return entry.maxOutputTokens;
  }

  set(provider: ProviderConfig, modelId: string, maxOutputTokens: number): void {
    if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) {
      return;
    }

    const normalized = Math.trunc(maxOutputTokens);
    const key = this.buildKey(provider, modelId);
    const current = this.entries.get(key);
    if (
      current &&
      current.maxOutputTokens === normalized &&
      Date.now() - current.updatedAt < ENTRY_TTL_MS / 2
    ) {
      return;
    }

    this.entries.set(key, {
      maxOutputTokens: normalized,
      updatedAt: Date.now(),
    });
    this.scheduleSave();
  }

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    void this.saveNow();
  }

  private isValidEntry(value: unknown): value is PersistedCacheEntry {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }

    const record = value as Record<string, unknown>;
    return (
      typeof record.maxOutputTokens === 'number' &&
      Number.isFinite(record.maxOutputTokens) &&
      record.maxOutputTokens > 0 &&
      typeof record.updatedAt === 'number' &&
      Number.isFinite(record.updatedAt) &&
      record.updatedAt >= 0
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

    await this.extensionContext.globalState.update(STATE_KEY, {
      version: STATE_VERSION,
      entries,
    } satisfies PersistedCacheState);
  }
}

export const bedrockModelLimitCache = new BedrockModelLimitCache();
