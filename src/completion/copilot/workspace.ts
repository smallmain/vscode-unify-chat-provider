import { execFile } from "node:child_process";
import { dirname, extname, relative } from "node:path";
import ignore from "ignore";
import { minimatch } from "minimatch";
import * as vscode from "vscode";
import type {
  GhostTextContextProviderFeedback,
  GhostTextContextProviderItemSource,
} from "../../chat-lib/core/ghost-text";
import type {
  NesLanguageContextItem,
  NesNeighborSnippet,
} from "../../chat-lib/core/nes/types";
import { selectNesNeighborSnippets } from "../../chat-lib/core/nes/similar-files";
import {
  copilotContextProviderRegistry,
  type CopilotContextProviderResolver,
  type CopilotContextProviderTarget,
  type CopilotProposedTextEdit,
} from "./context-provider";

export interface CopilotSelectionSnapshot {
  readonly start: number;
  readonly end: number;
  readonly active: number;
}

export interface CopilotDocumentSnapshot {
  readonly uri: string;
  readonly path: string;
  readonly relativePath?: string;
  readonly scheme: string;
  readonly languageId: string;
  readonly version: number;
  readonly text: string;
  readonly workspaceRoot?: string;
  readonly workspaceRootUri?: string;
  readonly notebookUri?: string;
  readonly selection?: CopilotSelectionSnapshot;
  readonly visibleRanges: readonly { start: number; end: number }[];
  readonly lastViewedAt: number;
  readonly lastEditedAt: number;
}

export interface CopilotNotebookContext {
  readonly activeCellIndex: number;
  readonly cells: readonly {
    readonly index: number;
    readonly languageId: string;
    readonly text: string;
  }[];
}

export interface CopilotEditHistoryEntry {
  readonly uri: string;
  readonly path: string;
  readonly languageId: string;
  readonly before: string;
  readonly after: string;
  readonly timestamp: number;
  readonly reason: "undo" | "redo" | "other";
  readonly relativePath?: string;
  readonly workspaceRootUri?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly changes: readonly {
    readonly rangeOffset: number;
    readonly rangeLength: number;
    readonly text: string;
  }[];
}

export interface CopilotDiagnosticSnapshot {
  readonly uri: string;
  readonly path: string;
  readonly message: string;
  readonly severity: "error" | "warning" | "information" | "hint";
  readonly startLine: number;
  readonly startCharacter: number;
  readonly endLine: number;
  readonly endCharacter: number;
  readonly source?: string;
  readonly code?: string;
  readonly importance?: number;
  readonly contextProviderSource?: GhostTextContextProviderItemSource;
}

export type CopilotLanguageContextItem = NesLanguageContextItem & {
  readonly contextProviderSource?: GhostTextContextProviderItemSource;
};

export interface CopilotLanguageContext {
  readonly items: readonly CopilotLanguageContextItem[];
  readonly diagnostics?: readonly CopilotDiagnosticSnapshot[];
  readonly symbols: readonly {
    readonly name: string;
    readonly detail?: string;
    readonly kind: string;
    readonly startLine: number;
    readonly endLine: number;
  }[];
  readonly contextProviderFeedback?: GhostTextContextProviderFeedback;
}

export interface CopilotNeighborSnippet extends NesNeighborSnippet {
  readonly source: "open-tab" | "related-provider";
}

export interface CopilotWorkspaceContext {
  readonly current: CopilotDocumentSnapshot;
  readonly ignored: boolean;
  readonly recentDocuments: readonly CopilotDocumentSnapshot[];
  readonly editHistory: readonly CopilotEditHistoryEntry[];
  readonly neighborSnippets: readonly CopilotNeighborSnippet[];
  readonly diagnostics: readonly CopilotDiagnosticSnapshot[];
  readonly promptDiagnostics: readonly CopilotDiagnosticSnapshot[];
  readonly languageContext: CopilotLanguageContext;
  readonly gitDiff?: string;
}

export interface CopilotWorkspaceDocumentChange {
  readonly document: vscode.TextDocument;
  readonly reason: "undo" | "redo" | "other";
  readonly isTracked: boolean;
}

export interface CopilotWorkspaceContextRequest {
  readonly target?: CopilotContextProviderTarget;
  readonly completionId?: string;
  readonly opportunityId?: string;
  readonly proposedEdits?: readonly CopilotProposedTextEdit[];
  readonly data?: unknown;
  /** Absolute NES context deadline shared with the request debounce window. */
  readonly timeoutEndMs?: number;
  readonly includeLanguageContext?: boolean;
}

const TRACKED_SCHEMES = new Set(["file", "untitled", "vscode-notebook-cell"]);
const MAX_HISTORY_ENTRIES = 100;
const MAX_GIT_DIFF_LENGTH = 40_000;
export const COPILOT_PROMPT_CONTEXT_TIMEOUT_MS = 1_200;

type PromptContextOutcome =
  | { readonly kind: "value"; readonly value: CopilotWorkspaceContext }
  | { readonly kind: "cancelled" | "error" | "timeout" };

type NesDeadlineOutcome = "settled" | "deadline" | "cancelled";

async function waitForNesDeadline(
  promise: PromiseLike<unknown>,
  timeoutEndMs: number,
  token: vscode.CancellationToken,
): Promise<NesDeadlineOutcome> {
  if (token.isCancellationRequested) return "cancelled";
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timeout = setTimeout(
      () => resolve("deadline"),
      Math.max(0, timeoutEndMs - Date.now()),
    );
  });
  let cancellation: vscode.Disposable | undefined;
  const cancelled = new Promise<"cancelled">((resolve) => {
    cancellation = token.onCancellationRequested(() => resolve("cancelled"));
    if (token.isCancellationRequested) resolve("cancelled");
  });
  const settled = Promise.resolve(promise).then(
    () => "settled" as const,
    () => "settled" as const,
  );
  const outcome = await Promise.race([settled, deadline, cancelled]);
  if (timeout) clearTimeout(timeout);
  cancellation?.dispose();
  return outcome;
}

