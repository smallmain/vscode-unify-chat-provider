import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ProviderType } from '../client/definitions';
import { isUsageRecord, isUsageStoreState, isUsageTotals } from './guards';
import {
  addUsageRecordToTotals,
  createUsageTotals,
  mergeUsageTotals,
} from './usage-aggregates';
import type {
  NormalizedUsage,
  PersistedUsageState,
  UsageRecord,
  UsageRequestOutcome,
  UsageStoreState,
  UsageTotals,
} from './types';

const STATE_KEY = 'usage.state';
const STATE_VERSION = 1;
const PERSIST_DEBOUNCE_MS = 1_000;
const DEFAULT_DETAIL_RETENTION_DAYS = 100;
const MIN_DETAIL_RETENTION_DAYS = 1;
const DAY_MS = 24 * 60 * 60 * 1_000;

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
  private archivedTotals: UsageTotals = createUsageTotals();
  private readonly archivedRecordIds = new Set<string>();
  private records: UsageRecord[] = [];
  private detailRetentionDays = DEFAULT_DETAIL_RETENTION_DAYS;
  private persistChain = Promise.resolve();
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private canPersist = true;
  private syncAdapter: UsageStoreSyncAdapter | undefined;
  private readonly pendingRemoteRecords = new Map<string, UsageRecord>();
  private pendingRemoteFlushTimer: ReturnType<typeof setTimeout> | undefined;

  initialize(options: {
    context: vscode.ExtensionContext;
    canPersist?: () => boolean;
    syncAdapter?: UsageStoreSyncAdapter;
    detailRetentionDays: number;
  }): void {
    this.disposeRuntime();
    this.context = options.context;
    this.canPersist = options.canPersist?.() ?? true;
    this.syncAdapter = options.syncAdapter;
    this.detailRetentionDays = normalizeRetentionDays(options.detailRetentionDays);
    const state = this.normalizePersistedState(
      options.context.globalState.get<PersistedUsageState>(STATE_KEY),
    );
    this.archivedTotals = state.archivedTotals;
    this.archivedRecordIds.clear();
    this.records = state.records;
    if (this.applyRetention() && this.canPersist) {
      this.queuePersistState();
    }
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

  getState(): UsageStoreState {
    return this.createStateSnapshot();
  }

  getHistoricalTotals(): UsageTotals {
    const activeTotals = createUsageTotals();
    for (const record of this.records) {
      addUsageRecordToTotals(activeTotals, record);
    }
    return mergeUsageTotals(this.archivedTotals, activeTotals);
  }

  setDetailRetentionDays(days: number): void {
    const nextDays = normalizeRetentionDays(days);
    if (nextDays === this.detailRetentionDays) {
      return;
    }

    this.detailRetentionDays = nextDays;
    const changed = this.applyRetention();
    if (changed) {
      this.queuePersistState();
      this.onDidChangeEmitter.fire();
    }
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
    this.archivedTotals = createUsageTotals();
    this.archivedRecordIds.clear();
    const nextRecords: UsageRecord[] = [];
    const seenIds = new Set<string>();
    for (const record of [...records, ...this.records]) {
      if (!isUsageRecord(record) || seenIds.has(record.id)) {
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
    this.applyRetention();
    this.onDidChangeEmitter.fire();
  }

  replaceState(state: UsageStoreState): void {
    if (!isUsageStoreState(state)) {
      return;
    }

    this.archivedTotals = { ...state.archivedTotals };
    this.archivedRecordIds.clear();
    const nextRecords: UsageRecord[] = [];
    const seenIds = new Set<string>();
    for (const record of state.records) {
      if (seenIds.has(record.id)) {
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
    this.applyRetention();
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
    this.archivedTotals = createUsageTotals();
    this.archivedRecordIds.clear();
    this.records = [];
    this.pendingRemoteRecords.clear();
    this.cancelPersistTimer();
    this.cancelPendingRemoteFlush();
    if (this.context && this.canPersist) {
      await this.queuePersistSnapshot(this.context, this.createStateSnapshot());
    } else if (this.context) {
      await this.syncAdapter?.forwardClear();
    }
    this.onDidChangeEmitter.fire();
  }

  async clearFromRemote(): Promise<void> {
    this.archivedTotals = createUsageTotals();
    this.archivedRecordIds.clear();
    this.records = [];
    this.pendingRemoteRecords.clear();
    this.cancelPersistTimer();
    this.cancelPendingRemoteFlush();
    if (this.context && this.canPersist) {
      await this.queuePersistSnapshot(this.context, this.createStateSnapshot());
    }
    this.onDidChangeEmitter.fire();
  }

  private normalizePersistedState(value: unknown): UsageStoreState {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return createEmptyState();
    }

    const persisted = value as Partial<PersistedUsageState>;
    if (persisted.version !== STATE_VERSION || !Array.isArray(persisted.records)) {
      return createEmptyState();
    }

    return {
      archivedTotals: isUsageTotals(persisted.archivedTotals)
        ? { ...persisted.archivedTotals }
        : createUsageTotals(),
      records: persisted.records.filter(isUsageRecord),
    };
  }

  private addRecord(record: UsageRecord, options: { persist: boolean }): void {
    if (this.records.some((existing) => existing.id === record.id)) {
      return;
    }
    if (this.archivedRecordIds.has(record.id)) {
      return;
    }

    if (record.timestamp < this.getRetentionCutoff()) {
      addUsageRecordToTotals(this.archivedTotals, record);
      this.archivedRecordIds.add(record.id);
    } else {
      this.records.push(record);
    }
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

  private queuePersistState(): void {
    if (!this.context || !this.canPersist) {
      return;
    }

    if (this.persistTimer) {
      return;
    }

    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.queuePersistStateNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  private queuePersistStateNow(): void {
    const context = this.context;
    if (!context || !this.canPersist) {
      return;
    }

    void this.queuePersistSnapshot(context, this.createStateSnapshot());
  }

  private queuePersistSnapshot(
    context: vscode.ExtensionContext,
    state: UsageStoreState,
  ): Promise<void> {
    const snapshot = {
      archivedTotals: { ...state.archivedTotals },
      records: [...state.records],
    };
    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(() => this.saveState(context, snapshot))
      .catch((error) => {
        console.error('[unify-chat-provider] Failed to persist usage state.', error);
      });
    return this.persistChain;
  }

  private async saveState(
    context: vscode.ExtensionContext,
    state: UsageStoreState,
  ): Promise<void> {
    await context.globalState.update(STATE_KEY, {
      version: STATE_VERSION,
      archivedTotals: { ...state.archivedTotals },
      records: [...state.records],
    } satisfies PersistedUsageState);
  }

  private createStateSnapshot(): UsageStoreState {
    return {
      archivedTotals: { ...this.archivedTotals },
      records: [...this.records],
    };
  }

  private applyRetention(): boolean {
    const cutoff = this.getRetentionCutoff();
    const retained: UsageRecord[] = [];
    let changed = false;

    for (const record of this.records) {
      if (record.timestamp < cutoff) {
        addUsageRecordToTotals(this.archivedTotals, record);
        this.archivedRecordIds.add(record.id);
        changed = true;
      } else {
        retained.push(record);
      }
    }

    if (changed) {
      this.records = retained;
    }
    return changed;
  }

  private getRetentionCutoff(): number {
    return Date.now() - this.detailRetentionDays * DAY_MS;
  }

  private disposeRuntime(): void {
    if (this.persistTimer && this.context && this.canPersist) {
      this.cancelPersistTimer();
      this.queuePersistStateNow();
    }
    this.cancelPersistTimer();
    this.context = undefined;
    this.archivedTotals = createUsageTotals();
    this.archivedRecordIds.clear();
    this.records = [];
    this.persistChain = Promise.resolve();
    this.syncAdapter = undefined;
    this.pendingRemoteRecords.clear();
    this.cancelPendingRemoteFlush();
  }

  private cancelPersistTimer(): void {
    if (!this.persistTimer) {
      return;
    }
    clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
  }

  dispose(): void {
    this.disposeRuntime();
    this.onDidChangeEmitter.dispose();
  }
}

function createEmptyState(): UsageStoreState {
  return {
    archivedTotals: createUsageTotals(),
    records: [],
  };
}

function normalizeRetentionDays(value: number): number {
  return Number.isInteger(value) &&
    Number.isFinite(value) &&
    value >= MIN_DETAIL_RETENTION_DAYS
    ? value
    : DEFAULT_DETAIL_RETENTION_DAYS;
}

export const usageStore = new UsageStore();
