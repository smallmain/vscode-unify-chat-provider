import * as vscode from 'vscode';
import type { NesTextEdit } from '../../chat-lib/core/nes/types';
import { COPILOT_BEHAVIOR_CONFIG } from '../../chat-lib/core/behavior-config';
import {
  applyOffsetTextReplacements,
  getInformationDelta,
  InformationDelta,
  type OffsetTextReplacement,
} from '../../chat-lib/core/information-delta';

interface DocumentSnapshot {
  readonly uri: string;
  readonly version: number;
  readonly text: string;
}

interface OffsetRange {
  readonly start: number;
  readonly end: number;
}

interface RecentDocumentHistory {
  baselineText: string;
  currentText: string;
  ranges: OffsetRange[];
  recentRanges: OffsetRange[];
  edits: readonly (readonly OffsetTextReplacement[])[];
  editCount: number;
}

interface DiagnosticsWorkerState {
  readonly key: string;
  readonly source: vscode.CancellationTokenSource;
  readonly promise: Promise<DiagnosticsNesSuggestion | undefined>;
  workInProgress: boolean;
  result?: DiagnosticsNesSuggestion;
}

interface DiagnosticsTreatments {
  readonly useAlternativeNotebookFormat: boolean;
  readonly javaImportDiagnostics: boolean;
}

type ImportSource = 'local' | 'unknown' | 'external';

interface ImportDetails {
  readonly importName: string;
  readonly importPath: string;
  readonly labelShort: string;
  readonly labelDeduped: string;
  readonly importSource: ImportSource;
}

interface CandidateAction {
  readonly action: vscode.CodeAction;
  readonly edit: NesTextEdit;
  readonly kind: DiagnosticsNesSuggestion['kind'];
  readonly importDetails?: ImportDetails;
  readonly hasExistingSameFileImport: boolean;
}

export interface DiagnosticsNesSuggestion {
  readonly source: 'diagnostics';
  readonly kind: 'import' | 'async';
  readonly id: string;
  readonly rejectionKey: string;
  readonly edit: NesTextEdit;
  readonly command?: vscode.Command;
  readonly title: string;
  readonly sourceDocument: DocumentSnapshot;
  readonly targetDocument: DocumentSnapshot;
  readonly importName?: string;
  readonly diagnostic: {
    readonly uri: string;
    readonly message: string;
    readonly code?: string;
    readonly start: number;
    readonly end: number;
  };
  readonly displayLocation?: {
    readonly uri: string;
    readonly range: vscode.Range;
    readonly label: string;
  };
}

const ASYNC_LANGUAGES = new Set([
  'typescript',
  'javascript',
  'typescriptreact',
  'javascriptreact',
]);
const IMPORT_LANGUAGES = new Set([
  ...ASYNC_LANGUAGES,
  'python',
  'java',
]);
const JAVASCRIPT_IMPORT_IGNORES = new Set([
  'type',
  'namespace',
  'module',
  'declare',
  'abstract',
  'from',
  'of',
  'require',
  'async',
]);
export const DIAGNOSTICS_BACKGROUND_DELAY_MS = 20;

function cancellableDelay(
  delayMs: number,
  token: vscode.CancellationToken,
): Promise<boolean> {
  if (token.isCancellationRequested) {
    return Promise.resolve(false);
  }
  if (delayMs <= 0) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let subscription: vscode.Disposable | undefined;
    const handle = setTimeout(() => {
      subscription?.dispose();
      resolve(!token.isCancellationRequested);
    }, delayMs);
    subscription = token.onCancellationRequested(() => {
      clearTimeout(handle);
      subscription?.dispose();
      resolve(false);
    });
  });
}

function awaitWithCancellation<T>(
  promise: Promise<T>,
  token: vscode.CancellationToken,
): Promise<T | undefined> {
  if (token.isCancellationRequested) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve, reject) => {
    let subscription: vscode.Disposable | undefined;
    subscription = token.onCancellationRequested(() => {
      subscription?.dispose();
      resolve(undefined);
    });
    promise.then(
      (value) => {
        subscription?.dispose();
        resolve(value);
      },
      (error: unknown) => {
        subscription?.dispose();
        reject(error);
      },
    );
  });
}

function snapshot(document: vscode.TextDocument): DocumentSnapshot {
  return {
    uri: document.uri.toString(),
    version: document.version,
    text: document.getText(),
  };
}

