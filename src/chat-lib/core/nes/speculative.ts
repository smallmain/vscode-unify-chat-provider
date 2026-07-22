export type NesSpeculativeCancelReason =
  | 'rejected'
  | 'ignoredDismissed'
  | 'superseded'
  | 'replaced'
  | 'trajectoryForm'
  | 'trajectoryPrefix'
  | 'trajectoryMiddle'
  | 'trajectorySuffix'
  | 'cacheCleared'
  | 'documentClosed'
  | 'disposed';

export interface NesScheduledSpeculative<T> {
  readonly originRequestId: string;
  readonly documentUri?: string;
  readonly suggestion: T;
}

export interface NesPendingSpeculative<T> {
  readonly documentUri: string;
  readonly postEditContent: string;
  readonly trajectoryPrefix: string;
  readonly trajectorySuffix: string;
  readonly trajectoryNewText: string;
  readonly value: T;
  readonly cancel: (reason: NesSpeculativeCancelReason) => void;
}

export interface NesPendingReuseInput {
  readonly documentUri: string;
  readonly documentText: string;
  readonly cursorOffset: number;
  readonly pendingDocumentUri: string;
  readonly pendingDocumentText: string;
  readonly pendingEditWindow: {
    readonly startOffset: number;
    readonly endOffset: number;
  };
  readonly pendingCancellationRequested: boolean;
}

export function canReuseNesPendingSpeculative(
  input: NesPendingReuseInput,
): boolean {
  return (
    !input.pendingCancellationRequested &&
    input.documentUri === input.pendingDocumentUri &&
    input.documentText === input.pendingDocumentText &&
    input.cursorOffset >= input.pendingEditWindow.startOffset &&
    input.cursorOffset <= input.pendingEditWindow.endOffset
  );
}

export function resolveNesSpeculativeEditWindowLines(
  mode: 'off' | 'always' | 'smart',
  expandedLines: number,
  triggeredBySpeculativeRequest: boolean,
  isSubsequentEdit: boolean,
): number | undefined {
  switch (mode) {
    case 'off':
      return undefined;
    case 'always':
      return expandedLines;
    case 'smart':
      return triggeredBySpeculativeRequest || isSubsequentEdit
        ? expandedLines
        : undefined;
  }
}

export class NesSpeculativeState<TScheduled, TPending> {
  private scheduledValue: NesScheduledSpeculative<TScheduled> | undefined;
  private pendingValue: NesPendingSpeculative<TPending> | undefined;
  private consumedCountValue = 0;
  private lastCancelReasonValue: NesSpeculativeCancelReason | undefined;

  get scheduled(): NesScheduledSpeculative<TScheduled> | undefined {
    return this.scheduledValue;
  }

  get pending(): NesPendingSpeculative<TPending> | undefined {
    return this.pendingValue;
  }

  schedule(value: NesScheduledSpeculative<TScheduled>): void {
    this.scheduledValue = value;
  }

  clearScheduled(originRequestId?: string): void {
    if (
      originRequestId === undefined ||
      this.scheduledValue?.originRequestId === originRequestId
    ) {
      this.scheduledValue = undefined;
    }
  }

  consumeScheduled(
    originRequestId: string,
  ): NesScheduledSpeculative<TScheduled> | undefined {
    if (this.scheduledValue?.originRequestId !== originRequestId) {
      return undefined;
    }
    const scheduled = this.scheduledValue;
    this.scheduledValue = undefined;
    return scheduled;
  }

  setPending(value: NesPendingSpeculative<TPending>): void {
    if (this.pendingValue && this.pendingValue.value !== value.value) {
      this.cancelPending('replaced');
    }
    this.pendingValue = value;
  }

  clearPending(value?: TPending): void {
    if (value === undefined || this.pendingValue?.value === value) {
      this.pendingValue = undefined;
    }
  }

  consumePending(
    documentUri: string,
    documentText: string,
  ): TPending | undefined {
    if (
      this.pendingValue?.documentUri !== documentUri ||
      this.pendingValue.postEditContent !== documentText
    ) {
      return undefined;
    }
    const value = this.pendingValue.value;
    this.pendingValue = undefined;
    this.consumedCountValue += 1;
    return value;
  }

  cancelIfMismatch(documentUri: string, documentText: string): void {
    if (
      this.pendingValue &&
      (this.pendingValue.documentUri !== documentUri ||
        this.pendingValue.postEditContent !== documentText)
    ) {
      this.cancelPending('superseded');
    }
  }

  onDocumentChanged(documentUri: string, currentText: string): void {
    const pending = this.pendingValue;
    if (!pending || pending.documentUri !== documentUri) return;
    if (
      currentText.length <
      pending.trajectoryPrefix.length + pending.trajectorySuffix.length
    ) {
      this.cancelPending('trajectoryForm');
      return;
    }
    if (!currentText.startsWith(pending.trajectoryPrefix)) {
      this.cancelPending('trajectoryPrefix');
      return;
    }
    if (!currentText.endsWith(pending.trajectorySuffix)) {
      this.cancelPending('trajectorySuffix');
      return;
    }
    const middle = currentText.slice(
      pending.trajectoryPrefix.length,
      currentText.length - pending.trajectorySuffix.length,
    );
    if (!pending.trajectoryNewText.startsWith(middle)) {
      this.cancelPending('trajectoryMiddle');
    }
  }

  onDocumentClosed(documentUri: string): void {
    if (this.scheduledValue?.documentUri === documentUri) {
      this.scheduledValue = undefined;
    }
    if (this.pendingValue?.documentUri === documentUri) {
      this.cancelPending('documentClosed');
    }
  }

  cancelAll(reason: NesSpeculativeCancelReason): void {
    this.scheduledValue = undefined;
    this.cancelPending(reason);
  }

  getState(): {
    readonly scheduled: boolean;
    readonly pending: boolean;
    readonly consumed: number;
    readonly lastCancelReason?: NesSpeculativeCancelReason;
  } {
    return {
      scheduled: this.scheduledValue !== undefined,
      pending: this.pendingValue !== undefined,
      consumed: this.consumedCountValue,
      ...(this.lastCancelReasonValue
        ? { lastCancelReason: this.lastCancelReasonValue }
        : {}),
    };
  }

  private cancelPending(reason: NesSpeculativeCancelReason): void {
    const pending = this.pendingValue;
    if (!pending) return;
    this.pendingValue = undefined;
    this.lastCancelReasonValue = reason;
    pending.cancel(reason);
  }
}
