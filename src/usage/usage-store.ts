import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ProviderType } from '../client/definitions';
import type { NormalizedUsage, PersistedUsageState, UsageRecord, UsageRequestOutcome } from './types';

const STATE_KEY = 'usage.state';
const STATE_VERSION = 1;

export interface UsageRecordInput {
  timestamp?: number;
  providerName: string;
  providerType: ProviderType;
  vscodeModelId: string;
  modelId: string;
  modelName?: string;
  outcome: UsageRequestOutcome;
  latencyMs?: number;
  usage?: NormalizedUsage;
}

export interface UsageStoreSyncAdapter {
  forwardRecord(record: UsageRecord): Promise<void>;
  forwardClear(): Promise<void>;
}

export class UsageStore implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  private context: vscode.ExtensionContext | undefined;
  private records: UsageRecord[] = [];
  private persistChain = Promise.resolve();
  private canPersist = true;
  private syncAdapter: UsageStoreSyncAdapter | undefined;
  private readonly pendingRemoteRecords = new Map<string, UsageRecord>();
  private pendingRemoteFlushTimer: ReturnType<typeof setTimeout> | undefined;

  initialize(options: {
    context: vscode.ExtensionContext;
    canPersist?: () => boolean;
    syncAdapter?: UsageStoreSyncAdapter;
  }): void {
    this.disposeRuntime();
    this.context = options.context;
    this.canPersist = options.canPersist?.() ?? true;
    this.syncAdapter = options.syncAdapter;
    this.records = this.normalizePersistedState(
      options.context.globalState.get<PersistedUsageState>(STATE_KEY),
    );
  }

  setCanPersist(value: boolean): void {
    const wasPersisting = this.canPersist;
    this.canPersist = value;
    if (value && !wasPersisting) {
      this.pendingRemoteRecords.clear();
      this.cancelPendingRemoteFlush();
      this.queuePersistState();
    } else if (!value && this.pendingRemoteRecords.size > 0) {
      this.schedulePendingRemoteFlush();
    }
  }

  getRecords(): readonly UsageRecord[] {
    return this.records;
  }

  record(input: UsageRecordInput): void {
    if (!this.context) {
      return;
    }

    const record: UsageRecord = {
      id: randomUUID(),
      timestamp: input.timestamp ?? Date.now(),
      providerName: input.providerName,
      providerType: input.providerType,
      vscodeModelId: input.vscodeModelId,
      modelId: input.modelId,
      modelName: input.modelName,
      outcome: input.outcome,
      latencyMs: input.latencyMs,
      usage: input.usage,
    };

    this.addRecord(record, { persist: this.canPersist });
    if (!this.canPersist) {
      this.forwardRecord(record, { trackPending: true });
    }
  }

  acceptRemoteRecord(record: UsageRecord): void {
    this.pendingRemoteRecords.delete(record.id);
    this.addRecord(record, { persist: this.canPersist });
  }

  replaceRecords(records: readonly UsageRecord[]): void {
    const nextRecords: UsageRecord[] = [];
    const seenIds = new Set<string>();
    for (const record of [...records, ...this.records]) {
      if (!this.isUsageRecord(record) || seenIds.has(record.id)) {
        continue;
      }
      seenIds.add(record.id);
      this.pendingRemoteRecords.delete(record.id);
      nextRecords.push(record);
    }
    for (const record of this.pendingRemoteRecords.values()) {
      if (seenIds.has(record.id)) {
        continue;
      }
      seenIds.add(record.id);
      nextRecords.push(record);
    }
    this.records = nextRecords;
    this.onDidChangeEmitter.fire();
  }

  flushPendingRemoteRecords(): void {
    if (this.pendingRemoteRecords.size === 0) {
      return;
    }
    if (this.canPersist) {
      this.pendingRemoteRecords.clear();
      this.cancelPendingRemoteFlush();
      this.queuePersistState();
      return;
    }
    this.cancelPendingRemoteFlush();
    for (const record of this.pendingRemoteRecords.values()) {
      this.forwardRecord(record, { trackPending: true });
    }
  }

  async clear(): Promise<void> {
    this.records = [];
    this.pendingRemoteRecords.clear();
    this.cancelPendingRemoteFlush();
    if (this.context && this.canPersist) {
      await this.context.globalState.update(STATE_KEY, {
        version: STATE_VERSION,
        records: [],
      } satisfies PersistedUsageState);
    } else if (this.context) {
      await this.syncAdapter?.forwardClear();
    }
    this.onDidChangeEmitter.fire();
  }

  async clearFromRemote(): Promise<void> {
    this.records = [];
    this.pendingRemoteRecords.clear();
    this.cancelPendingRemoteFlush();
    if (this.context && this.canPersist) {
      await this.context.globalState.update(STATE_KEY, {
        version: STATE_VERSION,
        records: [],
      } satisfies PersistedUsageState);
    }
    this.onDidChangeEmitter.fire();
  }

  private normalizePersistedState(value: PersistedUsageState | undefined): UsageRecord[] {
    if (!value || value.version !== STATE_VERSION || !Array.isArray(value.records)) {
      return [];
    }

    return value.records.filter((record): record is UsageRecord => this.isUsageRecord(record));
  }

  private addRecord(record: UsageRecord, options: { persist: boolean }): void {
    if (this.records.some((existing) => existing.id === record.id)) {
      return;
    }

    this.records.push(record);
    if (options.persist) {
      this.queuePersistState();
    }
    this.onDidChangeEmitter.fire();
  }

  private forwardRecord(
    record: UsageRecord,
    options: { trackPending: boolean },
  ): void {
    const syncAdapter = this.syncAdapter;
    if (!syncAdapter) {
      return;
    }
    if (options.trackPending) {
      this.pendingRemoteRecords.set(record.id, record);
    }

    void syncAdapter
      .forwardRecord(record)
      .then(() => {
        if (options.trackPending) {
          this.pendingRemoteRecords.delete(record.id);
        }
      })
      .catch((error) => {
        console.error('[unify-chat-provider] Failed to forward usage record.', error);
        if (options.trackPending && this.pendingRemoteRecords.has(record.id)) {
          this.schedulePendingRemoteFlush();
        }
      });
  }

  private schedulePendingRemoteFlush(): void {
    if (this.pendingRemoteFlushTimer || this.pendingRemoteRecords.size === 0) {
      return;
    }
    this.pendingRemoteFlushTimer = setTimeout(() => {
      this.pendingRemoteFlushTimer = undefined;
      this.flushPendingRemoteRecords();
    }, 2_000);
  }

  private cancelPendingRemoteFlush(): void {
    if (!this.pendingRemoteFlushTimer) {
      return;
    }
    clearTimeout(this.pendingRemoteFlushTimer);
    this.pendingRemoteFlushTimer = undefined;
  }

  private isUsageRecord(record: unknown): record is UsageRecord {
    if (!record || typeof record !== 'object') {
      return false;
    }

    const candidate = record as Partial<UsageRecord>;
    return (
      typeof candidate.id === 'string' &&
      typeof candidate.timestamp === 'number' &&
      Number.isFinite(candidate.timestamp) &&
      typeof candidate.providerName === 'string' &&
      typeof candidate.providerType === 'string' &&
      typeof candidate.vscodeModelId === 'string' &&
      typeof candidate.modelId === 'string' &&
      (candidate.outcome === 'success' ||
        candidate.outcome === 'error' ||
        candidate.outcome === 'cancelled')
    );
  }

  private queuePersistState(): void {
    if (!this.context || !this.canPersist) {
      return;
    }

    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(() => this.saveState())
      .catch((error) => {
        console.error('[unify-chat-provider] Failed to persist usage state.', error);
      });
  }

  private async saveState(): Promise<void> {
    if (!this.context || !this.canPersist) {
      return;
    }

    await this.context.globalState.update(STATE_KEY, {
      version: STATE_VERSION,
      records: this.records,
    } satisfies PersistedUsageState);
  }

  private disposeRuntime(): void {
    this.context = undefined;
    this.records = [];
    this.persistChain = Promise.resolve();
    this.syncAdapter = undefined;
    this.pendingRemoteRecords.clear();
    this.cancelPendingRemoteFlush();
  }

  dispose(): void {
    this.disposeRuntime();
    this.onDidChangeEmitter.dispose();
  }
}

export const usageStore = new UsageStore();
