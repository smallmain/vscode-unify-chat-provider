import type * as vscode from 'vscode';
import {
  FimRecentEditsTracker,
  positionAt,
  type GhostTextCodeSnippet,
  type GhostTextPromptContext,
  type GhostTextTrait,
} from '../../chat-lib/core/ghost-text';
import type { FimDefaultDiagnosticsOptions } from '../../chat-lib/core/behavior-config';
import type {
  CopilotEditHistoryEntry,
  CopilotWorkspaceAdapter,
} from './workspace';
import type { CopilotProposedTextEdit } from './context-provider';
import { getSafeCompletionPath } from '../template/codegemma';

export function selectedCompletionProposedEdits(
  document: vscode.TextDocument,
  position: vscode.Position,
  selectedCompletionInfo:
    { readonly text: string; readonly range: vscode.Range } | undefined,
): readonly CopilotProposedTextEdit[] | undefined {
  if (
    !selectedCompletionInfo?.text ||
    selectedCompletionInfo.text.includes(')')
  ) {
    return undefined;
  }
  const text = document.getText();
  const start = document.offsetAt(selectedCompletionInfo.range.start);
  const end = document.offsetAt(selectedCompletionInfo.range.end);
  const originalOffset = document.offsetAt(position);
  let positionAfterEdit: { readonly line: number; readonly character: number } =
    {
      line: position.line,
      character: position.character,
    };
  if (originalOffset >= start) {
    const base = originalOffset < end ? end : originalOffset;
    const virtualOffset =
      base + selectedCompletionInfo.text.length - (end - start);
    const virtualText =
      text.slice(0, start) + selectedCompletionInfo.text + text.slice(end);
    positionAfterEdit = positionAt(virtualText, virtualOffset);
  }
  return [
    {
      range: {
        start: {
          line: selectedCompletionInfo.range.start.line,
          character: selectedCompletionInfo.range.start.character,
        },
        end: {
          line: selectedCompletionInfo.range.end.line,
          character: selectedCompletionInfo.range.end.character,
        },
      },
      newText: selectedCompletionInfo.text,
      positionAfterEdit,
      source: 'selectedCompletionInfo',
    },
  ];
}

function normalizeLanguageId(languageId: string): string {
  const normalized = languageId.toLowerCase();
  const aliases: Readonly<Record<string, string>> = {
    javascriptreact: 'javascript',
    jsx: 'javascript',
    typescriptreact: 'typescript',
    jade: 'pug',
    cshtml: 'razor',
    c: 'cpp',
  };
  return aliases[normalized] ?? normalized;
}

function safeFimContextPath(
  workspace: Awaited<ReturnType<CopilotWorkspaceAdapter['gatherContext']>>,
  uri: string,
  candidatePath?: string,
): string {
  const document = [workspace.current, ...workspace.recentDocuments].find(
    (candidate) => candidate.uri === uri,
  );
  if (document) {
    return getSafeCompletionPath(document.relativePath) ?? '';
  }
  return getSafeCompletionPath(candidatePath) ?? '';
}

function selectFimSimilarFiles(
  workspace: Awaited<ReturnType<CopilotWorkspaceAdapter['gatherContext']>>,
  excludedUris: ReadonlySet<string>,
  excludedPaths: ReadonlySet<string>,
): GhostTextPromptContext['similarFiles'] {
  if (workspace.current.scheme !== 'file') {
    return [];
  }
  const languageId = normalizeLanguageId(workspace.current.languageId);
  const selected: Array<{ path: string; content: string }> = [];
  const selectedUris = new Set<string>();
  const selectedPaths = new Set<string>();
  let openTabCharacters = 0;
  const openTabs = [...workspace.recentDocuments].sort(
    (left, right) => right.lastViewedAt - left.lastViewedAt,
  );
  for (const document of openTabs) {
    if (openTabCharacters + document.text.length > 200_000) {
      continue;
    }
    if (
      document.scheme !== 'file' ||
      document.uri === workspace.current.uri ||
      excludedUris.has(document.uri) ||
      (document.relativePath !== undefined &&
        excludedPaths.has(document.relativePath)) ||
      normalizeLanguageId(document.languageId) !== languageId
    ) {
      continue;
    }
    const path = safeFimContextPath(workspace, document.uri);
    selected.push({ path, content: document.text });
    selectedUris.add(document.uri);
    selectedPaths.add(path || document.uri);
    openTabCharacters += document.text.length;
    if (selected.length >= 20) {
      break;
    }
  }
  for (const neighbor of workspace.neighborSnippets ?? []) {
    if (neighbor.source !== 'related-provider') {
      continue;
    }
    const matchingDocument = workspace.recentDocuments.find(
      (document) => document.uri === neighbor.uri,
    );
    const path = safeFimContextPath(
      workspace,
      neighbor.uri,
      neighbor.path ?? matchingDocument?.relativePath,
    );
    if (
      selectedUris.has(neighbor.uri) ||
      selectedPaths.has(path || neighbor.uri) ||
      excludedUris.has(neighbor.uri) ||
      (path.length > 0 && excludedPaths.has(path)) ||
      neighbor.uri === workspace.current.uri
    ) {
      continue;
    }
    selected.push({ path, content: neighbor.snippet });
    selectedUris.add(neighbor.uri);
    selectedPaths.add(path || neighbor.uri);
  }
  return selected;
}