function diagnosticCode(diagnostic: vscode.Diagnostic): string | undefined {
  if (diagnostic.code === undefined) {
    return undefined;
  }
  return typeof diagnostic.code === 'object'
    ? String(diagnostic.code.value)
    : String(diagnostic.code);
}

function lineDistance(
  diagnostic: vscode.Diagnostic,
  position: vscode.Position,
): number {
  if (diagnostic.range.contains(position)) {
    return 0;
  }
  return Math.min(
    Math.abs(diagnostic.range.start.line - position.line),
    Math.abs(diagnostic.range.end.line - position.line),
  );
}

function rangesIntersectOrTouch(left: OffsetRange, right: OffsetRange): boolean {
  return left.start <= right.end && right.start <= left.end;
}

function transformOffset(
  offset: number,
  changes: readonly vscode.TextDocumentContentChangeEvent[],
  affinity: 'left' | 'right',
): number {
  let delta = 0;
  for (const change of changes) {
    const start = change.rangeOffset;
    const end = start + change.rangeLength;
    if (offset < start || (offset === start && affinity === 'left')) {
      break;
    }
    if (offset < end || (offset === end && affinity === 'left')) {
      return start + delta + (affinity === 'right' ? change.text.length : 0);
    }
    delta += change.text.length - change.rangeLength;
  }
  return offset + delta;
}

function updateRecentHistory(
  previous: RecentDocumentHistory | undefined,
  before: string,
  after: string,
  contentChanges: readonly vscode.TextDocumentContentChangeEvent[],
): RecentDocumentHistory {
  const changes = [...contentChanges].sort(
    (left, right) => left.rangeOffset - right.rangeOffset,
  );
  const canExtend = previous?.currentText === before && previous.editCount < 100;
  const existingRanges = canExtend ? previous.ranges : [];
  const transformed = existingRanges.map((range) => ({
    start: transformOffset(range.start, changes, 'left'),
    end: transformOffset(range.end, changes, 'right'),
  }));
  let delta = 0;
  const added = changes.map((change) => {
    const start = change.rangeOffset + delta;
    const end = start + change.text.length;
    delta += change.text.length - change.rangeLength;
    return { start, end };
  });
  const eventEdit = changes.map((change) => ({
    startOffset: change.rangeOffset,
    endOffset: change.rangeOffset + change.rangeLength,
    newText: change.text,
  }));
  return {
    baselineText: canExtend ? previous.baselineText : before,
    currentText: after,
    ranges: [...transformed, ...added],
    recentRanges: [...(canExtend ? previous.recentRanges : []), ...added].slice(-5),
    edits: [...(canExtend ? previous.edits : []), eventEdit],
    editCount: (canExtend ? previous.editCount : 0) + changes.length,
  };
}

function actionFixesDiagnostic(
  action: vscode.CodeAction,
  diagnostic: vscode.Diagnostic,
): boolean {
  return (
    !action.diagnostics ||
    action.diagnostics.length === 0 ||
    action.diagnostics.some(
      (candidate) =>
        candidate.message === diagnostic.message &&
        candidate.range.isEqual(diagnostic.range),
    )
  );
}

function joinTextEdits(
  document: vscode.TextDocument,
  edits: readonly vscode.TextEdit[],
): NesTextEdit | undefined {
  if (edits.length === 0) {
    return undefined;
  }
  const sorted = [...edits].sort(
    (left, right) =>
      document.offsetAt(left.range.start) - document.offsetAt(right.range.start),
  );
  const startOffset = Math.min(
    ...sorted.map((edit) => document.offsetAt(edit.range.start)),
  );
  const endOffset = Math.max(
    ...sorted.map((edit) => document.offsetAt(edit.range.end)),
  );
  let newText = document.getText().slice(startOffset, endOffset);
  for (const edit of [...sorted].reverse()) {
    const start = document.offsetAt(edit.range.start) - startOffset;
    const end = document.offsetAt(edit.range.end) - startOffset;
    newText = `${newText.slice(0, start)}${edit.newText}${newText.slice(end)}`;
  }
  if (newText === document.getText().slice(startOffset, endOffset)) {
    return undefined;
  }
  return {
    uri: document.uri.toString(),
    startOffset,
    endOffset,
    newText,
    kind: startOffset === endOffset ? 'insert' : 'replace',
  };
}

