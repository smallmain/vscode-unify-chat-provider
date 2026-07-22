import * as vscode from 'vscode';
import { t } from '../../i18n';
import { CompletionConfigurationError } from '../model/errors';
import type {
  EditAlgorithmDocument,
  EditAlgorithmDiagnostic,
  EditAlgorithmSyntaxRange,
  EditHistoryEntry,
  EditPredictionTrigger,
  InceptionAlgorithmRequest,
  MistralAlgorithmRequest,
  ZedAlgorithmRequest,
  CompletionSourceContext,
} from '../model/requests';
import type {
  CompletionEditMetadata,
  InceptionAlgorithmResponse,
  MistralAlgorithmResponse,
  ZedAlgorithmResponse,
} from '../model/responses';
import {
  applyTextEdits,
  interpolateTextEdits,
} from './text-edits';
import type {
  CompletionAlgorithm,
  CompletionAlgorithmContext,
  CompletionEnvironmentChangeReason,
  CompletionAlgorithmInput,
  CompletionAlgorithmResult,
  CompletionModel,
  CompletionModelReference,
} from '../types';
import type {
  InceptionAlgorithmOptions,
  MistralAlgorithmOptions,
  ZedAlgorithmOptions,
} from './options';
import { EditPredictionContextCache } from './context';
import { WorkspaceEditHistory } from './history';
import {
  type EditPredictionLifecycle,
  type EditPredictionRejectReason,
  transformEditRangeThroughChange,
} from './lifecycle';
import { documentWorkspacePath } from './workspace-path';

export interface MinimalTextEdit {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly text: string;
}

export function computeMinimalTextEdit(
  before: string,
  after: string,
): MinimalTextEdit | undefined {
  if (before === after) {
    return undefined;
  }
  let prefixLength = 0;
  const sharedLength = Math.min(before.length, after.length);
  while (
    prefixLength < sharedLength &&
    before.charCodeAt(prefixLength) === after.charCodeAt(prefixLength)
  ) {
    prefixLength += 1;
  }
  let suffixLength = 0;
  while (
    suffixLength < before.length - prefixLength &&
    suffixLength < after.length - prefixLength &&
    before.charCodeAt(before.length - suffixLength - 1) ===
      after.charCodeAt(after.length - suffixLength - 1)
  ) {
    suffixLength += 1;
  }
  return {
    startOffset: prefixLength,
    endOffset: before.length - suffixLength,
    text: after.slice(prefixLength, after.length - suffixLength),
  };
}

export function positionAtText(text: string, offset: number): vscode.Position {
  const bounded = Math.max(0, Math.min(text.length, offset));
  const prefix = text.slice(0, bounded);
  const line = prefix.split('\n').length - 1;
  const lineStart = prefix.lastIndexOf('\n') + 1;
  return new vscode.Position(line, bounded - lineStart);
}

export type InterpolatedTextEditResult =
  | { readonly kind: 'edit'; readonly edit: MinimalTextEdit }
  | { readonly kind: 'empty' }
  | { readonly kind: 'interpolated-empty' }
  | { readonly kind: 'failed' };

export function interpolateTextEdit(
  requestSnapshot: string,
  currentSnapshot: string,
  predictedSnapshot: string,
): InterpolatedTextEditResult {
  const prediction = computeMinimalTextEdit(
    requestSnapshot,
    predictedSnapshot,
  );
  if (!prediction) {
    return { kind: 'empty' };
  }
  if (requestSnapshot === currentSnapshot) {
    return { kind: 'edit', edit: prediction };
  }
  if (prediction.startOffset !== prediction.endOffset) {
    return { kind: 'failed' };
  }
  const userEdit = computeMinimalTextEdit(requestSnapshot, currentSnapshot);
  if (
    !userEdit ||
    userEdit.startOffset !== prediction.startOffset ||
    userEdit.endOffset !== prediction.endOffset ||
    !prediction.text.startsWith(userEdit.text)
  ) {
    return { kind: 'failed' };
  }
  const remaining = prediction.text.slice(userEdit.text.length);
  if (!remaining) {
    return { kind: 'interpolated-empty' };
  }
  const offset = prediction.startOffset + userEdit.text.length;
  return {
    kind: 'edit',
    edit: { startOffset: offset, endOffset: offset, text: remaining },
  };
}