function diagnosticSeverity(
  value: vscode.DiagnosticSeverity,
): CopilotDiagnosticSnapshot["severity"] {
  switch (value) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "information";
    case vscode.DiagnosticSeverity.Hint:
      return "hint";
  }
}

function diagnosticSnapshot(
  uri: vscode.Uri,
  diagnostic: vscode.Diagnostic,
  importance?: number,
  contextProviderSource?: GhostTextContextProviderItemSource,
): CopilotDiagnosticSnapshot {
  return {
    uri: uri.toString(),
    path: copilotDisplayPath(uri) ?? uri.path ?? uri.toString(),
    message: diagnostic.message,
    severity: diagnosticSeverity(diagnostic.severity),
    startLine: diagnostic.range.start.line,
    startCharacter: diagnostic.range.start.character,
    endLine: diagnostic.range.end.line,
    endCharacter: diagnostic.range.end.character,
    ...(diagnostic.source ? { source: diagnostic.source } : {}),
    ...(diagnostic.code === undefined
      ? {}
      : {
          code:
            typeof diagnostic.code === "object"
              ? String(diagnostic.code.value)
              : String(diagnostic.code),
        }),
    ...(importance === undefined ? {} : { importance }),
    ...(contextProviderSource ? { contextProviderSource } : {}),
  };
}

function notebookUriForDocument(
  document: vscode.TextDocument,
): string | undefined {
  if (document.uri.scheme !== "vscode-notebook-cell") {
    return undefined;
  }
  for (const notebook of vscode.workspace.notebookDocuments) {
    if (notebook.getCells().some((cell) => cell.document === document)) {
      return notebook.uri.toString();
    }
  }
  return undefined;
}

function documentPath(document: vscode.TextDocument): string {
  return document.uri.fsPath || document.uri.path || document.uri.toString();
}

function documentWorkspaceFolder(
  document: vscode.TextDocument,
): vscode.WorkspaceFolder | undefined {
  const direct = vscode.workspace.getWorkspaceFolder(document.uri);
  if (direct) {
    return direct;
  }
  const notebookUri = notebookUriForDocument(document);
  if (!notebookUri) {
    return undefined;
  }
  return vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(notebookUri));
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function relativeUriPath(
  root: vscode.Uri,
  target: vscode.Uri,
): string | undefined {
  if (root.scheme !== target.scheme || root.authority !== target.authority) {
    return undefined;
  }
  const rootPath = root.path.replace(/\/+$/, "");
  if (target.path === rootPath) {
    return "";
  }
  const prefix = `${rootPath}/`;
  return target.path.startsWith(prefix)
    ? normalizeRelativePath(target.path.slice(prefix.length))
    : undefined;
}

export function copilotDisplayPath(uri: vscode.Uri): string | undefined {
  if (uri.scheme === "untitled" || uri.scheme === "vscode-notebook-cell") {
    return undefined;
  }
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (workspaceFolder) {
    const relativePath = relativeUriPath(workspaceFolder.uri, uri);
    if (relativePath !== undefined) return relativePath;
  }
  return undefined;
}

function relativeDirectory(value: string): string {
  const normalized = normalizeRelativePath(value);
  const separator = normalized.lastIndexOf("/");
  return separator < 0 ? "" : normalized.slice(0, separator);
}

function relativeBasename(value: string): string {
  const normalized = normalizeRelativePath(value);
  const separator = normalized.lastIndexOf("/");
  return separator < 0 ? normalized : normalized.slice(separator + 1);
}

function isWithinDirectory(path: string, directory: string): boolean {
  return (
    directory.length === 0 ||
    path === directory ||
    path.startsWith(`${directory}/`)
  );
}

function pathWithinDirectory(
  path: string,
  directory: string,
): string | undefined {
  if (!isWithinDirectory(path, directory)) {
    return undefined;
  }
  return directory.length === 0
    ? path
    : path === directory
      ? ""
      : path.slice(directory.length + 1);
}

function isDirectoryIgnoredByScopes(
  directory: string,
  scopes: readonly IgnoreScope[],
): boolean {
  let ignored = false;
  for (const scope of scopes) {
    const localPath = pathWithinDirectory(directory, scope.directory);
    if (!localPath) {
      continue;
    }
    const result = scope.matcher.test(`${localPath}/`);
    if (result.ignored) {
      ignored = true;
    } else if (result.unignored) {
      ignored = false;
    }
  }
  return ignored;
}

function matchesIgnoreScopes(
  value: string,
  scopes: readonly IgnoreScope[],
): boolean {
  const relativePath = normalizeRelativePath(value);
  let ignored = false;
  const applicableScopes: IgnoreScope[] = [];
  for (const scope of scopes) {
    const localPath = pathWithinDirectory(relativePath, scope.directory);
    if (localPath === undefined || localPath.length === 0) {
      continue;
    }
    if (
      scope.directory.length > 0 &&
      isDirectoryIgnoredByScopes(scope.directory, applicableScopes)
    ) {
      continue;
    }
    applicableScopes.push(scope);
    const result = scope.matcher.test(localPath);
    if (result.ignored) {
      ignored = true;
    } else if (result.unignored) {
      ignored = false;
    }
  }
  return ignored;
}

interface IgnoreScope {
  readonly directory: string;
  readonly matcher: ReturnType<typeof ignore>;
  readonly sourceUri: string;
}

interface GitDiffCacheEntry {
  readonly timestamp: number;
  readonly value?: string;
}