function codeSnippetPath(
  workspace: Awaited<ReturnType<CopilotWorkspaceAdapter['gatherContext']>>,
  uri: string,
  path: string | undefined,
): string {
  return safeFimContextPath(workspace, uri, path);
}

function languageContext(
  workspace: Awaited<ReturnType<CopilotWorkspaceAdapter['gatherContext']>>,
): {
  readonly traits: NonNullable<GhostTextPromptContext['traits']>;
  readonly codeSnippets: readonly (GhostTextCodeSnippet & {
    readonly uri: string;
  })[];
} {
  const traits: GhostTextTrait[] = [];
  const codeSnippets: Array<GhostTextCodeSnippet & { readonly uri: string }> =
    [];
  for (const item of workspace.languageContext.items ?? []) {
    if (item.kind === 'trait') {
      traits.push({
        name: item.name,
        value: item.value,
        ...(item.importance === undefined
          ? {}
          : { importance: item.importance }),
        ...(item.contextProviderSource
          ? { contextProviderSource: item.contextProviderSource }
          : {}),
      });
    } else if (item.value.length > 0) {
      codeSnippets.push({
        uri: item.uri,
        path: codeSnippetPath(workspace, item.uri, item.path),
        value: item.value,
        ...(item.importance === undefined
          ? {}
          : { importance: item.importance }),
        ...(item.contextProviderSource
          ? { contextProviderSource: item.contextProviderSource }
          : {}),
      });
    }
  }
  traits.sort(
    (left, right) => (left.importance ?? 0) - (right.importance ?? 0),
  );
  return { traits, codeSnippets };
}

export class FimWorkspaceContextAdapter {
  private readonly recentEdits = new FimRecentEditsTracker();
  private readonly preStartEditKeys = new Set<string>();
  private recentEditsStarted = false;

  constructor(
    private readonly defaultDiagnostics: FimDefaultDiagnosticsOptions | null = null,
  ) {}

