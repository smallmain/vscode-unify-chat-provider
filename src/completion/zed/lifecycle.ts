import * as vscode from 'vscode';
import type { EditHistoryEntry } from '../model/requests';
import type { CompletionEnvironmentChangeReason } from '../types';
import {
  type EditPredictionLifecycle,
  type EditPredictionLifecycleCapture,
  type EditPredictionLifecycleNavigation,
  type EditPredictionRejectReason,
  transformEditRangeThroughChange,
} from '../edit/lifecycle';
import { utf16OffsetToUtf8ByteOffset } from '../edit/utf8';
import {
  acceptZedPrediction,
  attachZedPredictionCapture,
  markZedPredictionCaptureEdited,
  recordZedPredictionFutureEvent,
  recordZedPredictionNavigation,
  rejectZedPrediction,
} from './feedback';
import {
  isZedFileEligibleForDataCollection,
  isZedPrivatePath,
} from './privacy';
import { toZedBufferChangeEvent } from './wire';

interface TrackedCapture {
  readonly document: vscode.TextDocument;
  readonly workspaceUri?: string;
  startOffset: number;
  endOffset: number;
}

export class ZedEditPredictionLifecycle implements EditPredictionLifecycle {
  private readonly captures = new Map<string, TrackedCapture>();

  shouldRefreshOnEnvironmentChange(
    _reason: CompletionEnvironmentChangeReason,
  ): boolean {
    return true;
  }

  accept(requestId: string): void {
    acceptZedPrediction(requestId);
  }

  reject(
    requestId: string,
    reason: EditPredictionRejectReason,
    wasShown: boolean,
  ): void {
    rejectZedPrediction(requestId, reason, wasShown);
  }

  recordNavigation(
    requestId: string,
    navigation: EditPredictionLifecycleNavigation,
  ): void {
    recordZedPredictionNavigation(
      requestId,
      {
        path: navigation.path,
        cursor_position: utf16OffsetToUtf8ByteOffset(
          navigation.predictedSnapshot,
          navigation.navigationOffset,
        ),
      },
      !isZedPrivatePath(navigation.path),
    );
  }

  attachCapture(
    requestId: string,
    input: EditPredictionLifecycleCapture,
  ): void {
    const capture: TrackedCapture = {
      document: input.document,
      workspaceUri: input.workspaceUri,
      startOffset: input.startOffset,
      endOffset: input.endOffset,
    };
    this.captures.set(requestId, capture);
    const attached = attachZedPredictionCapture(requestId, {
      editableRegionBeforePrediction: input.editableRegionBeforePrediction,
      predictedEditableRegion: input.predictedEditableRegion,
      readSettledEditableRegion: () => {
        const current = this.captures.get(requestId);
        if (!current) return undefined;
        const text = current.document.getText();
        if (
          current.startOffset < 0 ||
          current.endOffset < current.startOffset ||
          current.endOffset > text.length
        ) {
          return undefined;
        }
        return text.slice(current.startOffset, current.endOffset);
      },
      dispose: () => {
        if (this.captures.get(requestId) === capture) {
          this.captures.delete(requestId);
        }
      },
    });
    if (!attached && this.captures.get(requestId) === capture) {
      this.captures.delete(requestId);
    }
  }

  async handleHistoryEntry(entry: EditHistoryEntry): Promise<void> {
    if (this.captures.size === 0 || !entry.path || !entry.uri) return;
    let workspaceUri: string | undefined;
    try {
      workspaceUri = vscode.workspace
        .getWorkspaceFolder(vscode.Uri.parse(entry.uri, true))
        ?.uri.toString();
    } catch {
      return;
    }
    if (!workspaceUri) return;
    const requestIds = [...this.captures]
      .filter(([, capture]) => capture.workspaceUri === workspaceUri)
      .map(([requestId]) => requestId);
    if (requestIds.length === 0) return;

    const isInOpenSourceRepo = await isZedFileEligibleForDataCollection(
      entry.uri,
      entry.path,
    );
    const event = toZedBufferChangeEvent(
      entry,
      entry.path,
      isInOpenSourceRepo,
    );
    for (const requestId of requestIds) {
      if (this.captures.has(requestId)) {
        recordZedPredictionFutureEvent(requestId, event);
      }
    }
  }

  handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    if (this.captures.size === 0) return;
    const changes = [...event.contentChanges].sort(
      (left, right) => left.rangeOffset - right.rangeOffset,
    );
    for (const [requestId, capture] of this.captures) {
      if (capture.document.uri.toString() !== event.document.uri.toString()) {
        continue;
      }
      let cumulativeDelta = 0;
      let overlaps = false;
      for (const change of changes) {
        const changeStart = change.rangeOffset + cumulativeDelta;
        const changeEnd = changeStart + change.rangeLength;
        const transformed = transformEditRangeThroughChange(
          capture.startOffset,
          capture.endOffset,
          changeStart,
          changeEnd,
          change.text.length,
        );
        overlaps ||= transformed.overlaps;
        capture.startOffset = transformed.start;
        capture.endOffset = transformed.end;
        cumulativeDelta += change.text.length - change.rangeLength;
      }
      if (overlaps) markZedPredictionCaptureEdited(requestId);
    }
  }

  dispose(): void {
    this.captures.clear();
  }
}