function delay(ms: number, token: vscode.CancellationToken): Promise<boolean> {
  if (ms <= 0) {
    return Promise.resolve(!token.isCancellationRequested);
  }
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      subscription.dispose();
      resolve(true);
    }, ms);
    const subscription = token.onCancellationRequested(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription.dispose();
      resolve(false);
    });
  });
}

function documentPath(document: vscode.TextDocument): string | undefined {
  return documentWorkspacePath(
    document,
    vscode.workspace.getWorkspaceFolder(document.uri),
  );
}

function snapshotDocument(
  document: vscode.TextDocument,
  cursorOffset: number,
  syntaxRanges: EditAlgorithmDocument['syntaxRanges'],
  fullSyntaxRanges: EditAlgorithmDocument['fullSyntaxRanges'],
): EditAlgorithmDocument {
  return {
    uri: document.uri.toString(),
    ...(documentPath(document) === undefined
      ? {}
      : { path: documentPath(document) }),
    languageId: document.languageId,
    version: document.version,
    text: document.getText(),
    cursorOffset,
    ...(syntaxRanges?.length ? { syntaxRanges } : {}),
    ...(fullSyntaxRanges?.length ? { fullSyntaxRanges } : {}),
  };
}

function changeHintReason(input: CompletionAlgorithmInput): string | undefined {
  const data: unknown = input.context.changeHint?.data;
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }
  const change = Reflect.get(data, 'change');
  if (typeof change !== 'object' || change === null) {
    return undefined;
  }
  const reason = Reflect.get(change, 'reason');
  return typeof reason === 'string' ? reason : undefined;
}

export function resolveEditPredictionTrigger(
  input: CompletionAlgorithmInput,
): EditPredictionTrigger {
  if (input.context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke) {
    return 'explicit';
  }
  switch (changeHintReason(input)) {
    case 'prediction-accepted':
      return 'prediction_accepted';
    case 'prediction-partially-accepted':
      return 'prediction_partially_accepted';
    case 'provider-changed':
      return 'provider_changed';
    case 'user-info-changed':
      return 'user_info_changed';
    case 'settings-changed':
      return 'settings_changed';
    default:
      return 'buffer_edit';
  }
}

const DIAGNOSTIC_LINES_RANGE = 20;
const MAX_ACTIVE_BUFFER_DIAGNOSTICS = 20;
const DIAGNOSTIC_CONTEXT_TOKENS = 100;

function lineTokenCount(document: vscode.TextDocument, row: number): number {
  return Math.max(1, Math.floor(Buffer.byteLength(document.lineAt(row).text) / 3));
}

function expandDiagnosticRows(
  document: vscode.TextDocument,
  startRow: number,
  endRow: number,
  diagnosticStartOffset: number,
  diagnosticEndOffset: number,
  syntaxRanges: readonly EditAlgorithmSyntaxRange[],
): { readonly start: number; readonly end: number } {
  let start = startRow;
  let end = endRow;
  let remaining = DIAGNOSTIC_CONTEXT_TOKENS;
  let syntaxExpanded = false;
  const containing = syntaxRanges
    .filter(
      (range) =>
        range.startOffset <= diagnosticStartOffset &&
        range.endOffset >= diagnosticEndOffset,
    )
    .sort(
      (left, right) =>
        left.endOffset - left.startOffset - (right.endOffset - right.startOffset),
    );
  for (const range of containing) {
    const boundaryStart = document.positionAt(range.startOffset).line;
    const boundaryEnd = document.positionAt(range.endOffset).line;
    let needed = 0;
    for (let row = boundaryStart; row < start; row += 1) {
      needed += lineTokenCount(document, row);
    }
    for (let row = end + 1; row <= boundaryEnd; row += 1) {
      needed += lineTokenCount(document, row);
    }
    if (needed > remaining) break;
    start = Math.min(start, boundaryStart);
    end = Math.max(end, boundaryEnd);
    remaining -= needed;
    syntaxExpanded = true;
  }
  if (syntaxExpanded) return { start, end };

  while (remaining > 0 && (start > 0 || end < document.lineCount - 1)) {
    let expanded = false;
    if (start > 0) {
      const tokens = lineTokenCount(document, start - 1);
      if (tokens <= remaining) {
        start -= 1;
        remaining -= tokens;
        expanded = true;
      }
    }
    if (end < document.lineCount - 1 && remaining > 0) {
      const tokens = lineTokenCount(document, end + 1);
      if (tokens <= remaining) {
        end += 1;
        remaining -= tokens;
        expanded = true;
      }
    }
    if (!expanded) break;
  }
  return { start, end };
}

