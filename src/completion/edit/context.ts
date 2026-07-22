import * as vscode from 'vscode';
import type {
  CompletionSourceContext,
  EditAlgorithmSyntaxRange,
} from '../model/requests';

const IDENTIFIER_LIMIT = 32;
const RELATED_CONTEXT_CHARACTER_BUDGET = 32_768;
const DEFINITION_EXCERPT_CHARACTER_BUDGET = 4_000;
const MAX_DEFINITION_TARGET_LENGTH = 128;
const DEFINITION_DEBOUNCE_MS = 100;

interface CachedSyntaxContext {
  readonly version: number;
  readonly syntaxRanges: readonly EditAlgorithmSyntaxRange[];
  readonly fullSyntaxRanges: readonly EditAlgorithmSyntaxRange[];
}

interface IdentifierOccurrence {
  readonly name: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly position: vscode.Position;
  readonly distance: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positionFrom(value: unknown): vscode.Position | undefined {
  if (!isRecord(value)) return undefined;
  const line = value.line;
  const character = value.character;
  return typeof line === 'number' && typeof character === 'number'
    ? new vscode.Position(line, character)
    : undefined;
}

function rangeFrom(value: unknown): vscode.Range | undefined {
  if (!isRecord(value)) return undefined;
  const start = positionFrom(value.start);
  const end = positionFrom(value.end);
  return start && end ? new vscode.Range(start, end) : undefined;
}

function isUri(value: unknown): value is vscode.Uri {
  return (
    isRecord(value) &&
    typeof value.scheme === 'string' &&
    typeof value.toString === 'function'
  );
}

function locationFrom(value: unknown):
  | { readonly uri: vscode.Uri; readonly range: vscode.Range }
  | undefined {
  if (!isRecord(value)) return undefined;
  const uri = value.uri ?? value.targetUri;
  const range = rangeFrom(
    value.targetSelectionRange ?? value.range ?? value.targetRange,
  );
  return isUri(uri) && range ? { uri, range } : undefined;
}

function workspaceKey(document: vscode.TextDocument): string {
  const folder = vscode.workspace.getWorkspaceFolder?.(document.uri);
  return `${folder?.uri.toString() ?? 'no-workspace'}\0${document.uri.toString()}`;
}

function occurrenceKey(
  document: vscode.TextDocument,
  occurrence: IdentifierOccurrence,
): string {
  return `${workspaceKey(document)}\0${occurrence.name}\0${occurrence.startOffset}:${occurrence.endOffset}`;
}

function identifierOccurrences(
  document: vscode.TextDocument,
  cursor: vscode.Position,
): IdentifierOccurrence[] {
  const text = document.getText();
  const cursorOffset = document.offsetAt(cursor);
  let start = cursorOffset;
  let leadingLines = 0;
  while (start > 0 && leadingLines < 3) {
    start -= 1;
    if (text.charCodeAt(start) === 10) leadingLines += 1;
  }
  let end = cursorOffset;
  let trailingLines = 0;
  while (end < text.length && trailingLines < 3) {
    if (text.charCodeAt(end) === 10) trailingLines += 1;
    end += 1;
  }

  const occurrences: IdentifierOccurrence[] = [];
  const pattern = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  for (const match of text.slice(start, end).matchAll(pattern)) {
    if (match.index === undefined) continue;
    const startOffset = start + match.index;
    const endOffset = startOffset + match[0].length;
    const distance =
      cursorOffset < startOffset
        ? startOffset - cursorOffset
        : cursorOffset > endOffset
          ? cursorOffset - endOffset
          : 0;
    occurrences.push({
      name: match[0],
      startOffset,
      endOffset,
      position: document.positionAt(startOffset),
      distance,
    });
  }
  occurrences.sort(
    (left, right) =>
      left.distance - right.distance || left.startOffset - right.startOffset,
  );
  return occurrences.slice(0, IDENTIFIER_LIMIT);
}

function responseLocations(response: unknown): readonly unknown[] {
  if (Array.isArray(response)) return response;
  return response === undefined || response === null ? [] : [response];
}

async function definitionContextsForOccurrence(
  document: vscode.TextDocument,
  occurrence: IdentifierOccurrence,
): Promise<CompletionSourceContext[]> {
  if (typeof vscode.commands?.executeCommand !== 'function') return [];
  const sourceFolder = vscode.workspace.getWorkspaceFolder?.(document.uri);
  if (!sourceFolder) return [];
  const responses = await Promise.all(
    [
      'vscode.executeDefinitionProvider',
      'vscode.executeTypeDefinitionProvider',
    ].map((command) =>
      Promise.resolve(
        vscode.commands.executeCommand<unknown>(
          command,
          document.uri,
          occurrence.position,
        ),
      ).catch(() => undefined),
    ),
  );

  const contexts: CompletionSourceContext[] = [];
  const seen = new Set<string>();
  for (const response of responses) {
    for (const value of responseLocations(response)) {
      const location = locationFrom(value);
      if (!location) continue;
      const targetFolder = vscode.workspace.getWorkspaceFolder?.(location.uri);
      if (targetFolder?.uri.toString() !== sourceFolder.uri.toString()) continue;
      const key = `${location.uri.toString()}\0${location.range.start.line}:${location.range.start.character}-${location.range.end.line}:${location.range.end.character}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const target = await vscode.workspace.openTextDocument(location.uri);
        const targetStart = target.offsetAt(location.range.start);
        const targetEnd = target.offsetAt(location.range.end);
        if (
          targetEnd < targetStart ||
          targetEnd - targetStart > MAX_DEFINITION_TARGET_LENGTH
        ) {
          continue;
        }
        const text = target.getText();
        const excerptStart = Math.max(
          0,
          targetStart - Math.floor(DEFINITION_EXCERPT_CHARACTER_BUDGET / 2),
        );
        const excerptEnd = Math.min(
          text.length,
          excerptStart + DEFINITION_EXCERPT_CHARACTER_BUDGET,
        );
        const content = text.slice(excerptStart, excerptEnd);
        if (!content) continue;
        contexts.push({
          uri: location.uri.toString(),
          path: vscode.workspace
            .asRelativePath(location.uri, false)
            .replaceAll('\\', '/'),
          content,
          range: { startOffset: excerptStart, endOffset: excerptEnd },
        });
      } catch {
        // A stale definition location is omitted from the refreshed cache.
      }
    }
  }
  return contexts;
}

function collectSymbolRanges(
  values: readonly unknown[],
  document: vscode.TextDocument,
  cursorOffset: number,
  cursorRanges: EditAlgorithmSyntaxRange[],
  fullRanges: EditAlgorithmSyntaxRange[],
): void {
  for (const value of values) {
    if (!isRecord(value)) continue;
    const range = rangeFrom(value.range);
    if (range) {
      const startOffset = document.offsetAt(range.start);
      const endOffset = document.offsetAt(range.end);
      if (endOffset > startOffset) {
        fullRanges.push({ startOffset, endOffset });
      }
      if (startOffset <= cursorOffset && cursorOffset <= endOffset) {
        cursorRanges.push({ startOffset, endOffset });
      }
    }
    if (Array.isArray(value.children)) {
      collectSymbolRanges(
        value.children,
        document,
        cursorOffset,
        cursorRanges,
        fullRanges,
      );
    }
  }
}

async function syntaxRanges(
  document: vscode.TextDocument,
  cursor: vscode.Position,
): Promise<{
  readonly cursor: EditAlgorithmSyntaxRange[];
  readonly full: EditAlgorithmSyntaxRange[];
}> {
  if (typeof vscode.commands?.executeCommand !== 'function') {
    return { cursor: [], full: [] };
  }
  const raw = await Promise.resolve(
    vscode.commands.executeCommand<unknown>(
      'vscode.executeDocumentSymbolProvider',
      document.uri,
    ),
  ).catch(() => undefined);
  const cursorRanges: EditAlgorithmSyntaxRange[] = [];
  const fullRanges: EditAlgorithmSyntaxRange[] = [];
  collectSymbolRanges(
    Array.isArray(raw) ? raw : [],
    document,
    document.offsetAt(cursor),
    cursorRanges,
    fullRanges,
  );
  cursorRanges.sort(
    (left, right) =>
      left.endOffset - left.startOffset - (right.endOffset - right.startOffset),
  );
  fullRanges.sort(
    (left, right) =>
      left.startOffset - right.startOffset || left.endOffset - right.endOffset,
  );
  return { cursor: cursorRanges, full: fullRanges };
}

export class EditPredictionContextCache implements vscode.Disposable {
  private readonly relatedFiles = new Map<
    string,
    readonly CompletionSourceContext[]
  >();
  private readonly syntax = new Map<string, CachedSyntaxContext>();
  private readonly definitions = new Map<
    string,
    readonly CompletionSourceContext[]
  >();
  private readonly definitionTimers = new Map<string, NodeJS.Timeout>();
  private readonly definitionGenerations = new Map<string, number>();
  private readonly syntaxGenerations = new Map<string, number>();
  private readonly documentChangeSubscription: vscode.Disposable | undefined;

  constructor() {
    this.documentChangeSubscription =
      typeof vscode.workspace.onDidChangeTextDocument === 'function'
        ? vscode.workspace.onDidChangeTextDocument((event) => {
            this.invalidateDocument(event.document);
          })
        : undefined;
  }

  private invalidateDocument(document: vscode.TextDocument): void {
    const uri = document.uri.toString();
    const sourceKey = workspaceKey(document);
    const timer = this.definitionTimers.get(sourceKey);
    if (timer) clearTimeout(timer);
    this.definitionTimers.delete(sourceKey);
    this.relatedFiles.delete(sourceKey);
    this.syntax.delete(sourceKey);
    this.definitionGenerations.set(
      sourceKey,
      (this.definitionGenerations.get(sourceKey) ?? 0) + 1,
    );
    this.syntaxGenerations.set(
      sourceKey,
      (this.syntaxGenerations.get(sourceKey) ?? 0) + 1,
    );

    for (const [key, contexts] of this.definitions) {
      if (key.startsWith(`${sourceKey}\0`) || contexts.some((item) => item.uri === uri)) {
        this.definitions.delete(key);
      }
    }
    for (const [key, contexts] of this.relatedFiles) {
      if (contexts.some((item) => item.uri === uri)) {
        this.relatedFiles.delete(key);
      }
    }
  }

  read(document: vscode.TextDocument): {
    readonly relatedFiles: readonly CompletionSourceContext[];
    readonly syntaxRanges: readonly EditAlgorithmSyntaxRange[];
    readonly fullSyntaxRanges: readonly EditAlgorithmSyntaxRange[];
  } {
    const key = workspaceKey(document);
    const cachedSyntax = this.syntax.get(key);
    return {
      relatedFiles: this.relatedFiles.get(key) ?? [],
      syntaxRanges:
        cachedSyntax?.version === document.version
          ? cachedSyntax.syntaxRanges
          : [],
      fullSyntaxRanges:
        cachedSyntax?.version === document.version
          ? cachedSyntax.fullSyntaxRanges
          : [],
    };
  }

  refresh(document: vscode.TextDocument, cursor: vscode.Position): void {
    this.refreshSyntax(document, cursor);
    this.scheduleDefinitions(document, cursor);
  }

  private refreshSyntax(
    document: vscode.TextDocument,
    cursor: vscode.Position,
  ): void {
    const key = workspaceKey(document);
    const version = document.version;
    if (this.syntax.get(key)?.version === version) return;
    const generation = (this.syntaxGenerations.get(key) ?? 0) + 1;
    this.syntaxGenerations.set(key, generation);
    void syntaxRanges(document, cursor).then((ranges) => {
      if (
        this.syntaxGenerations.get(key) === generation &&
        document.version === version
      ) {
        this.syntax.set(key, {
          version,
          syntaxRanges: ranges.cursor,
          fullSyntaxRanges: ranges.full,
        });
      }
    });
  }

  private scheduleDefinitions(
    document: vscode.TextDocument,
    cursor: vscode.Position,
  ): void {
    const key = workspaceKey(document);
    const currentTimer = this.definitionTimers.get(key);
    if (currentTimer) clearTimeout(currentTimer);
    const version = document.version;
    const occurrences = identifierOccurrences(document, cursor);
    const generation = (this.definitionGenerations.get(key) ?? 0) + 1;
    this.definitionGenerations.set(key, generation);
    this.definitionTimers.set(
      key,
      setTimeout(() => {
        this.definitionTimers.delete(key);
        void this.refreshDefinitions(
          document,
          occurrences,
          version,
          generation,
        );
      }, DEFINITION_DEBOUNCE_MS),
    );
  }

  private async refreshDefinitions(
    document: vscode.TextDocument,
    occurrences: readonly IdentifierOccurrence[],
    version: number,
    generation: number,
  ): Promise<void> {
    const documentKey = workspaceKey(document);
    const activeKeys = new Set<string>();
    const resolved = await Promise.all(
      occurrences.map(async (occurrence) => {
        const key = occurrenceKey(document, occurrence);
        activeKeys.add(key);
        const cached = this.definitions.get(key);
        if (cached) return cached;
        const contexts = await definitionContextsForOccurrence(
          document,
          occurrence,
        );
        this.definitions.set(key, contexts);
        return contexts;
      }),
    );
    if (
      this.definitionGenerations.get(documentKey) !== generation ||
      document.version !== version
    ) {
      return;
    }

    for (const cachedKey of this.definitions.keys()) {
      if (cachedKey.startsWith(`${documentKey}\0`) && !activeKeys.has(cachedKey)) {
        this.definitions.delete(cachedKey);
      }
    }
    const contexts: CompletionSourceContext[] = [];
    const seen = new Set<string>();
    let remainingBudget = RELATED_CONTEXT_CHARACTER_BUDGET;
    for (const occurrenceContexts of resolved) {
      for (const context of occurrenceContexts) {
        if (remainingBudget <= 0) break;
        const identity = `${context.uri ?? ''}\0${context.range?.startOffset ?? 0}:${context.range?.endOffset ?? context.content.length}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        const content = context.content.slice(0, remainingBudget);
        contexts.push({
          ...context,
          content,
          ...(context.range === undefined
            ? {}
            : {
                range: {
                  startOffset: context.range.startOffset,
                  endOffset: context.range.startOffset + content.length,
                },
              }),
        });
        remainingBudget -= content.length;
      }
    }
    this.relatedFiles.set(documentKey, contexts);
  }

  dispose(): void {
    this.documentChangeSubscription?.dispose();
    for (const timer of this.definitionTimers.values()) clearTimeout(timer);
    this.definitionTimers.clear();
    this.definitionGenerations.clear();
    this.syntaxGenerations.clear();
    this.definitions.clear();
    this.relatedFiles.clear();
    this.syntax.clear();
  }
}
