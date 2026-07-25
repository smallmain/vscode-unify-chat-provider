import type { CopilotBehaviorConfig } from '../behavior-config';

export type NesTriggerReason = 'selectionChange' | 'activeDocumentSwitch';
export type NesOutcome = 'accepted' | 'rejected' | 'ignored' | undefined;

export interface NesTriggerChange {
  readonly reason: NesTriggerReason;
  readonly uuid: string;
}

export interface TriggerClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TriggerTimeout;
}

export interface TriggerTimeout {
  dispose(): void;
}

export interface DocumentChangeEvent {
  readonly uri: string;
  readonly scheme: string;
  readonly documentIdentity: object;
  readonly reason: 'undo' | 'redo' | 'other';
  readonly isTracked: boolean;
}

export interface SelectionChangeEvent {
  readonly uri: string;
  readonly scheme: string;
  readonly documentIdentity: object;
  readonly isNotebookCell: boolean;
  readonly selectionCount: number;
  readonly isEmpty: boolean;
  readonly line: number;
  readonly isTracked: boolean;
}

interface LastChange {
  documentIdentity: object;
  lastEditedTimestamp: number;
  lineNumberTriggers: Map<number, number>;
  consecutiveSelectionChanges: number;
  timeout: TriggerTimeout | undefined;
}

const systemClock: TriggerClock = {
  now: Date.now,
  setTimeout: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    return { dispose: () => clearTimeout(handle) };
  },
};

let fallbackUuidCounter = 0;

function fallbackUuid(): string {
  fallbackUuidCounter += 1;
  return `nes-${Date.now().toString(36)}-${fallbackUuidCounter.toString(36)}`;
}

/**
 * Behavior port of InlineEditTriggerer from the frozen upstream commit. It is
 * VS Code independent so every timing and early-return branch can use a fake
 * clock in deterministic completion-effect tests.
 */
export class InlineEditTriggerState {
  private readonly changes = new Map<string, LastChange>();
  private lastDocumentWithSelection: string | undefined;
  private lastEditTimestamp: number | undefined;
  private lastTriggerTime = 0;
  private lastRejectionTime = Number.NEGATIVE_INFINITY;
  private lastOutcome: NesOutcome;
  private disposed = false;

  constructor(
    private readonly config: CopilotBehaviorConfig['trigger'],
    private readonly emit: (change: NesTriggerChange) => void,
    private readonly clock: TriggerClock = systemClock,
    private readonly createUuid: () => string = fallbackUuid,
  ) {}

  handleDocumentChange(event: DocumentChangeEvent): void {
    if (this.disposed || event.scheme === 'output') {
      return;
    }
    const now = this.clock.now();
    this.lastEditTimestamp = now;
    if (event.reason === 'undo' || event.reason === 'redo') {
      return;
    }
    if (!event.isTracked) {
      return;
    }
    this.deleteChange(event.uri);
    this.changes.set(event.uri, {
      documentIdentity: event.documentIdentity,
      lastEditedTimestamp: now,
      lineNumberTriggers: new Map(),
      consecutiveSelectionChanges: 0,
      timeout: undefined,
    });
  }