function diagnosticsFor(
  document: vscode.TextDocument,
  cursorOffset: number,
  syntaxRanges: readonly EditAlgorithmSyntaxRange[],
): EditAlgorithmDiagnostic[] {
  const text = document.getText();
  const cursorRow = document.positionAt(cursorOffset).line;
  const searchStart = Math.max(0, cursorRow - DIAGNOSTIC_LINES_RANGE);
  const searchEnd = cursorRow + DIAGNOSTIC_LINES_RANGE;
  const diagnostics = vscode.languages?.getDiagnostics?.(document.uri) ?? [];
  return diagnostics
    .filter(
      (diagnostic) =>
        diagnostic.range.end.line >= searchStart &&
        diagnostic.range.start.line <= searchEnd,
    )
    .sort(
      (left, right) =>
        Math.abs(cursorRow - left.range.start.line) +
        Math.abs(cursorRow - left.range.end.line) -
        Math.abs(cursorRow - right.range.start.line) -
        Math.abs(cursorRow - right.range.end.line),
    )
    .slice(0, MAX_ACTIVE_BUFFER_DIAGNOSTICS)
    .map((diagnostic) => {
      const diagnosticStartOffset = document.offsetAt(diagnostic.range.start);
      const diagnosticEndOffset = document.offsetAt(diagnostic.range.end);
      const snippetRows = expandDiagnosticRows(
        document,
        diagnostic.range.start.line,
        diagnostic.range.end.line,
        diagnosticStartOffset,
        diagnosticEndOffset,
        syntaxRanges,
      );
      const snippetStartRow = snippetRows.start;
      const snippetEndRow = snippetRows.end;
      const snippetStartOffset = document.offsetAt(
        new vscode.Position(snippetStartRow, 0),
      );
      const snippetEndOffset = document.offsetAt(
        document.lineAt(snippetEndRow).range.end,
      );
      const isWholeDocument =
        snippetStartOffset === 0 && snippetEndOffset === text.length;
      return {
        severity:
          typeof diagnostic.severity === 'number' ? diagnostic.severity : null,
        message: diagnostic.message,
        snippet: isWholeDocument
          ? ''
          : text.slice(snippetStartOffset, snippetEndOffset),
        snippetStartRow,
        snippetEndRow,
        diagnosticStartRow: diagnostic.range.start.line,
        diagnosticEndRow: diagnostic.range.end.line,
        diagnosticStartByte: isWholeDocument
          ? 0
          : Buffer.byteLength(
              text.slice(snippetStartOffset, diagnosticStartOffset),
            ),
        diagnosticEndByte: isWholeDocument
          ? 0
          : Buffer.byteLength(
              text.slice(snippetStartOffset, diagnosticEndOffset),
            ),
      };
    });
}

type EditAlgorithmResponse =
  | ZedAlgorithmResponse
  | InceptionAlgorithmResponse
  | MistralAlgorithmResponse;

type EditAlgorithmOptions =
  | ZedAlgorithmOptions
  | InceptionAlgorithmOptions
  | MistralAlgorithmOptions;

export type EditAlgorithmKind = 'zed' | 'inception' | 'mistral';

interface TrackedFeedbackItem {
  readonly requestId?: string;
  readonly targetUri: vscode.Uri;
  readonly targetPath?: string;
  readonly requestSnapshot: string;
  readonly predictedSnapshot: string;
  readonly navigationPosition: vscode.Position;
  readonly navigationOffset: number;
  ownsTerminal: boolean;
  shown: boolean;
}