function javascriptImportDetails(
  action: vscode.CodeAction,
  importName: string,
  nodeModules: ReadonlySet<string>,
): ImportDetails | undefined {
  const prefix = ['Add import from', 'Update import from'].find((candidate) =>
    action.title.startsWith(candidate),
  );
  if (!prefix) {
    return undefined;
  }
  const pathAsInTitle = action.title.slice(prefix.length).trim();
  const importPath =
    (pathAsInTitle.startsWith('"') && pathAsInTitle.endsWith('"')) ||
    (pathAsInTitle.startsWith("'") && pathAsInTitle.endsWith("'")) ||
    (pathAsInTitle.startsWith('`') && pathAsInTitle.endsWith('`'))
      ? pathAsInTitle.slice(1, -1)
      : pathAsInTitle;
  const moduleRoot = importPath.split('/')[0];
  const importSource: ImportSource =
    importPath.startsWith('./') || importPath.startsWith('../')
      ? 'local'
      : importPath.includes(':') || nodeModules.has(importPath) || nodeModules.has(moduleRoot)
        ? 'external'
        : 'unknown';
  if (
    importSource !== 'local' &&
    (JAVASCRIPT_IMPORT_IGNORES.has(importName) ||
      (importSource === 'external' && importPath.includes('/')) ||
      (importSource === 'external' && importName === importName.toLowerCase()))
  ) {
    return undefined;
  }
  return {
    importName,
    importPath,
    labelShort: `import ${importName}`,
    labelDeduped: `import ${importName} from ${pathAsInTitle}`,
    importSource,
  };
}

function pythonImportDetails(action: vscode.CodeAction): ImportDetails | undefined {
  const fromImport = action.title.match(/Add "from\s+(.+?)\s+import\s(.+?)"/);
  if (fromImport) {
    const importPath = fromImport[1];
    const importName = fromImport[2];
    return {
      importName,
      importPath,
      labelShort: `import ${importName}`,
      labelDeduped: `import from ${importPath}`,
      importSource: importPath.startsWith('.') ? 'local' : 'unknown',
    };
  }
  const importAs = action.title.match(/Add "import\s+(.+?)\s+as\s+(.+?)"/);
  if (importAs) {
    return {
      importName: importAs[1],
      importPath: importAs[1],
      labelShort: `import ${importAs[1]} as ${importAs[2]}`,
      labelDeduped: `import ${importAs[1]} as ${importAs[2]}`,
      importSource: 'unknown',
    };
  }
  const imported = action.title.match(/Add "import\s+(.+?)"/);
  return imported
    ? {
        importName: imported[1],
        importPath: imported[1],
        labelShort: `import ${imported[1]}`,
        labelDeduped: `import ${imported[1]}`,
        importSource: 'unknown',
      }
    : undefined;
}

function javaImportDetails(
  action: vscode.CodeAction,
  importName: string,
): ImportDetails | undefined {
  if (!action.title.startsWith('Import')) {
    return undefined;
  }
  const quoted = [...action.title.matchAll(/['"]([^'"]+)['"]/g)];
  const importPath = quoted.at(-1)?.[1] ?? action.title.slice('Import'.length).trim();
  return {
    importName,
    importPath,
    labelShort: `import ${importName}`,
    labelDeduped: action.title,
    importSource: 'unknown',
  };
}

function importDetailsFor(
  document: vscode.TextDocument,
  diagnostic: vscode.Diagnostic,
  action: vscode.CodeAction,
  nodeModules: ReadonlySet<string>,
): ImportDetails | undefined {
  const importName = document.getText(diagnostic.range);
  if (importName.length < 2) {
    return undefined;
  }
  switch (document.languageId) {
    case 'typescript':
    case 'javascript':
    case 'typescriptreact':
    case 'javascriptreact':
      return diagnostic.message.includes('Cannot find name')
        ? javascriptImportDetails(action, importName, nodeModules)
        : undefined;
    case 'python':
      return diagnostic.message.includes('is not defined')
        ? pythonImportDetails(action)
        : undefined;
    case 'java':
      return diagnosticCode(diagnostic) === '16777218' ||
        diagnostic.message.endsWith('cannot be resolved to a type')
        ? javaImportDetails(action, importName)
        : undefined;
    default:
      return undefined;
  }
}