export class CopilotWorkspaceAdapter implements vscode.Disposable {
  private readonly documents = new Map<string, CopilotDocumentSnapshot>();
  private readonly history: CopilotEditHistoryEntry[] = [];
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly ignoreRules = new Map<string, readonly IgnoreScope[]>();
  private readonly ignoreRuleLoads = new Map<
    string,
    Promise<readonly IgnoreScope[]>
  >();
  private ignoreRulesGeneration = 0;
  private readonly gitDiffCache = new Map<string, GitDiffCacheEntry>();
  private readonly documentChangeEmitter =
    new vscode.EventEmitter<CopilotWorkspaceDocumentChange>();
  private readonly selectionChangeEmitter =
    new vscode.EventEmitter<vscode.TextEditorSelectionChangeEvent>();
  private readonly documentCloseEmitter = new vscode.EventEmitter<string>();
  private lastPromptContextRequest:
    Promise<CopilotWorkspaceContext> | undefined;
  private disposed = false;

  readonly onDidChangeDocument = this.documentChangeEmitter.event;
  readonly onDidChangeSelection = this.selectionChangeEmitter.event;
  readonly onDidCloseDocument = this.documentCloseEmitter.event;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly contextProviders: CopilotContextProviderResolver = copilotContextProviderRegistry,
  ) {
    const timestamp = this.now();
    for (const document of vscode.workspace.textDocuments) {
      if (this.shouldTrack(document)) {
        this.documents.set(
          document.uri.toString(),
          this.createSnapshot(document, timestamp, timestamp),
        );
      }
    }
    for (const editor of vscode.window.visibleTextEditors) {
      this.captureEditor(editor);
    }
    this.primeKnownIgnoreRules();
    const ignoreWatcher = vscode.workspace.createFileSystemWatcher(
      "**/{.gitignore,.copilotignore}",
    );

    this.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((document) => {
        if (this.shouldTrack(document)) {
          const timestamp = this.now();
          this.documents.set(
            document.uri.toString(),
            this.createSnapshot(document, timestamp, timestamp),
          );
          this.primeIgnoreRulesForDocument(document);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        const uri = document.uri.toString();
        this.documents.delete(uri);
        this.documentCloseEmitter.fire(uri);
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        this.handleDocumentChange(event);
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.captureEditor(editor);
        }
      }),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) {
          this.captureEditor(editor);
        }
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
        this.captureEditor(event.textEditor);
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        this.captureEditor(event.textEditor);
        this.selectionChangeEmitter.fire(event);
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("files.exclude") ||
          event.affectsConfiguration("search.exclude")
        ) {
          this.invalidateIgnoreRules();
        }
      }),
      ignoreWatcher,
      ignoreWatcher.onDidCreate(() => this.invalidateIgnoreRules()),
      ignoreWatcher.onDidChange(() => this.invalidateIgnoreRules()),
      ignoreWatcher.onDidDelete(() => this.invalidateIgnoreRules()),
    );
  }

  snapshot(document: vscode.TextDocument): CopilotDocumentSnapshot {
    const key = document.uri.toString();
    const existing = this.documents.get(key);
    if (existing && existing.version === document.version) {
      return existing;
    }
    const timestamp = this.now();
    const snapshot = this.createSnapshot(
      document,
      existing?.lastViewedAt ?? timestamp,
      existing?.lastEditedAt ?? timestamp,
    );
    if (this.shouldTrack(document)) {
      this.documents.set(key, snapshot);
    }
    return snapshot;
  }

  isDocumentIgnored(document: vscode.TextDocument): boolean {
    return this.isIgnored(this.snapshot(document));
  }

  async isDocumentIgnoredWithRules(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<boolean> {
    const current = this.snapshot(document);
    await this.loadIgnoreRules(current.workspaceRootUri, token);
    return this.isIgnored(current);
  }

  isTracked(document: vscode.TextDocument): boolean {
    return (
      this.shouldTrack(document) && this.documents.has(document.uri.toString())
    );
  }

  hasEditHistory(): boolean {
    return this.history.length > 0;
  }

  fimNotebookContext(
    document: vscode.TextDocument,
  ): CopilotNotebookContext | undefined {
    for (const notebook of vscode.workspace.notebookDocuments) {
      const cells = notebook.getCells();
      const activeCellIndex = cells.findIndex(
        (cell) => cell.document === document,
      );
      if (activeCellIndex < 0) continue;
      return {
        activeCellIndex,
        cells: cells.map((cell, index) => ({
          index,
          languageId: cell.document.languageId,
          text: cell.document.getText(),
        })),
      };
    }
    return undefined;
  }

  isEligibleForNesTrigger(document: vscode.TextDocument): boolean {
    if (!this.isTracked(document)) {
      return false;
    }
    const current = this.snapshot(document);
    const root = current.workspaceRootUri;
    if (root && !this.ignoreRules.has(root)) {
      void this.loadIgnoreRules(root);
      return false;
    }
    return !this.isIgnored(current);
  }

  async gatherContext(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
    cursorOffset?: number,
    contextRequest: CopilotWorkspaceContextRequest = {},
  ): Promise<CopilotWorkspaceContext> {
    const previous = this.lastPromptContextRequest;
    const pending =
      (contextRequest.target ?? "completions") === "nes" &&
      contextRequest.timeoutEndMs !== undefined
        ? this.gatherNesContextSequentially(
            previous,
            document,
            token,
            cursorOffset,
            contextRequest,
          )
        : this.gatherContextSequentially(
            previous,
            document,
            token,
            cursorOffset,
            contextRequest,
          );
    this.lastPromptContextRequest = pending;
    return await pending;
  }

  private async gatherNesContextSequentially(
    previous: Promise<CopilotWorkspaceContext> | undefined,
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
    cursorOffset: number | undefined,
    contextRequest: CopilotWorkspaceContextRequest,
  ): Promise<CopilotWorkspaceContext> {
    const timeoutEndMs = contextRequest.timeoutEndMs;
    if (timeoutEndMs === undefined) {
      throw new Error("NES context gathering requires an absolute deadline.");
    }
    const base = this.buildNesBaseContext(document, cursorOffset);
    if (previous) {
      const previousOutcome = await waitForNesDeadline(
        previous,
        timeoutEndMs,
        token,
      );
      if (previousOutcome === "cancelled") {
        return this.emptyPromptContext(document);
      }
      if (previousOutcome === "deadline") {
        return this.applyLoadedIgnoreRules(base, cursorOffset, true);
      }
    }
    if (token.isCancellationRequested) {
      return this.emptyPromptContext(document);
    }

    const ignoreLoads = Promise.all(
      [
        ...new Set(
          [base.current, ...base.recentDocuments, ...base.editHistory]
            .map((candidate) => candidate.workspaceRootUri)
            .filter((root): root is string => root !== undefined),
        ),
      ].map((root) => this.loadIgnoreRules(root, token)),
    );
    const ignoreOutcome = await waitForNesDeadline(
      ignoreLoads,
      timeoutEndMs,
      token,
    );
    if (ignoreOutcome === "cancelled") {
      return this.emptyPromptContext(document);
    }
    if (ignoreOutcome === "deadline") {
      return this.applyLoadedIgnoreRules(base, cursorOffset, true);
    }
    const filteredBase = this.applyLoadedIgnoreRules(base, cursorOffset);
    let languageContext: CopilotLanguageContext = {
      items: [],
      diagnostics: [],
      symbols: [],
    };
    let gitDiff: string | undefined;
    const languagePromise =
      contextRequest.includeLanguageContext === false
        ? Promise.resolve()
        : this.readLanguageContext(
            document,
            token,
            cursorOffset ??
              filteredBase.current.selection?.active ??
              filteredBase.current.text.length,
            contextRequest,
          ).then((value) => {
            languageContext = value;
          });
    const gitPromise = this.readGitDiff(filteredBase.current, token).then(
      (value) => {
        gitDiff = value;
      },
    );
    const enrichmentOutcome = await waitForNesDeadline(
      Promise.all([languagePromise, gitPromise]),
      timeoutEndMs,
      token,
    );
    if (enrichmentOutcome === "cancelled") {
      return this.emptyPromptContext(document);
    }
    return this.mergeNesEnrichment(filteredBase, languageContext, gitDiff);
  }

  private async gatherContextSequentially(
    previous: Promise<CopilotWorkspaceContext> | undefined,
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
    cursorOffset: number | undefined,
    contextRequest: CopilotWorkspaceContextRequest,
  ): Promise<CopilotWorkspaceContext> {
    await previous;
    if (token.isCancellationRequested) {
      return this.emptyPromptContext(document);
    }

    const source = new vscode.CancellationTokenSource();
    let parentSubscription: vscode.Disposable | undefined;
    let timeout: NodeJS.Timeout | undefined;
    const cancellation = new Promise<PromptContextOutcome>((resolve) => {
      parentSubscription = token.onCancellationRequested(() => {
        source.cancel();
        resolve({ kind: "cancelled" });
      });
      if (token.isCancellationRequested) {
        source.cancel();
        resolve({ kind: "cancelled" });
      }
    });
    const timedOut = new Promise<PromptContextOutcome>((resolve) => {
      timeout = setTimeout(() => {
        source.cancel();
        resolve({ kind: "timeout" });
      }, COPILOT_PROMPT_CONTEXT_TIMEOUT_MS);
    });
    const gathered = this.gatherContextUnsequenced(
      document,
      source.token,
      cursorOffset,
      contextRequest,
    ).then<PromptContextOutcome, PromptContextOutcome>(
      (value) => ({ kind: "value", value }),
      () => ({ kind: "error" }),
    );

    try {
      const outcome = await Promise.race([gathered, cancellation, timedOut]);
      return outcome.kind === "value"
        ? outcome.value
        : this.emptyPromptContext(document);
    } finally {
      if (timeout) clearTimeout(timeout);
      parentSubscription?.dispose();
      source.dispose();
    }
  }

  private buildNesBaseContext(
    document: vscode.TextDocument,
    cursorOffset: number | undefined,
  ): CopilotWorkspaceContext {
    const current = this.snapshot(document);
    const candidates = [...this.documents.values()]
      .filter(
        (candidate) =>
          candidate.uri !== current.uri && !this.isIgnored(candidate),
      )
      .sort(
        (left, right) =>
          this.contextScore(right, current) - this.contextScore(left, current),
      );
    const contextUris = new Set([
      current.uri,
      ...candidates.map((item) => item.uri),
    ]);
    const seenPromptDiagnostics = new Set<string>();
    const promptDiagnostics = vscode.languages
      .getDiagnostics()
      .filter(([uri]) => contextUris.has(uri.toString()))
      .flatMap(([uri, diagnostics]) =>
        diagnostics.map((diagnostic) => diagnosticSnapshot(uri, diagnostic)),
      )
      .filter((diagnostic) => {
        const key = this.promptDiagnosticKey(diagnostic);
        if (seenPromptDiagnostics.has(key)) return false;
        seenPromptDiagnostics.add(key);
        return true;
      });
    return {
      current,
      ignored: this.isIgnored(current),
      recentDocuments: candidates,
      editHistory: this.history
        .filter(
          (entry) =>
            !this.isIgnoredRelativePath(
              entry.relativePath ?? entry.path,
              entry.workspaceRootUri,
            ),
        )
        .slice(-100)
        .reverse(),
      neighborSnippets: selectNesNeighborSnippets(
        current,
        cursorOffset ?? current.selection?.active ?? current.text.length,
        candidates,
      ).map((snippet) => ({ ...snippet, source: "open-tab" as const })),
      diagnostics: vscode.languages
        .getDiagnostics(document.uri)
        .map((diagnostic) => diagnosticSnapshot(document.uri, diagnostic)),
      promptDiagnostics,
      languageContext: { items: [], diagnostics: [], symbols: [] },
    };
  }

  private mergeNesEnrichment(
    base: CopilotWorkspaceContext,
    languageContext: CopilotLanguageContext,
    gitDiff: string | undefined,
  ): CopilotWorkspaceContext {
    const seenPromptDiagnostics = new Set(
      base.promptDiagnostics.map((diagnostic) =>
        this.promptDiagnosticKey(diagnostic),
      ),
    );
    const promptDiagnostics = [
      ...base.promptDiagnostics,
      ...(languageContext.diagnostics ?? []).filter((diagnostic) => {
        const key = this.promptDiagnosticKey(diagnostic);
        if (seenPromptDiagnostics.has(key)) return false;
        seenPromptDiagnostics.add(key);
        return true;
      }),
    ];
    return {
      ...base,
      promptDiagnostics,
      languageContext,
      ...(gitDiff ? { gitDiff } : {}),
    };
  }

  private applyLoadedIgnoreRules(
    base: CopilotWorkspaceContext,
    cursorOffset: number | undefined,
    failClosedUnknownRoots = false,
  ): CopilotWorkspaceContext {
    const rootIsUnknown = (root: string | undefined): boolean =>
      failClosedUnknownRoots &&
      root !== undefined &&
      !this.ignoreRules.has(root);
    const ignored =
      rootIsUnknown(base.current.workspaceRootUri) ||
      this.isIgnored(base.current);
    const recentDocuments = base.recentDocuments.filter(
      (candidate) =>
        !rootIsUnknown(candidate.workspaceRootUri) &&
        !this.isIgnored(candidate),
    );
    const contextUris = new Set([
      ...(ignored ? [] : [base.current.uri]),
      ...recentDocuments.map((candidate) => candidate.uri),
    ]);
    return {
      ...base,
      ignored,
      recentDocuments,
      editHistory: base.editHistory.filter(
        (entry) =>
          !rootIsUnknown(entry.workspaceRootUri) &&
          !this.isIgnoredRelativePath(
            entry.relativePath ?? entry.path,
            entry.workspaceRootUri,
          ),
      ),
      neighborSnippets: selectNesNeighborSnippets(
        base.current,
        cursorOffset ??
          base.current.selection?.active ??
          base.current.text.length,
        recentDocuments,
      ).map((snippet) => ({ ...snippet, source: "open-tab" as const })),
      diagnostics: ignored ? [] : base.diagnostics,
      promptDiagnostics: base.promptDiagnostics.filter((diagnostic) =>
        contextUris.has(diagnostic.uri),
      ),
    };
  }

  private promptDiagnosticKey(diagnostic: CopilotDiagnosticSnapshot): string {
    return [
      diagnostic.contextProviderSource?.providerId ?? "",
      diagnostic.contextProviderSource?.itemId ?? "",
      diagnostic.uri,
      diagnostic.startLine,
      diagnostic.startCharacter,
      diagnostic.endLine,
      diagnostic.endCharacter,
      diagnostic.severity,
      diagnostic.message,
      diagnostic.source ?? "",
      diagnostic.code ?? "",
    ].join("\u0000");
  }

  private async gatherContextUnsequenced(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
    cursorOffset: number | undefined,
    contextRequest: CopilotWorkspaceContextRequest,
  ): Promise<CopilotWorkspaceContext> {
    const current = this.snapshot(document);
    await Promise.all(
      [
        ...new Set(
          [...this.documents.values()]
            .map((candidate) => candidate.workspaceRootUri)
            .filter((root): root is string => root !== undefined),
        ),
      ].map((root) => this.loadIgnoreRules(root, token)),
    );
    const candidates = [...this.documents.values()]
      .filter(
        (candidate) =>
          candidate.uri !== current.uri && !this.isIgnored(candidate),
      )
      .sort(
        (left, right) =>
          this.contextScore(right, current) - this.contextScore(left, current),
      );

    const [languageContext, gitDiff] = await Promise.all([
      contextRequest.includeLanguageContext === false
        ? Promise.resolve<CopilotLanguageContext>({
            items: [],
            diagnostics: [],
            symbols: [],
          })
        : this.readLanguageContext(
            document,
            token,
            cursorOffset ?? current.selection?.active ?? current.text.length,
            contextRequest,
          ),
      this.readGitDiff(current, token),
    ]);
    const contextUris = new Set([
      current.uri,
      ...candidates.map((item) => item.uri),
    ]);
    const seenPromptDiagnostics = new Set<string>();
    const promptDiagnostics = [
      ...vscode.languages
        .getDiagnostics()
        .filter(([uri]) => contextUris.has(uri.toString()))
        .flatMap(([uri, diagnostics]) =>
          diagnostics.map((diagnostic) => diagnosticSnapshot(uri, diagnostic)),
        ),
      ...(languageContext.diagnostics ?? []),
    ].filter((diagnostic) => {
      const key = [
        diagnostic.contextProviderSource?.providerId ?? "",
        diagnostic.contextProviderSource?.itemId ?? "",
        diagnostic.uri,
        diagnostic.startLine,
        diagnostic.startCharacter,
        diagnostic.endLine,
        diagnostic.endCharacter,
        diagnostic.severity,
        diagnostic.message,
        diagnostic.source ?? "",
        diagnostic.code ?? "",
      ].join("\u0000");
      if (seenPromptDiagnostics.has(key)) return false;
      seenPromptDiagnostics.add(key);
      return true;
    });
    return {
      current,
      ignored: this.isIgnored(current),
      recentDocuments: candidates,
      editHistory: this.history
        .filter(
          (entry) =>
            !this.isIgnoredRelativePath(
              entry.relativePath ?? entry.path,
              entry.workspaceRootUri,
            ),
        )
        .slice(-100)
        .reverse(),
      neighborSnippets: selectNesNeighborSnippets(
        current,
        cursorOffset ?? current.selection?.active ?? current.text.length,
        candidates,
      ).map((snippet) => ({ ...snippet, source: "open-tab" as const })),
      diagnostics: vscode.languages
        .getDiagnostics(document.uri)
        .map((diagnostic) => diagnosticSnapshot(document.uri, diagnostic)),
      promptDiagnostics,
      languageContext,
      ...(gitDiff ? { gitDiff } : {}),
    };
  }

  private emptyPromptContext(
    document: vscode.TextDocument,
  ): CopilotWorkspaceContext {
    return {
      current: this.snapshot(document),
      ignored: true,
      recentDocuments: [],
      editHistory: [],
      neighborSnippets: [],
      diagnostics: [],
      promptDiagnostics: [],
      languageContext: { items: [], diagnostics: [], symbols: [] },
    };
  }

  getState(): {
    readonly documentCount: number;
    readonly historyCount: number;
    readonly listenerCount: number;
    readonly disposed: boolean;
  } {
    return {
      documentCount: this.documents.size,
      historyCount: this.history.length,
      listenerCount: this.disposed ? 0 : this.subscriptions.length,
      disposed: this.disposed,
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const subscription of this.subscriptions.splice(0)) {
      subscription.dispose();
    }
    this.documentChangeEmitter.dispose();
    this.selectionChangeEmitter.dispose();
    this.documentCloseEmitter.dispose();
    this.documents.clear();
    this.history.length = 0;
    this.ignoreRules.clear();
    this.ignoreRuleLoads.clear();
    this.gitDiffCache.clear();
  }

  private shouldTrack(document: vscode.TextDocument): boolean {
    if (
      document.isClosed ||
      (!TRACKED_SCHEMES.has(document.uri.scheme) &&
        vscode.workspace.getWorkspaceFolder(document.uri) === undefined)
    ) {
      return false;
    }
    const path = documentPath(document).replace(/\\/g, "/");
    return !/(^|\/)\.git(\/|$)|(^|\/)node_modules(\/|$)/.test(path);
  }

  private handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    const reason =
      event.reason === vscode.TextDocumentChangeReason.Undo
        ? "undo"
        : event.reason === vscode.TextDocumentChangeReason.Redo
          ? "redo"
          : "other";
    const isTracked = this.shouldTrack(event.document);
    if (!isTracked) {
      this.documentChangeEmitter.fire({
        document: event.document,
        reason,
        isTracked,
      });
      return;
    }
    const key = event.document.uri.toString();
    const before = this.documents.get(key);
    const timestamp = this.now();
    const after = this.createSnapshot(
      event.document,
      before?.lastViewedAt ?? timestamp,
      timestamp,
    );
    this.documents.set(key, after);
    if (event.contentChanges.length > 0) {
      const startLine = Math.min(
        ...event.contentChanges.map((change) => change.range.start.line),
      );
      const endLine = Math.max(
        ...event.contentChanges.map((change) => change.range.end.line),
      );
      this.history.push({
        uri: key,
        path: after.path,
        relativePath: after.relativePath,
        ...(after.workspaceRootUri
          ? { workspaceRootUri: after.workspaceRootUri }
          : {}),
        languageId: after.languageId,
        before: before?.text ?? "",
        after: after.text,
        timestamp,
        reason,
        startLine,
        endLine,
        changes: event.contentChanges.map((change) => ({
          rangeOffset: change.rangeOffset,
          rangeLength: change.rangeLength,
          text: change.text,
        })),
      });
      if (this.history.length > MAX_HISTORY_ENTRIES) {
        this.history.splice(0, this.history.length - MAX_HISTORY_ENTRIES);
      }
    }
    this.gitDiffCache.delete(key);
    this.documentChangeEmitter.fire({
      document: event.document,
      reason,
      isTracked,
    });
  }

  private captureEditor(editor: vscode.TextEditor): void {
    if (!this.shouldTrack(editor.document)) {
      return;
    }
    const timestamp = this.now();
    const previous = this.documents.get(editor.document.uri.toString());
    this.documents.set(
      editor.document.uri.toString(),
      this.createSnapshot(
        editor.document,
        timestamp,
        previous?.lastEditedAt ?? timestamp,
        editor,
      ),
    );
  }

  private createSnapshot(
    document: vscode.TextDocument,
    lastViewedAt: number,
    lastEditedAt: number,
    suppliedEditor?: vscode.TextEditor,
  ): CopilotDocumentSnapshot {
    const editor =
      suppliedEditor ??
      vscode.window.visibleTextEditors.find(
        (candidate) => candidate.document === document,
      );
    const workspaceFolder = documentWorkspaceFolder(document);
    const root = workspaceFolder
      ? workspaceFolder.uri.fsPath || workspaceFolder.uri.path
      : undefined;
    const path = documentPath(document);
    const relativePath = copilotDisplayPath(document.uri);
    const selection = editor?.selection;
    return {
      uri: document.uri.toString(),
      path,
      ...(relativePath ? { relativePath } : {}),
      scheme: document.uri.scheme,
      languageId: document.languageId,
      version: document.version,
      text: document.getText(),
      ...(root ? { workspaceRoot: root } : {}),
      ...(workspaceFolder
        ? { workspaceRootUri: workspaceFolder.uri.toString() }
        : {}),
      ...(notebookUriForDocument(document)
        ? { notebookUri: notebookUriForDocument(document) }
        : {}),
      ...(selection
        ? {
            selection: {
              start: document.offsetAt(selection.start),
              end: document.offsetAt(selection.end),
              active: document.offsetAt(selection.active),
            },
          }
        : {}),
      visibleRanges: (editor?.visibleRanges ?? []).map((range) => ({
        start: document.offsetAt(range.start),
        end: document.offsetAt(range.end),
      })),
      lastViewedAt,
      lastEditedAt,
    };
  }

  private contextScore(
    candidate: CopilotDocumentSnapshot,
    current: CopilotDocumentSnapshot,
  ): number {
    let score = candidate.lastViewedAt / 1_000_000_000;
    if (candidate.languageId === current.languageId) {
      score += 1_000_000;
    }
    if (extname(candidate.path) === extname(current.path)) {
      score += 100_000;
    }
    if (dirname(candidate.path) === dirname(current.path)) {
      score += 10_000;
    }
    if (this.history.some((entry) => entry.uri === candidate.uri)) {
      score += 1_000;
    }
    return score;
  }

  private async readLanguageContext(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
    cursorOffset: number,
    request: CopilotWorkspaceContextRequest,
  ): Promise<CopilotLanguageContext> {
    if (token.isCancellationRequested) {
      return { items: [], diagnostics: [], symbols: [] };
    }
    const offset = Math.max(
      0,
      Math.min(document.getText().length, cursorOffset),
    );
    const resolved = await this.contextProviders.resolve(
      {
        target: request.target ?? "completions",
        document,
        offset,
        ...(request.completionId ? { completionId: request.completionId } : {}),
        ...(request.opportunityId
          ? { opportunityId: request.opportunityId }
          : {}),
        ...(request.timeoutEndMs !== undefined
          ? { timeoutEndMs: request.timeoutEndMs }
          : {}),
        ...(request.proposedEdits && request.proposedEdits.length > 0
          ? { proposedEdits: request.proposedEdits }
          : {}),
        ...("data" in request ? { data: request.data } : {}),
      },
      token,
    );
    const completionId = request.completionId ?? resolved[0]?.completionId;
    if (token.isCancellationRequested) {
      return { items: [], diagnostics: [], symbols: [] };
    }
    const items: CopilotLanguageContextItem[] = [];
    const diagnostics: CopilotDiagnosticSnapshot[] = [];
    const seenDiagnostics = new Set<string>();
    for (const resolvedItem of resolved) {
      const item = resolvedItem.item;
      if ("name" in item) {
        items.push({
          kind: "trait",
          name: item.name,
          value: item.value,
          ...(item.importance === undefined
            ? {}
            : { importance: item.importance }),
          ...(resolvedItem.onTimeout ? { onTimeout: true } : {}),
          contextProviderSource: resolvedItem.source,
        });
      } else if ("value" in item) {
        const sourceUris = [item.uri, ...(item.additionalUris ?? [])];
        if (!(await this.areContextUrisValid(sourceUris, token))) {
          this.contextProviders.markContentExcluded?.(
            resolvedItem.completionId,
            resolvedItem.source,
          );
          continue;
        }
        items.push({
          kind: "snippet",
          uri: item.uri,
          ...(copilotDisplayPath(vscode.Uri.parse(item.uri))
            ? { path: copilotDisplayPath(vscode.Uri.parse(item.uri)) }
            : {}),
          value: item.value,
          ...(item.additionalUris
            ? { additionalUris: item.additionalUris }
            : {}),
          ...(item.importance === undefined
            ? {}
            : { importance: item.importance }),
          ...(resolvedItem.onTimeout ? { onTimeout: true } : {}),
          contextProviderSource: resolvedItem.source,
        });
      } else {
        if (!(await this.areContextUrisValid([item.uri.toString()], token))) {
          this.contextProviders.markContentExcluded?.(
            resolvedItem.completionId,
            resolvedItem.source,
          );
          continue;
        }
        for (const diagnostic of item.values) {
          const snapshot = diagnosticSnapshot(
            item.uri,
            diagnostic,
            item.importance,
            resolvedItem.source,
          );
          const key = [
            resolvedItem.source.providerId,
            resolvedItem.source.itemId,
            snapshot.uri,
            snapshot.startLine,
            snapshot.startCharacter,
            snapshot.endLine,
            snapshot.endCharacter,
            snapshot.severity,
            snapshot.message,
            snapshot.source ?? "",
            snapshot.code ?? "",
          ].join("\u0000");
          if (seenDiagnostics.has(key)) continue;
          seenDiagnostics.add(key);
          diagnostics.push(snapshot);
        }
      }
    }
    return {
      items,
      diagnostics,
      symbols: [],
      ...(completionId &&
      (request.target ?? "completions") === "completions" &&
      this.contextProviders.submitPromptUsage
        ? {
            contextProviderFeedback: {
              completionId,
              submit: (matchers) =>
                this.contextProviders.submitPromptUsage?.(
                  completionId,
                  matchers,
                ),
            },
          }
        : {}),
    };
  }

  private async areContextUrisValid(
    uris: readonly string[],
    token: vscode.CancellationToken,
  ): Promise<boolean> {
    for (const value of uris) {
      if (token.isCancellationRequested) return false;
      let document = this.documents.get(value);
      if (!document) {
        try {
          const opened = await vscode.workspace.openTextDocument(
            vscode.Uri.parse(value),
          );
          document = this.snapshot(opened);
        } catch {
          return false;
        }
      }
      await this.loadIgnoreRules(document.workspaceRootUri, token);
      if (token.isCancellationRequested || this.isIgnored(document)) {
        return false;
      }
    }
    return true;
  }

  private async loadIgnoreRules(
    root: string | undefined,
    token?: vscode.CancellationToken,
  ): Promise<void> {
    if (!root || this.ignoreRules.has(root) || token?.isCancellationRequested) {
      return;
    }
    const existingLoad = this.ignoreRuleLoads.get(root);
    if (existingLoad) {
      await existingLoad;
      return;
    }

    const generation = this.ignoreRulesGeneration;
    const load = this.readIgnoreScopes(vscode.Uri.parse(root), token);
    this.ignoreRuleLoads.set(root, load);
    try {
      const scopes = await load;
      if (
        !this.disposed &&
        !token?.isCancellationRequested &&
        generation === this.ignoreRulesGeneration
      ) {
        this.ignoreRules.set(root, scopes);
      }
    } finally {
      if (this.ignoreRuleLoads.get(root) === load) {
        this.ignoreRuleLoads.delete(root);
      }
    }
  }

  private isIgnored(snapshot: CopilotDocumentSnapshot): boolean {
    return this.isIgnoredRelativePath(
      snapshot.relativePath,
      snapshot.workspaceRootUri,
    );
  }

  private isIgnoredRelativePath(
    value: string | undefined,
    root: string | undefined,
  ): boolean {
    if (value === undefined) return false;
    const relativePath = normalizeRelativePath(value);
    const configurationPatterns = {
      ...vscode.workspace
        .getConfiguration("files")
        .get<Record<string, boolean>>("exclude", {}),
      ...vscode.workspace
        .getConfiguration("search")
        .get<Record<string, boolean>>("exclude", {}),
    };
    if (
      Object.entries(configurationPatterns).some(
        ([pattern, enabled]) =>
          enabled && minimatch(relativePath, pattern, { dot: true }),
      )
    ) {
      return true;
    }
    return root
      ? matchesIgnoreScopes(relativePath, this.ignoreRules.get(root) ?? [])
      : false;
  }

  private async readIgnoreScopes(
    root: vscode.Uri,
    token?: vscode.CancellationToken,
  ): Promise<readonly IgnoreScope[]> {
    let ignoreUris: readonly vscode.Uri[];
    try {
      ignoreUris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(root, "**/{.gitignore,.copilotignore}"),
        null,
        undefined,
        token,
      );
    } catch {
      return [];
    }
    if (token?.isCancellationRequested) {
      return [];
    }

    const candidates = ignoreUris
      .map((uri) => {
        const relativePath = relativeUriPath(root, uri);
        if (relativePath === undefined) {
          return undefined;
        }
        const basename = relativeBasename(relativePath);
        if (basename !== ".gitignore" && basename !== ".copilotignore") {
          return undefined;
        }
        return {
          uri,
          relativePath,
          directory: relativeDirectory(relativePath),
          basename,
        };
      })
      .filter(
        (candidate): candidate is NonNullable<typeof candidate> =>
          candidate !== undefined,
      )
      .sort((left, right) => {
        const directoryDepth =
          left.directory.split("/").filter(Boolean).length -
          right.directory.split("/").filter(Boolean).length;
        if (directoryDepth !== 0) {
          return directoryDepth;
        }
        const directoryOrder = left.directory.localeCompare(right.directory);
        if (directoryOrder !== 0) {
          return directoryOrder;
        }
        if (left.basename === right.basename) {
          return left.relativePath.localeCompare(right.relativePath);
        }
        return left.basename === ".gitignore" ? -1 : 1;
      });

    const scopes: IgnoreScope[] = [];
    for (const candidate of candidates) {
      if (token?.isCancellationRequested) {
        return [];
      }
      try {
        const bytes = await vscode.workspace.fs.readFile(candidate.uri);
        scopes.push({
          directory: candidate.directory,
          matcher: ignore().add(new TextDecoder().decode(bytes)),
          sourceUri: candidate.uri.toString(),
        });
      } catch {
        // Ignore files can disappear between discovery and reading.
      }
    }
    return scopes;
  }

  private invalidateIgnoreRules(): void {
    this.ignoreRulesGeneration += 1;
    this.ignoreRules.clear();
    this.ignoreRuleLoads.clear();
    this.primeKnownIgnoreRules();
  }

  private primeIgnoreRulesForDocument(document: vscode.TextDocument): void {
    const root = this.snapshot(document).workspaceRootUri;
    if (root) {
      void this.loadIgnoreRules(root);
    }
  }

  private primeKnownIgnoreRules(): void {
    const roots = new Set(
      [...this.documents.values()]
        .map((document) => document.workspaceRootUri)
        .filter((root): root is string => root !== undefined),
    );
    for (const root of roots) {
      void this.loadIgnoreRules(root);
    }
  }

  private async readGitDiff(
    snapshot: CopilotDocumentSnapshot,
    token: vscode.CancellationToken,
  ): Promise<string | undefined> {
    if (!snapshot.workspaceRoot || snapshot.scheme !== "file") {
      return undefined;
    }
    const cached = this.gitDiffCache.get(snapshot.uri);
    const now = this.now();
    if (cached && now - cached.timestamp < 1_000) {
      return cached.value;
    }
    const relativePath = relative(snapshot.workspaceRoot, snapshot.path);
    const value = await new Promise<string | undefined>((resolve) => {
      if (token.isCancellationRequested) {
        resolve(undefined);
        return;
      }
      let cancellation: vscode.Disposable | undefined;
      const child = execFile(
        "git",
        ["diff", "--no-ext-diff", "--unified=1", "HEAD", "--", relativePath],
        {
          cwd: snapshot.workspaceRoot,
          timeout: 250,
          maxBuffer: MAX_GIT_DIFF_LENGTH * 2,
          encoding: "utf8",
        },
        (error, stdout) => {
          cancellation?.dispose();
          resolve(
            error || !stdout ? undefined : stdout.slice(0, MAX_GIT_DIFF_LENGTH),
          );
        },
      );
      cancellation = token.onCancellationRequested(() => {
        child.kill();
        resolve(undefined);
      });
    });
    this.gitDiffCache.set(snapshot.uri, { timestamp: now, value });
    return value;
  }
}