interface CachedPrediction {
  readonly document: EditAlgorithmDocument;
  readonly response: EditAlgorithmResponse;
}

export class EditPredictionAlgorithm implements CompletionAlgorithm {
  private readonly changeEmitter = new vscode.EventEmitter<{
    reason: string;
  }>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly history = new WorkspaceEditHistory();
  private readonly relatedContext = new EditPredictionContextCache();
  private readonly generations = new Map<string, number>();
  private readonly lastRequestAt = new Map<string, number>();
  private readonly feedbackItems = new Map<
    vscode.InlineCompletionItem,
    TrackedFeedbackItem
  >();
  private readonly predictions = new Map<string, CachedPrediction>();
  private readonly documentChangeSubscription: vscode.Disposable | undefined;
  private readonly historySubscription: vscode.Disposable | undefined;

  constructor(
    private readonly kind: EditAlgorithmKind,
    private readonly context: CompletionAlgorithmContext,
    private readonly options: EditAlgorithmOptions,
    private readonly lifecycle?: EditPredictionLifecycle,
  ) {
    this.historySubscription = this.lifecycle
      ? this.history.onDidRecord((entry) => {
          void this.lifecycle?.handleHistoryEntry(entry);
        })
      : undefined;
    this.documentChangeSubscription =
      this.lifecycle &&
      typeof vscode.workspace.onDidChangeTextDocument === 'function'
        ? vscode.workspace.onDidChangeTextDocument((event) => {
            this.lifecycle?.handleDocumentChange(event);
          })
        : undefined;
  }

  handleEnvironmentChange(reason: CompletionEnvironmentChangeReason): void {
    if (this.lifecycle?.shouldRefreshOnEnvironmentChange?.(reason)) {
      this.changeEmitter.fire({ reason });
    }
  }

  async provideInlineCompletions(
    input: CompletionAlgorithmInput,
    token: vscode.CancellationToken,
  ): Promise<CompletionAlgorithmResult | undefined> {
    const uriKey = input.document.uri.toString();
    const generation = (this.generations.get(uriKey) ?? 0) + 1;
    this.generations.set(uriKey, generation);

    if (resolveEditPredictionTrigger(input) === 'buffer_edit') {
      const cached = this.predictions.get(uriKey);
      if (cached) {
        const reused = await this.toResult(
          input,
          cached.document,
          cached.response,
        );
        if (reused) return reused;
        this.predictions.delete(uriKey);
      }
    }

    const debounceMs = this.kind === 'mistral' ? 150 : 0;
    const throttleMs = this.kind === 'inception' || this.kind === 'zed' ? 300 : 0;
    const sinceLast = Date.now() - (this.lastRequestAt.get(uriKey) ?? 0);
    const waitMs = Math.max(debounceMs, throttleMs - sinceLast, 0);
    if (!(await delay(waitMs, token))) {
      return undefined;
    }
    if (generation !== this.generations.get(uriKey)) {
      return undefined;
    }
    this.lastRequestAt.set(uriKey, Date.now());

    const cursorOffset = input.document.offsetAt(input.position);
    const cachedContext = this.relatedContext.read(input.document);
    this.relatedContext.refresh(input.document, input.position);
    const document = snapshotDocument(
      input.document,
      cursorOffset,
      cachedContext.syntaxRanges,
      cachedContext.fullSyntaxRanges,
    );
    const editHistory = this.history.read(input.document);
    const request = this.buildRequest(
      input,
      document,
      editHistory,
      cachedContext.relatedFiles,
    );
    let model: CompletionModel;
    try {
      model = await this.resolveModel(request.kind, token);
    } catch {
      return undefined;
    }
    let response: EditAlgorithmResponse;
    try {
      response = await this.completeRequest(model, request, token);
    } catch (error) {
      if (!(error instanceof CompletionConfigurationError)) {
        throw error;
      }
      this.context.reportConfigurationError(
        `${error.code}:${this.options.model.vendor}:${this.options.model.id}`,
        error.message,
      );
      return undefined;
    }
    if (token.isCancellationRequested) {
      this.rejectResponse(response, 'canceled');
      return undefined;
    }
    if (generation !== this.generations.get(uriKey)) {
      this.rejectResponse(response, 'canceled');
      return undefined;
    }
    const hasStructuredDeletion =
      response.edit?.startOffset !== undefined &&
      response.edit.endOffset !== undefined &&
      response.edit.endOffset > response.edit.startOffset;
    if (
      !response.text &&
      (response.edit?.edits?.length ?? 0) === 0 &&
      !hasStructuredDeletion
    ) {
      this.rejectResponse(response, 'empty');
      return undefined;
    }
    const result = await this.toResult(input, document, response);
    if (result) {
      this.predictions.set(uriKey, { document, response });
    }
    return result;
  }