function importSourceRank(source: ImportSource): number {
  switch (source) {
    case 'local':
      return 0;
    case 'unknown':
      return 1;
    case 'external':
      return 2;
  }
}

function compareImportActions(left: CandidateAction, right: CandidateAction): number {
  if (left.hasExistingSameFileImport !== right.hasExistingSameFileImport) {
    return left.hasExistingSameFileImport ? -1 : 1;
  }
  const leftDetails = left.importDetails;
  const rightDetails = right.importDetails;
  if (!leftDetails || !rightDetails) {
    return 0;
  }
  const sourceDifference =
    importSourceRank(leftDetails.importSource) -
    importSourceRank(rightDetails.importSource);
  if (sourceDifference !== 0) {
    return sourceDifference;
  }
  if (
    leftDetails.importSource !== 'unknown' &&
    rightDetails.importSource !== 'unknown'
  ) {
    return (
      leftDetails.importPath.split('/').length -
      rightDetails.importPath.split('/').length
    );
  }
  return 0;
}

function suggestionId(
  diagnostic: DiagnosticsNesSuggestion['diagnostic'],
  edit: NesTextEdit,
): string {
  return JSON.stringify([
    diagnostic.uri,
    diagnostic.message,
    diagnostic.code,
    diagnostic.start,
    diagnostic.end,
    edit.uri,
    edit.startOffset,
    edit.endOffset,
    edit.newText,
  ]);
}

export class DiagnosticsNextEditProvider implements vscode.Disposable {
  private readonly rejected = new Map<string, Set<string>>();
  private readonly histories = new Map<string, RecentDocumentHistory>();
  private readonly knownTexts = new Map<string, string>();
  private readonly positions = new Map<string, vscode.Position>();
  private readonly workers = new Map<string, DiagnosticsWorkerState>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly nodeModules = new Set<string>();
  private readonly nodeModulesReady: Promise<void>;
  private lastAccepted:
    | {
        readonly id: string;
        readonly diagnosticId: string;
        readonly diagnosticUri: string;
        readonly at: number;
      }
    | undefined;
  private lastOutcome: 'accepted' | 'rejected' | 'ignored' | undefined;
  private lastRejectionTime = Number.NEGATIVE_INFINITY;
  private lastComputation:
    | 'idle'
    | 'no-recent-edit'
    | 'no-relevant-diagnostic'
    | 'no-supported-action'
    | 'suggestion'
    | 'stale' = 'idle';
  private lastValidity:
    | 'current'
    | 'snapshot'
    | 'diagnostic'
    | 'import-name'
    | 'recently-accepted'
    | 'rejected' = 'current';
  private disposed = false;

  constructor(
    private readonly startDelayMs: number,
    private readonly now: () => number = Date.now,
    private readonly treatments: DiagnosticsTreatments =
      COPILOT_BEHAVIOR_CONFIG.nextEdit,
  ) {
    for (const document of vscode.workspace.textDocuments) {
      this.knownTexts.set(document.uri.toString(), document.getText());
    }
    this.trackEditor(vscode.window.activeTextEditor);
    this.nodeModulesReady = this.loadNodeModules();
    this.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((document) => {
        this.knownTexts.set(document.uri.toString(), document.getText());
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        this.recordDocumentChange(event);
      }),
      vscode.languages.onDidChangeDiagnostics((event) => {
        for (const uri of event.uris) {
          this.reschedule(uri.toString());
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.trackEditor(editor);
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        const position = event.selections[0]?.active;
        if (!position) {
          return;
        }
        const uri = event.textEditor.document.uri.toString();
        this.positions.set(uri, position);
        void this.schedule(event.textEditor.document, position).catch(() => undefined);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.removeDocument(document.uri.toString());
      }),
    );
  }