  handleSelectionChange(event: SelectionChangeEvent): void {
    if (this.disposed || event.scheme === 'output') {
      return;
    }
    const isSameDocument = this.lastDocumentWithSelection === event.uri;
    this.lastDocumentWithSelection = event.uri;
    if (event.selectionCount !== 1 || !event.isEmpty || !event.isTracked) {
      return;
    }

    const now = this.clock.now();
    if (now - this.lastRejectionTime < this.config.rejectionCooldownMs) {
      this.deleteChange(event.uri);
      return;
    }

    const recent = this.changes.get(event.uri);
    if (!recent) {
      this.maybeTriggerDocumentSwitch(event, isSameDocument, now);
      return;
    }
    if (!isSameDocument) {
      recent.lineNumberTriggers.clear();
    }

    const hasRecentEdit =
      now - recent.lastEditedTimestamp < this.config.recentChangeMs;
    const hasRecentTrigger =
      now - this.lastTriggerTime < this.config.recentChangeMs;
    if (!hasRecentEdit || !hasRecentTrigger) {
      this.maybeTriggerDocumentSwitch(event, isSameDocument, now);
      return;
    }

    const lastLineTrigger = recent.lineNumberTriggers.get(event.line);
    const sameNotebookDocument =
      !event.isNotebookCell || recent.documentIdentity === event.documentIdentity;
    if (
      sameNotebookDocument &&
      lastLineTrigger !== undefined &&
      now - lastLineTrigger < this.config.sameLineCooldownMs
    ) {
      return;
    }

    if (recent.lineNumberTriggers.size > 100) {
      for (const [line, timestamp] of recent.lineNumberTriggers) {
        if (now - timestamp > this.config.recentChangeMs) {
          recent.lineNumberTriggers.delete(line);
        }
      }
    }
    recent.lineNumberTriggers.set(event.line, now);
    recent.documentIdentity = event.documentIdentity;
    this.triggerSelectionChange(recent);
  }

  recordProviderTrigger(): void {
    this.lastTriggerTime = this.clock.now();
  }

  recordOutcome(outcome: Exclude<NesOutcome, undefined>): void {
    this.lastOutcome = outcome;
    if (outcome === 'rejected') {
      this.lastRejectionTime = this.clock.now();
    }
  }

  recordShown(): void {
    this.lastOutcome = undefined;
  }

  getState(): {
    readonly trackedDocuments: number;
    readonly lastTriggerTime: number;
    readonly lastRejectionTime: number;
    readonly lastOutcome: NesOutcome;
  } {
    return {
      trackedDocuments: this.changes.size,
      lastTriggerTime: this.lastTriggerTime,
      lastRejectionTime: this.lastRejectionTime,
      lastOutcome: this.lastOutcome,
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const uri of [...this.changes.keys()]) {
      this.deleteChange(uri);
    }
  }

  private triggerSelectionChange(recent: LastChange): void {
    if (
      recent.consecutiveSelectionChanges < this.config.immediateSelectionChanges
    ) {
      this.fire('selectionChange');
    } else {
      if (recent.timeout !== undefined) {
        recent.timeout.dispose();
      }
      recent.timeout = this.clock.setTimeout(() => {
        recent.timeout = undefined;
        this.fire('selectionChange');
      }, this.config.selectionDebounceMs);
    }
    recent.consecutiveSelectionChanges += 1;
  }

  private maybeTriggerDocumentSwitch(
    event: SelectionChangeEvent,
    isSameDocument: boolean,
    now: number,
  ): boolean {
    if (
      isSameDocument ||
      this.lastEditTimestamp === undefined ||
      now - this.lastEditTimestamp > this.config.documentSwitchMs ||
      this.lastTriggerTime === 0 ||
      now - this.lastTriggerTime > this.config.documentSwitchMs ||
      (this.config.documentSwitchRequiresAcceptance &&
        this.lastOutcome !== 'accepted')
    ) {
      return false;
    }

    this.deleteChange(event.uri);
    this.changes.set(event.uri, {
      documentIdentity: event.documentIdentity,
      lastEditedTimestamp: now,
      lineNumberTriggers: new Map([[event.line, now]]),
      consecutiveSelectionChanges: 0,
      timeout: undefined,
    });
    this.fire('activeDocumentSwitch');
    return true;
  }

  private fire(reason: NesTriggerReason): void {
    if (!this.disposed) {
      this.emit({ reason, uuid: this.createUuid() });
    }
  }

  private deleteChange(uri: string): void {
    const existing = this.changes.get(uri);
    if (existing?.timeout !== undefined) {
      existing.timeout.dispose();
    }
    this.changes.delete(uri);
  }
}