  handleDidShowCompletionItem(item: vscode.InlineCompletionItem): void {
    const feedback = this.feedbackItems.get(item);
    if (feedback) feedback.shown = true;
  }

  handleDidPartiallyAcceptCompletionItem(): void {
    this.predictions.clear();
    this.changeEmitter.fire({ reason: 'prediction-partially-accepted' });
  }

  handleEndOfLifetime(
    item: vscode.InlineCompletionItem,
    reason: vscode.InlineCompletionEndOfLifeReason,
  ): void {
    const feedback = this.feedbackItems.get(item);
    this.feedbackItems.delete(item);
    const requestId = feedback?.requestId;
    if (reason.kind === vscode.InlineCompletionEndOfLifeReasonKind.Accepted) {
      if (requestId) this.lifecycle?.accept(requestId);
      if (feedback) {
        this.history.recordAcceptedPrediction({
          uri: feedback.targetUri,
          ...(feedback.targetPath === undefined
            ? {}
            : { path: feedback.targetPath }),
          before: feedback.requestSnapshot,
          after: feedback.predictedSnapshot,
        });
        if (feedback.targetUri.toString() !== vscode.window.activeTextEditor?.document.uri.toString()) {
          if (requestId && feedback.targetPath) {
            this.lifecycle?.recordNavigation(requestId, {
              path: feedback.targetPath,
              predictedSnapshot: feedback.predictedSnapshot,
              navigationOffset: feedback.navigationOffset,
            });
          }
          void vscode.window
            .showTextDocument(feedback.targetUri)
            .then((editor) => {
              editor.selection = new vscode.Selection(
                feedback.navigationPosition,
                feedback.navigationPosition,
              );
            });
        }
      }
      this.predictions.clear();
      this.changeEmitter.fire({ reason: 'prediction-accepted' });
    } else if (
      reason.kind === vscode.InlineCompletionEndOfLifeReasonKind.Rejected
    ) {
      if (requestId && feedback?.ownsTerminal) {
        this.lifecycle?.reject(requestId, 'rejected', feedback?.shown ?? true);
      }
      this.removeCachedPrediction(requestId);
    } else if (requestId && feedback?.ownsTerminal) {
      this.lifecycle?.reject(
        requestId,
        reason.supersededBy ? 'replaced' : 'discarded',
        feedback?.shown ?? false,
      );
      this.removeCachedPrediction(requestId);
    }
  }

  handleDiscardedCompletionItems(
    items: readonly vscode.InlineCompletionItem[],
  ): void {
    for (const item of items) {
      const requestId = this.feedbackItems.get(item)?.requestId;
      const ownsTerminal = this.feedbackItems.get(item)?.ownsTerminal === true;
      this.feedbackItems.delete(item);
      if (requestId && ownsTerminal) {
        this.lifecycle?.reject(requestId, 'current_preferred', false);
        this.removeCachedPrediction(requestId);
      }
    }
  }

  updateOptions(normalizedOptions: unknown): boolean {
    return normalizedOptions === this.options;
  }