  async provide(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<DiagnosticsNesSuggestion | undefined> {
    if (
      this.disposed ||
      !(await cancellableDelay(this.startDelayMs, token)) ||
      this.disposed
    ) {
      return undefined;
    }
    const uri = document.uri.toString();
    this.positions.set(uri, position);
    this.knownTexts.set(uri, document.getText());
    const existing = this.workers.get(uri);
    if (!existing) {
      return undefined;
    }
    const pending =
      existing.key === this.computationKey(document, position)
        ? existing.promise
        : this.schedule(document, position);
    const suggestion = await awaitWithCancellation(
      pending,
      token,
    );
    if (suggestion && !this.isCurrent(suggestion)) {
      this.lastComputation = 'stale';
      return undefined;
    }
    return suggestion;
  }

  isCurrent(suggestion: DiagnosticsNesSuggestion): boolean {
    if (this.disposed) {
      return false;
    }
    const source = this.findOpenDocument(suggestion.sourceDocument.uri);
    const target = this.findOpenDocument(suggestion.targetDocument.uri);
    if (
      !source ||
      !target ||
      source.version !== suggestion.sourceDocument.version ||
      source.getText() !== suggestion.sourceDocument.text ||
      target.version !== suggestion.targetDocument.version ||
      target.getText() !== suggestion.targetDocument.text
    ) {
      this.lastValidity = 'snapshot';
      return false;
    }
    const diagnosticStillPresent = vscode.languages
      .getDiagnostics(source.uri)
      .some(
        (diagnostic) =>
          diagnostic.message === suggestion.diagnostic.message &&
          diagnosticCode(diagnostic) === suggestion.diagnostic.code &&
          source.offsetAt(diagnostic.range.start) === suggestion.diagnostic.start &&
          source.offsetAt(diagnostic.range.end) === suggestion.diagnostic.end,
      );
    if (!diagnosticStillPresent) {
      this.lastValidity = 'diagnostic';
      return false;
    }
    if (
      suggestion.importName !== undefined &&
      source
        .getText()
        .slice(suggestion.diagnostic.start, suggestion.diagnostic.end) !==
        suggestion.importName
    ) {
      this.lastValidity = 'import-name';
      return false;
    }
    const diagnosticId = JSON.stringify(suggestion.diagnostic);
    if (
      this.lastAccepted &&
      this.now() - this.lastAccepted.at < 1_000 &&
      (this.lastAccepted.id === suggestion.id ||
        this.lastAccepted.diagnosticId === diagnosticId)
    ) {
      this.lastValidity = 'recently-accepted';
      return false;
    }
    const current = !this.rejected
      .get(suggestion.diagnostic.uri)
      ?.has(suggestion.rejectionKey);
    this.lastValidity = current ? 'current' : 'rejected';
    return current;
  }

  handleAccepted(suggestion: DiagnosticsNesSuggestion): void {
    this.lastOutcome = 'accepted';
    this.lastAccepted = {
      id: suggestion.id,
      diagnosticId: JSON.stringify(suggestion.diagnostic),
      diagnosticUri: suggestion.diagnostic.uri,
      at: this.now(),
    };
  }

  handleRejected(suggestion: DiagnosticsNesSuggestion): void {
    this.lastOutcome = 'rejected';
    this.lastRejectionTime = this.now();
    const rejected = this.rejected.get(suggestion.diagnostic.uri) ?? new Set();
    rejected.add(suggestion.rejectionKey);
    this.rejected.set(suggestion.diagnostic.uri, rejected);
    this.invalidate(suggestion.diagnostic.uri);
  }

  handleIgnored(_suggestion: DiagnosticsNesSuggestion): void {
    this.lastOutcome = 'ignored';
  }

  removeDocument(uri: string): void {
    this.rejected.delete(uri);
    this.histories.delete(uri);
    this.knownTexts.delete(uri);
    this.positions.delete(uri);
    this.invalidate(uri);
    if (this.lastAccepted?.diagnosticUri === uri) {
      this.lastAccepted = undefined;
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const subscription of this.subscriptions.splice(0)) {
      subscription.dispose();
    }
    for (const worker of this.workers.values()) {
      worker.source.cancel();
      worker.source.dispose();
    }
    this.workers.clear();
    this.rejected.clear();
    this.histories.clear();
    this.knownTexts.clear();
    this.positions.clear();
    this.lastAccepted = undefined;
  }

  getState(): {
    readonly rejectedCount: number;
    readonly lastOutcome: 'accepted' | 'rejected' | 'ignored' | undefined;
    readonly lastRejectionTime: number;
    readonly disposed: boolean;
    readonly workInProgress: boolean;
    readonly trackedDocuments: number;
    readonly enabledDocuments: number;
    readonly lastComputation:
      | 'idle'
      | 'no-recent-edit'
      | 'no-relevant-diagnostic'
      | 'no-supported-action'
      | 'suggestion'
      | 'stale';
    readonly lastValidity:
      | 'current'
      | 'snapshot'
      | 'diagnostic'
      | 'import-name'
      | 'recently-accepted'
      | 'rejected';
  } {
    return {
      rejectedCount: [...this.rejected.values()].reduce(
        (total, entries) => total + entries.size,
        0,
      ),
      lastOutcome: this.lastOutcome,
      lastRejectionTime: this.lastRejectionTime,
      disposed: this.disposed,
      workInProgress: [...this.workers.values()].some(
        (worker) => worker.workInProgress,
      ),
      trackedDocuments: this.histories.size,
      enabledDocuments: this.positions.size,
      lastComputation: this.lastComputation,
      lastValidity: this.lastValidity,
    };
  }

  private async loadNodeModules(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    await Promise.all(
      folders.map(async (folder) => {
        try {
          const entries = await vscode.workspace.fs.readDirectory(
            vscode.Uri.joinPath(folder.uri, 'node_modules'),
          );
          for (const [name, type] of entries) {
            if (type === vscode.FileType.Directory) {
              this.nodeModules.add(name);
            }
          }
        } catch {
          // A workspace without node_modules has no external package evidence.
        }
      }),
    );
  }

  private recordDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    const uri = event.document.uri.toString();
    const after = event.document.getText();
    const before = this.knownTexts.get(uri);
    this.knownTexts.set(uri, after);
    if (before !== undefined && event.contentChanges.length > 0) {
      this.histories.set(
        uri,
        updateRecentHistory(
          this.histories.get(uri),
          before,
          after,
          event.contentChanges,
        ),
      );
    }
    const activeEditor = vscode.window.activeTextEditor;
    const activePosition =
      activeEditor?.document === event.document
        ? activeEditor.selection.active
        : undefined;
    const lastChange = event.contentChanges[event.contentChanges.length - 1];
    const changedPosition = lastChange
      ? event.document.positionAt(lastChange.rangeOffset + lastChange.text.length)
      : undefined;
    const position = activePosition ?? changedPosition;
    if (position) {
      this.positions.set(uri, position);
    }
    this.reschedule(uri);
  }

