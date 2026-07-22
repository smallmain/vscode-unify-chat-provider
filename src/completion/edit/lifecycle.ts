import type * as vscode from 'vscode';
import type { EditHistoryEntry } from '../model/requests';
import type { CompletionEnvironmentChangeReason } from '../types';

export type EditPredictionRejectReason =
  | 'canceled'
  | 'empty'
  | 'interpolated_empty'
  | 'interpolate_failed'
  | 'patch_apply_failed'
  | 'replaced'
  | 'current_preferred'
  | 'discarded'
  | 'rejected';

export interface EditPredictionLifecycleNavigation {
  readonly path: string;
  readonly predictedSnapshot: string;
  readonly navigationOffset: number;
}

export interface EditPredictionLifecycleCapture {
  readonly document: vscode.TextDocument;
  readonly workspaceUri?: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly editableRegionBeforePrediction: string;
  readonly predictedEditableRegion: string;
}

export interface EditPredictionLifecycle {
  shouldRefreshOnEnvironmentChange?(
    reason: CompletionEnvironmentChangeReason,
  ): boolean;
  accept(requestId: string): void;
  reject(
    requestId: string,
    reason: EditPredictionRejectReason,
    wasShown: boolean,
  ): void;
  recordNavigation(
    requestId: string,
    navigation: EditPredictionLifecycleNavigation,
  ): void;
  attachCapture(
    requestId: string,
    capture: EditPredictionLifecycleCapture,
  ): void;
  handleHistoryEntry(entry: EditHistoryEntry): Promise<void> | void;
  handleDocumentChange(event: vscode.TextDocumentChangeEvent): void;
  dispose(): void;
}

export interface TransformedEditRange {
  readonly start: number;
  readonly end: number;
  readonly overlaps: boolean;
}

export function transformEditRangeThroughChange(
  rangeStart: number,
  rangeEnd: number,
  changeStart: number,
  changeEnd: number,
  insertedLength: number,
): TransformedEditRange {
  const delta = insertedLength - (changeEnd - changeStart);
  if (
    changeStart === changeEnd &&
    changeStart >= rangeStart &&
    changeStart <= rangeEnd
  ) {
    return {
      start: rangeStart,
      end: rangeEnd + insertedLength,
      overlaps: true,
    };
  }
  if (changeEnd <= rangeStart) {
    return {
      start: rangeStart + delta,
      end: rangeEnd + delta,
      overlaps: changeEnd === rangeStart,
    };
  }
  if (changeStart >= rangeEnd) {
    return {
      start: rangeStart,
      end: rangeEnd,
      overlaps: changeStart === rangeEnd,
    };
  }
  return {
    start: Math.min(rangeStart, changeStart),
    end: Math.max(changeStart + insertedLength, rangeEnd + delta),
    overlaps: true,
  };
}