  adapt(
    workspace: Awaited<ReturnType<CopilotWorkspaceAdapter['gatherContext']>>,
    now = Date.now(),
    cursorOffset = workspace.current.selection?.active ??
      workspace.current.text.length,
  ): GhostTextPromptContext {
    const providerContext = languageContext(workspace);
    const excludedUris = new Set(
      (workspace.languageContext.items ?? [])
        .filter((item) => item.kind === 'snippet')
        .flatMap((item) => [item.uri, ...(item.additionalUris ?? [])]),
    );
    const excludedPaths = new Set(
      providerContext.codeSnippets.map((item) => item.path),
    );
    const availableUris = new Set([
      workspace.current.uri,
      ...workspace.recentDocuments.map((document) => document.uri),
    ]);
    if (!this.recentEditsStarted) {
      for (const entry of workspace.editHistory) {
        this.preStartEditKeys.add(this.recentEditKey(entry));
      }
      this.recentEditsStarted = true;
    }
    const recentEdits = this.recentEdits.ingest(
      workspace.editHistory
        .filter(
          (entry) =>
            availableUris.has(entry.uri) &&
            !this.preStartEditKeys.has(this.recentEditKey(entry)),
        )
        .map((entry) => ({
          uri: entry.uri,
          path: getSafeCompletionPath(entry.relativePath) ?? '',
          before: entry.before,
          after: entry.after,
          timestamp: entry.timestamp,
        })),
      now,
      availableUris,
    );
    const providerDiagnostics = workspace.languageContext.diagnostics ?? [];
    const providerUris = new Set(
      providerDiagnostics.map((diagnostic) => diagnostic.uri),
    );
    const defaultDiagnostics = this.defaultDiagnostics;
    const cursorLine = positionAt(workspace.current.text, cursorOffset).line;
    const errors = workspace.diagnostics.filter(
      (diagnostic) =>
        diagnostic.severity === 'error' &&
        Math.abs(diagnostic.startLine - cursorLine) <=
          (defaultDiagnostics?.maxLineDistance ?? -1),
    );
    const includeWarnings =
      defaultDiagnostics?.warnings === 'yes' ||
      (defaultDiagnostics?.warnings === 'yesIfNoErrors' && errors.length === 0);
    const selectedDefaults = defaultDiagnostics
      ? [
          ...errors,
          ...(includeWarnings
            ? workspace.diagnostics.filter(
                (diagnostic) =>
                  diagnostic.severity === 'warning' &&
                  Math.abs(diagnostic.startLine - cursorLine) <=
                    defaultDiagnostics.maxLineDistance,
              )
            : []),
        ]
          .filter((diagnostic) => !providerUris.has(diagnostic.uri))
          .sort(
            (left, right) =>
              Math.abs(left.startLine - cursorLine) -
              Math.abs(right.startLine - cursorLine),
          )
          .slice(0, defaultDiagnostics.maxDiagnostics)
      : [];
    const seenDiagnostics = new Set<string>();
    const diagnostics = [...selectedDefaults, ...providerDiagnostics].filter(
      (diagnostic) => {
        const key = [
          diagnostic.contextProviderSource?.providerId ?? '',
          diagnostic.contextProviderSource?.itemId ?? '',
          diagnostic.uri,
          diagnostic.startLine,
          diagnostic.startCharacter,
          diagnostic.endLine,
          diagnostic.endCharacter,
          diagnostic.message,
          diagnostic.severity,
          diagnostic.source ?? '',
          diagnostic.code ?? '',
        ].join('\u0000');
        if (seenDiagnostics.has(key)) return false;
        seenDiagnostics.add(key);
        return true;
      },
    );
    return {
      ignored: workspace.ignored,
      similarFiles: selectFimSimilarFiles(
        workspace,
        excludedUris,
        excludedPaths,
      ),
      recentEdits,
      diagnostics: diagnostics.map((diagnostic) => ({
        path: safeFimContextPath(
          workspace,
          diagnostic.uri,
          diagnostic.path,
        ),
        line: diagnostic.startLine,
        character: diagnostic.startCharacter,
        message: diagnostic.message,
        severity: diagnostic.severity,
        ...(diagnostic.importance === undefined
          ? {}
          : { importance: diagnostic.importance }),
        ...(diagnostic.code ? { code: diagnostic.code } : {}),
        ...(diagnostic.source ? { source: diagnostic.source } : {}),
        ...(diagnostic.contextProviderSource
          ? { contextProviderSource: diagnostic.contextProviderSource }
          : {}),
      })),
      ...(providerContext.traits.length > 0
        ? { traits: providerContext.traits }
        : {}),
      ...(providerContext.codeSnippets.length > 0
        ? {
            codeSnippets: providerContext.codeSnippets.map(
              ({ path, value, importance, contextProviderSource }) => ({
                path,
                value,
                ...(importance === undefined ? {} : { importance }),
                ...(contextProviderSource ? { contextProviderSource } : {}),
              }),
            ),
          }
        : {}),
      ...(workspace.languageContext.contextProviderFeedback
        ? {
            contextProviderFeedback:
              workspace.languageContext.contextProviderFeedback,
          }
        : {}),
    };
  }

  private recentEditKey(entry: CopilotEditHistoryEntry): string {
    return [entry.uri, entry.timestamp, entry.before, entry.after].join(
      '\u0000',
    );
  }
}

const DEFAULT_ENABLED_LANGUAGES: Readonly<Record<string, boolean>> = {
  '*': true,
  plaintext: false,
  markdown: false,
  scminput: false,
};

export function isCopilotLanguageEnabled(
  languageId: string,
  enabledLanguages?: Readonly<Record<string, boolean>>,
): boolean {
  return (
    enabledLanguages?.[languageId] ??
    enabledLanguages?.['*'] ??
    DEFAULT_ENABLED_LANGUAGES[languageId] ??
    DEFAULT_ENABLED_LANGUAGES['*'] ??
    false
  );
}