  private reschedule(uri: string): void {
    this.invalidate(uri);
    const document = this.findOpenDocument(uri);
    const position = this.positions.get(uri);
    if (document && position && !this.disposed) {
      void this.schedule(document, position).catch(() => undefined);
    }
  }

  private invalidate(uri: string): void {
    const worker = this.workers.get(uri);
    if (!worker) {
      return;
    }
    worker.source.cancel();
    worker.source.dispose();
    this.workers.delete(uri);
  }

  private schedule(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<DiagnosticsNesSuggestion | undefined> {
    if (this.disposed) {
      return Promise.resolve(undefined);
    }
    const uri = document.uri.toString();
    const key = this.computationKey(document, position);
    const existing = this.workers.get(uri);
    if (existing?.key === key) {
      return existing.promise;
    }
    this.invalidate(uri);
    const source = new vscode.CancellationTokenSource();
    let worker: DiagnosticsWorkerState;
    const promise = this.computeAfterBackgroundDelay(
      document,
      position,
      source.token,
    )
      .then((result) => {
        if (
          this.workers.get(uri) !== worker ||
          source.token.isCancellationRequested ||
          this.disposed
        ) {
          return undefined;
        }
        worker.workInProgress = false;
        worker.result = result;
        return result;
      })
      .catch((error: unknown) => {
        if (!source.token.isCancellationRequested) {
          throw error;
        }
        return undefined;
      });
    worker = {
      key,
      source,
      promise,
      workInProgress: true,
    };
    this.workers.set(uri, worker);
    return promise.finally(() => {
      const current = this.workers.get(uri);
      if (current === worker) {
        current.workInProgress = false;
      }
    });
  }

  private async computeAfterBackgroundDelay(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<DiagnosticsNesSuggestion | undefined> {
    return (await cancellableDelay(DIAGNOSTICS_BACKGROUND_DELAY_MS, token))
      ? this.compute(document, position, token)
      : undefined;
  }

  private trackEditor(editor: vscode.TextEditor | undefined): void {
    if (!editor || this.disposed) {
      return;
    }
    const uri = editor.document.uri.toString();
    this.knownTexts.set(uri, editor.document.getText());
    this.positions.set(uri, editor.selection.active);
    void this.schedule(editor.document, editor.selection.active).catch(
      () => undefined,
    );
  }

  private computationKey(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): string {
    const diagnostics = vscode.languages.getDiagnostics(document.uri).map(
      (diagnostic) => [
        diagnostic.message,
        diagnosticCode(diagnostic),
        document.offsetAt(diagnostic.range.start),
        document.offsetAt(diagnostic.range.end),
      ],
    );
    return JSON.stringify([
      document.version,
      document.getText(),
      position.line,
      position.character,
      diagnostics,
    ]);
  }

  private async compute(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<DiagnosticsNesSuggestion | undefined> {
    await this.nodeModulesReady;
    if (token.isCancellationRequested) {
      return undefined;
    }
    const sourceSnapshot = snapshot(document);
    const history = this.histories.get(sourceSnapshot.uri);
    if (!history || history.currentText !== sourceSnapshot.text) {
      this.lastComputation = 'no-recent-edit';
      return undefined;
    }
    const diagnostics = vscode.languages
      .getDiagnostics(document.uri)
      .filter((diagnostic) => this.supportsDiagnostic(document, diagnostic, position))
      .filter((diagnostic) => {
        const range = {
          start: document.offsetAt(diagnostic.range.start),
          end: document.offsetAt(diagnostic.range.end),
        };
        return history.ranges.some((recent) =>
          rangesIntersectOrTouch(recent, range),
        );
      })
      .sort(
        (left, right) =>
          lineDistance(left, position) - lineDistance(right, position) ||
          left.severity - right.severity,
      );
    if (diagnostics.length === 0) {
      this.lastComputation = 'no-relevant-diagnostic';
    }
    for (const diagnostic of diagnostics) {
      const suggestion = await this.computeForDiagnostic(
        document,
        sourceSnapshot,
        history,
        diagnostic,
        token,
      );
      if (suggestion) {
        return suggestion;
      }
      if (token.isCancellationRequested) {
        return undefined;
      }
    }
    return undefined;
  }

  private supportsDiagnostic(
    document: vscode.TextDocument,
    diagnostic: vscode.Diagnostic,
    position: vscode.Position,
  ): boolean {
    const distance = lineDistance(diagnostic, position);
    const async =
      ASYNC_LANGUAGES.has(document.languageId) &&
      diagnosticCode(diagnostic) === '1308' &&
      distance <= 3;
    if (async) {
      return true;
    }
    if (!IMPORT_LANGUAGES.has(document.languageId) || distance > 12) {
      return false;
    }
    switch (document.languageId) {
      case 'typescript':
      case 'javascript':
      case 'typescriptreact':
      case 'javascriptreact':
        return diagnostic.message.includes('Cannot find name');
      case 'python':
        return diagnostic.message.includes('is not defined');
      case 'java':
        return this.treatments.javaImportDiagnostics && (
          diagnosticCode(diagnostic) === '16777218' ||
          diagnostic.message.endsWith('cannot be resolved to a type')
        );
      default:
        return false;
    }
  }

  private async computeForDiagnostic(
    document: vscode.TextDocument,
    sourceSnapshot: DocumentSnapshot,
    history: RecentDocumentHistory,
    diagnostic: vscode.Diagnostic,
    token: vscode.CancellationToken,
  ): Promise<DiagnosticsNesSuggestion | undefined> {
    const actions = await vscode.commands.executeCommand<
      (vscode.CodeAction | vscode.Command)[] | undefined
    >(
      'vscode.executeCodeActionProvider',
      document.uri,
      diagnostic.range,
      vscode.CodeActionKind.QuickFix.value,
      3,
    );
    if (
      token.isCancellationRequested ||
      document.version !== sourceSnapshot.version ||
      document.getText() !== sourceSnapshot.text
    ) {
      return undefined;
    }
    const candidates: CandidateAction[] = [];
    for (const candidate of actions ?? []) {
      if (!('edit' in candidate) || !candidate.edit) {
        continue;
      }
      const action = candidate;
      const workspaceEdit = candidate.edit;
      if (!actionFixesDiagnostic(action, diagnostic)) {
        continue;
      }
      const ownEdits = workspaceEdit
        .entries()
        .filter(([uri]) => uri.toString() === document.uri.toString())
        .flatMap(([, edits]) => edits);
      const edit = joinTextEdits(document, ownEdits);
      if (!edit || this.isInvalidEdit(edit, history)) {
        continue;
      }
      const importDetails = importDetailsFor(
        document,
        diagnostic,
        action,
        this.nodeModules,
      );
      const isAsync =
        ASYNC_LANGUAGES.has(document.languageId) &&
        diagnosticCode(diagnostic) === '1308' &&
        (action.title.startsWith('Add async') ||
          action.title.startsWith('Update async'));
      if (!importDetails && !isAsync) {
        continue;
      }
      candidates.push({
        action,
        edit,
        kind: importDetails ? 'import' : 'async',
        ...(importDetails ? { importDetails } : {}),
        hasExistingSameFileImport: !edit.newText.includes('import'),
      });
    }
    const importCandidates = candidates
      .filter(
        (candidate): candidate is CandidateAction & { importDetails: ImportDetails } =>
          candidate.importDetails !== undefined,
      )
      .sort(compareImportActions);
    const selected = importCandidates[0] ?? candidates.find((candidate) => candidate.kind === 'async');
    if (!selected) {
      this.lastComputation = 'no-supported-action';
      return undefined;
    }
    const code = diagnosticCode(diagnostic);
    const diagnosticSnapshot = {
      uri: document.uri.toString(),
      message: diagnostic.message,
      ...(code ? { code } : {}),
      start: document.offsetAt(diagnostic.range.start),
      end: document.offsetAt(diagnostic.range.end),
    };
    const id = suggestionId(diagnosticSnapshot, selected.edit);
    const diagnosticId = JSON.stringify(diagnosticSnapshot);
    const importDetails = selected.importDetails;
    const rejectionKey = importDetails
      ? `${this.importSourceKey(document, importDetails.importPath)}\u0000${importDetails.importName}`
      : id;
    if (this.rejected.get(document.uri.toString())?.has(rejectionKey)) {
      return undefined;
    }
    if (
      this.lastAccepted &&
      this.now() - this.lastAccepted.at < 1_000 &&
      (this.lastAccepted.id === id || this.lastAccepted.diagnosticId === diagnosticId)
    ) {
      return undefined;
    }
    const label = importDetails
      ? importCandidates.length === 1 && importDetails.importSource !== 'external'
        ? importDetails.labelShort
        : importDetails.labelDeduped
      : selected.action.title;
    this.lastComputation = 'suggestion';
    return {
      source: 'diagnostics',
      kind: selected.kind,
      id,
      rejectionKey,
      edit: selected.edit,
      ...(selected.action.command ? { command: selected.action.command } : {}),
      title: selected.action.title,
      sourceDocument: sourceSnapshot,
      targetDocument: sourceSnapshot,
      ...(importDetails ? { importName: importDetails.importName } : {}),
      diagnostic: diagnosticSnapshot,
      ...(importDetails
        ? {
            displayLocation: {
              uri: document.uri.toString(),
              range: diagnostic.range,
              label,
            },
          }
        : {}),
    };
  }

  private isInvalidEdit(
    edit: NesTextEdit,
    history: RecentDocumentHistory,
  ): boolean {
    let recentDelta = new InformationDelta();
    let documentText = history.baselineText;
    for (const recentEdit of history.edits) {
      recentDelta = recentDelta.combine(
        getInformationDelta(documentText, recentEdit),
      );
      documentText = applyOffsetTextReplacements(documentText, recentEdit);
    }
    if (recentDelta.isUndoneBy(getInformationDelta(history.currentText, edit))) {
      return true;
    }
    const editRange = { start: edit.startOffset, end: edit.endOffset };
    return history.recentRanges.some((range) =>
      rangesIntersectOrTouch(range, editRange),
    );
  }

  private importSourceKey(
    document: vscode.TextDocument,
    importPath: string,
  ): string {
    if (importPath.startsWith('./') || importPath.startsWith('../')) {
      return vscode.Uri.joinPath(document.uri, '..', importPath).toString();
    }
    return importPath;
  }

  private findOpenDocument(uri: string): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find(
      (document) => !document.isClosed && document.uri.toString() === uri,
    );
  }
}