  dispose(): void {
    for (const feedback of this.feedbackItems.values()) {
      if (feedback.requestId && feedback.ownsTerminal) {
        this.lifecycle?.reject(
          feedback.requestId,
          'discarded',
          feedback.shown,
        );
      }
    }
    this.feedbackItems.clear();
    this.documentChangeSubscription?.dispose();
    this.historySubscription?.dispose();
    this.lifecycle?.dispose();
    this.predictions.clear();
    this.history.dispose();
    this.relatedContext.dispose();
    this.changeEmitter.dispose();
  }

  private buildRequest(
    input: CompletionAlgorithmInput,
    document: EditAlgorithmDocument,
    editHistory: readonly EditHistoryEntry[],
    contexts: readonly CompletionSourceContext[],
  ): ZedAlgorithmRequest | InceptionAlgorithmRequest | MistralAlgorithmRequest {
    switch (this.kind) {
      case 'zed': {
        const options = this.options as ZedAlgorithmOptions;
        return {
          kind: 'zed',
          document,
          trigger: resolveEditPredictionTrigger(input),
          editHistory,
          contexts,
          diagnostics: diagnosticsFor(
            input.document,
            document.cursorOffset,
            document.fullSyntaxRanges ?? [],
          ),
          maxTokens: options.maxTokens,
        };
      }
      case 'inception':
        return {
          kind: 'inception',
          document,
          editHistory,
          contexts,
        };
      case 'mistral': {
        const options = this.options as MistralAlgorithmOptions;
        return {
          kind: 'mistral',
          document,
          maxTokens: options.maxTokens,
        };
      }
    }
  }

  private async completeRequest(
    model: CompletionModel,
    request: ZedAlgorithmRequest | InceptionAlgorithmRequest | MistralAlgorithmRequest,
    token: vscode.CancellationToken,
  ): Promise<EditAlgorithmResponse> {
    switch (request.kind) {
      case 'zed':
        return await model.complete(request, token);
      case 'inception':
        return await model.complete(request, token);
      case 'mistral':
        return await model.complete(request, token);
    }
  }

  private async resolveModel(
    sourceKind: EditAlgorithmKind,
    token: vscode.CancellationToken,
  ): Promise<CompletionModel> {
    const reference: CompletionModelReference = this.options.model;
    try {
      const eligibility =
        await this.context.modelResolver.evaluateModelForRequest?.(
          reference,
          sourceKind,
        );
      if (eligibility && !eligibility.eligible) {
        throw new CompletionConfigurationError(
          eligibility.code ?? 'completion-model-not-found',
          eligibility.message ?? t('The selected completion model is unavailable.'),
        );
      }
      return await this.context.modelResolver.resolveCompletionModel(
        reference,
        token,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.context.reportConfigurationError(
        `model:${reference.vendor}:${reference.id}`,
        message,
      );
      throw error;
    }
  }

  private async toResult(
    input: CompletionAlgorithmInput,
    requestDocument: EditAlgorithmDocument,
    response: EditAlgorithmResponse,
  ): Promise<CompletionAlgorithmResult | undefined> {
    if (this.kind === 'mistral') {
      const predicted = `${requestDocument.text.slice(
        0,
        requestDocument.cursorOffset,
      )}${response.text}${requestDocument.text.slice(
        requestDocument.cursorOffset,
      )}`;
      const resolved = interpolateTextEdit(
        requestDocument.text,
        input.document.getText(),
        predicted,
      );
      if (resolved.kind !== 'edit') {
        return undefined;
      }
      const range = new vscode.Range(
        input.document.positionAt(resolved.edit.startOffset),
        input.document.positionAt(resolved.edit.endOffset),
      );
      const item = new vscode.InlineCompletionItem(resolved.edit.text, range);
      item.isInlineEdit = true;
      return { providerId: this.context.entry.id, items: [item] };
    }

    const target = await this.resolveTargetDocument(input.document, response.edit);
    if (!target) {
      this.rejectResponse(response, 'interpolate_failed');
      return undefined;
    }
    const sameDocument = target.uri.toString() === requestDocument.uri;
    const requestSnapshot = sameDocument
      ? requestDocument.text
      : response.edit?.requestSnapshot;
    if (requestSnapshot === undefined) {
      this.rejectResponse(response, 'interpolate_failed');
      return undefined;
    }
    const predictedSnapshot = this.predictedSnapshot(
      requestSnapshot,
      response.text,
      response.edit,
    );
    if (predictedSnapshot === undefined) {
      this.rejectResponse(response, 'interpolate_failed');
      return undefined;
    }
    const resolved = this.interpolateResponse(
      requestSnapshot,
      target.getText(),
      predictedSnapshot,
      response.edit,
    );
    if (resolved.kind !== 'edit') {
      this.rejectResponse(
        response,
        resolved.kind === 'empty'
          ? 'empty'
          : resolved.kind === 'interpolated-empty'
            ? 'interpolated_empty'
            : 'interpolate_failed',
      );
      return undefined;
    }
    const edit = resolved.edit;
    if (
      edit.startOffset < 0 ||
      edit.endOffset < edit.startOffset ||
      edit.endOffset > target.getText().length
    ) {
      return undefined;
    }
    const range = new vscode.Range(
      target.positionAt(edit.startOffset),
      target.positionAt(edit.endOffset),
    );
    const item = new vscode.InlineCompletionItem(edit.text, range);
    item.isInlineEdit = true;
    if (target.uri.toString() !== input.document.uri.toString()) {
      item.uri = target.uri;
    }
    if (response.edit?.jumpOffset !== undefined) {
      item.jumpToPosition = positionAtText(
        resolved.predictedSnapshot,
        response.edit.jumpOffset,
      );
    }
    this.feedbackItems.set(item, {
      ...(response.edit?.requestId === undefined
        ? {}
        : { requestId: response.edit.requestId }),
      targetUri: target.uri,
      ...(documentPath(target) === undefined
        ? {}
        : { targetPath: documentPath(target) }),
      requestSnapshot,
      predictedSnapshot: resolved.predictedSnapshot,
      navigationPosition: positionAtText(
        resolved.predictedSnapshot,
        response.edit?.jumpOffset ?? edit.startOffset,
      ),
      navigationOffset: response.edit?.jumpOffset ?? edit.startOffset,
      ownsTerminal: true,
      shown: false,
    });
    const requestId = response.edit?.requestId;
    if (requestId) {
      for (const [existingItem, existing] of this.feedbackItems) {
        if (existingItem !== item && existing.requestId === requestId) {
          existing.ownsTerminal = false;
        }
      }
      this.attachLifecycleCapture(
        requestId,
        target,
        requestSnapshot,
        resolved.predictedSnapshot,
        response.edit,
      );
    }
    return {
      providerId: this.context.entry.id,
      items: [item],
      metadata: {
        ...(response.edit?.requestId === undefined
          ? {}
          : { requestId: response.edit.requestId }),
        ...(response.edit?.modelVersion === undefined
          ? {}
          : { modelVersion: response.edit.modelVersion }),
      },
    };
  }

  private predictedSnapshot(
    requestSnapshot: string,
    text: string,
    edit: CompletionEditMetadata | undefined,
  ): string | undefined {
    if (edit?.edits !== undefined) {
      const applied = applyTextEdits(requestSnapshot, edit.edits);
      return applied === text ? applied : undefined;
    }
    if (edit?.startOffset === undefined || edit.endOffset === undefined) {
      return text;
    }
    if (
      edit.startOffset < 0 ||
      edit.endOffset < edit.startOffset ||
      edit.endOffset > requestSnapshot.length
    ) {
      return undefined;
    }
    return `${requestSnapshot.slice(0, edit.startOffset)}${text}${requestSnapshot.slice(edit.endOffset)}`;
  }

  private interpolateResponse(
    requestSnapshot: string,
    currentSnapshot: string,
    predictedSnapshot: string,
    metadata: CompletionEditMetadata | undefined,
  ):
    | {
        readonly kind: 'edit';
        readonly edit: MinimalTextEdit;
        readonly predictedSnapshot: string;
      }
    | { readonly kind: 'empty' | 'interpolated-empty' | 'failed' } {
    if (metadata?.edits === undefined) {
      const resolved = interpolateTextEdit(
        requestSnapshot,
        currentSnapshot,
        predictedSnapshot,
      );
      return resolved.kind === 'edit'
        ? {
            kind: 'edit',
            edit: resolved.edit,
            predictedSnapshot,
          }
        : resolved;
    }
    const granular = interpolateTextEdits(
      requestSnapshot,
      currentSnapshot,
      metadata.edits,
    );
    if (granular.kind !== 'edits') {
      return granular.kind === 'interpolated-empty'
        ? { kind: 'interpolated-empty' }
        : granular.kind === 'empty'
          ? { kind: 'empty' }
          : { kind: 'failed' };
    }
    const currentPrediction = applyTextEdits(currentSnapshot, granular.edits);
    if (currentPrediction === undefined) return { kind: 'failed' };
    const edit = computeMinimalTextEdit(currentSnapshot, currentPrediction);
    return edit
      ? { kind: 'edit', edit, predictedSnapshot: currentPrediction }
      : { kind: 'interpolated-empty' };
  }

  private rejectResponse(
    response: EditAlgorithmResponse,
    reason: EditPredictionRejectReason,
  ): void {
    if (response.edit?.requestId) {
      this.lifecycle?.reject(response.edit.requestId, reason, false);
    }
  }

  private removeCachedPrediction(requestId: string | undefined): void {
    if (!requestId) return;
    for (const [uri, prediction] of this.predictions) {
      if (prediction.response.edit?.requestId === requestId) {
        this.predictions.delete(uri);
      }
    }
  }

  private async resolveTargetDocument(
    source: vscode.TextDocument,
    edit: CompletionEditMetadata | undefined,
  ): Promise<vscode.TextDocument | undefined> {
    if (!edit?.targetUri || edit.targetUri === source.uri.toString()) {
      return source;
    }
    let targetUri: vscode.Uri;
    try {
      targetUri = vscode.Uri.parse(edit.targetUri, true);
    } catch {
      return undefined;
    }
    if (!vscode.workspace.getWorkspaceFolder(targetUri)) {
      return undefined;
    }
    try {
      return await vscode.workspace.openTextDocument(targetUri);
    } catch {
      return undefined;
    }
  }

  private attachLifecycleCapture(
    requestId: string,
    document: vscode.TextDocument,
    requestSnapshot: string,
    predictedSnapshot: string,
    metadata: CompletionEditMetadata | undefined,
  ): void {
    if (!this.lifecycle) return;
    const minimal = computeMinimalTextEdit(requestSnapshot, predictedSnapshot);
    if (!minimal) return;
    let startOffset = metadata?.startOffset ?? minimal.startOffset;
    let endOffset = metadata?.endOffset ?? minimal.endOffset;
    const userEdit = computeMinimalTextEdit(requestSnapshot, document.getText());
    if (userEdit) {
      const transformed = transformEditRangeThroughChange(
        startOffset,
        endOffset,
        userEdit.startOffset,
        userEdit.endOffset,
        userEdit.text.length,
      );
      startOffset = transformed.start;
      endOffset = transformed.end;
    }
    const workspaceUri = vscode.workspace
      .getWorkspaceFolder(document.uri)
      ?.uri.toString();
    const editableRegionBeforePrediction =
      metadata?.startOffset !== undefined && metadata.endOffset !== undefined
        ? requestSnapshot.slice(metadata.startOffset, metadata.endOffset)
        : requestSnapshot.slice(minimal.startOffset, minimal.endOffset);
    const predictedEditableRegion =
      metadata?.startOffset !== undefined && metadata.endOffset !== undefined
        ? predictedSnapshot.slice(
            metadata.startOffset,
            metadata.startOffset +
              (predictedSnapshot.length -
                requestSnapshot.length +
                metadata.endOffset -
                metadata.startOffset),
          )
        : minimal.text;
    this.lifecycle.attachCapture(requestId, {
      document,
      ...(workspaceUri === undefined ? {} : { workspaceUri }),
      startOffset,
      endOffset,
      editableRegionBeforePrediction,
      predictedEditableRegion,
    });
  }
}

export const editRuntimeTesting = { diagnosticsFor };
